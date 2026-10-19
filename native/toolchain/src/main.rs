mod bridge;
mod config;
mod http;
mod runtime;
mod storage;
mod tasks;
mod uia;

use anyhow::Result;
use runtime::Runtime;
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::{Mutex, Semaphore, mpsc},
};
use tokio_util::sync::CancellationToken;

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn main() -> Result<()> {
    if std::env::args().any(|argument| argument == "--uia-worker") {
        return uia::worker();
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    if std::env::args().any(|argument| argument == "--uia-server") {
        runtime.block_on(uia::server())
    } else {
        runtime.block_on(serve())
    }
}

async fn serve() -> Result<()> {
    let runtime = Runtime::new(config::Config::load()?)?;
    let adapter = std::env::args().any(|argument| argument == "--adapter");
    let pending = Arc::new(Mutex::new(HashMap::<String, CancellationToken>::new()));
    let slots = Arc::new(Semaphore::new(32));
    let (sender, mut receiver) = mpsc::channel::<Value>(64);
    let writer = tokio::spawn(async move {
        let mut output = tokio::io::stdout();
        while let Some(value) = receiver.recv().await {
            output.write_all(format!("{value}\n").as_bytes()).await?;
            output.flush().await?;
        }
        Ok::<(), std::io::Error>(())
    });
    let mut input = BufReader::new(tokio::io::stdin());
    let mut initialized = false;
    loop {
        let mut line = String::new();
        let size = (&mut input)
            .take(8 * 1024 * 1024 + 1)
            .read_line(&mut line)
            .await?;
        if size == 0 {
            break;
        }
        if size > 8 * 1024 * 1024 {
            sender
                .send(rpc_error(Value::Null, -32600, "Request exceeds 8 MiB"))
                .await?;
            break;
        }
        let request = match serde_json::from_str::<Value>(&line) {
            Ok(value) => value,
            Err(_) => {
                sender
                    .send(rpc_error(Value::Null, -32700, "Parse error"))
                    .await?;
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request["method"].as_str().unwrap_or("");
        if request["jsonrpc"] != "2.0"
            || method.is_empty()
            || !(id.is_null() || id.is_string() || id.is_number())
        {
            sender
                .send(rpc_error(id, -32600, "Invalid Request"))
                .await?;
            continue;
        }
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
        if request.get("id").is_none() {
            if method == "notifications/cancelled"
                && let Some(token) = pending.lock().await.get(&params["requestId"].to_string())
            {
                token.cancel();
            }
            continue;
        }
        if method == "initialize" {
            if initialized {
                sender
                    .send(rpc_error(id, -32600, "Already initialized"))
                    .await?;
                continue;
            }
            initialized = true;
            let requested = params["protocolVersion"].as_str().unwrap_or("");
            let version =
                if ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].contains(&requested) {
                    requested
                } else {
                    "2025-03-26"
                };
            sender.send(json!({"jsonrpc": "2.0", "id": id, "result": {"protocolVersion": version,
                "capabilities": {"tools": {}}, "serverInfo": {"name": "dsh-agent-toolchain", "version": env!("CARGO_PKG_VERSION")}}})).await?;
            continue;
        }
        if !initialized && !adapter {
            sender
                .send(rpc_error(id, -32000, "Initialize the MCP session first"))
                .await?;
            continue;
        }
        if method == "ping" || method == "tools/list" {
            sender.send(json!({"jsonrpc": "2.0", "id": id, "result": if method == "ping" { json!({}) } else { runtime.list() }})).await?;
            continue;
        }
        if method != "tools/call" && !(adapter && method.starts_with("dsh/")) {
            sender
                .send(rpc_error(id, -32601, "Method not found"))
                .await?;
            continue;
        }
        let Ok(permit) = slots.clone().try_acquire_owned() else {
            sender
                .send(rpc_error(id, -32000, "Runtime request queue is full"))
                .await?;
            continue;
        };
        let key = id.to_string();
        let token = CancellationToken::new();
        {
            let mut requests = pending.lock().await;
            if requests.contains_key(&key) {
                sender
                    .send(rpc_error(id, -32600, "Duplicate request id"))
                    .await?;
                continue;
            }
            requests.insert(key.clone(), token.clone());
        }
        let runtime = runtime.clone();
        let pending = pending.clone();
        let sender = sender.clone();
        let method = method.to_string();
        tokio::spawn(async move {
            let response = if method == "tools/call" {
                let result = runtime::CALL_META
                    .scope(
                        params["_meta"].clone(),
                        runtime.call(
                            params["name"].as_str().unwrap_or(""),
                            params
                                .get("arguments")
                                .cloned()
                                .unwrap_or_else(|| json!({})),
                            token,
                        ),
                    )
                    .await;
                json!({"jsonrpc": "2.0", "id": id, "result": result})
            } else {
                match runtime.adapter(&method, params, token).await {
                    Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
                    Err(error) => rpc_error(id, -32000, &error.to_string()),
                }
            };
            pending.lock().await.remove(&key);
            let _ = sender.send(response).await;
            drop(permit);
        });
    }
    for token in pending.lock().await.values() {
        token.cancel();
    }
    runtime.close().await;
    drop(sender);
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), writer).await;
    Ok(())
}
