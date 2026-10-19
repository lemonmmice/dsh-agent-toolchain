use crate::config::Config;
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, oneshot},
};
use tokio_util::sync::CancellationToken;

type Replies = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

pub struct Bridge {
    input: Arc<Mutex<ChildStdin>>,
    child: Mutex<Child>,
    replies: Replies,
    sequence: AtomicU64,
}

struct PendingRequest {
    id: u64,
    input: Arc<Mutex<ChildStdin>>,
    replies: Replies,
    completed: bool,
}

impl Drop for PendingRequest {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        let input = self.input.clone();
        let replies = self.replies.clone();
        let id = self.id;
        tokio::spawn(async move {
            replies.lock().await.remove(&id);
            let message = json!({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": id, "reason": "Caller cancelled"}});
            if let Err(error) = input
                .lock()
                .await
                .write_all(format!("{message}\n").as_bytes())
                .await
            {
                eprintln!("Legacy cancellation transport failed: {error}");
            }
        });
    }
}

impl Bridge {
    pub async fn start(config: &Config) -> Result<Arc<Self>> {
        let path = config
            .legacy
            .as_ref()
            .context("This operation needs --legacy-server; no Node service was started")?;
        let mut command = Command::new(config.get("DSH_NODE_EXE").unwrap_or("node"));
        command
            .arg(path)
            .envs(&config.values)
            .env("DSH_RUNTIME_BRIDGE", "1")
            .env("DSH_RUNTIME_BACKEND", "js")
            .env("DSH_HTTP_BACKEND", "rust")
            .env("DSH_TASK_BACKEND", "js")
            .env("DSH_UI_BACKEND", "rust")
            .env("DSH_EVIDENCE_BACKEND", "rust")
            .env("DSH_RUNTIME_EXE", std::env::current_exe()?)
            .env("DSH_ENV_FILE", "none")
            .env("DSH_TOOL_PROFILE", "")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .context("Cannot start the configured legacy MCP server")?;
        let input = child.stdin.take().context("Missing bridge stdin")?;
        let output = child.stdout.take().context("Missing bridge stdout")?;
        let replies: Replies = Arc::new(Mutex::new(HashMap::new()));
        let pending = replies.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(output).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Ok(value) = serde_json::from_str::<Value>(&line)
                    && let Some(id) = value["id"].as_u64()
                    && let Some(sender) = pending.lock().await.remove(&id)
                {
                    let result = if value.get("error").is_some() {
                        Err("Legacy MCP request failed".to_string())
                    } else {
                        Ok(value["result"].clone())
                    };
                    let _ = sender.send(result);
                }
            }
            for (_, sender) in pending.lock().await.drain() {
                let _ = sender.send(Err(
                    "Legacy MCP process disconnected; execution may have occurred".to_string(),
                ));
            }
        });
        let bridge = Arc::new(Self {
            input: Arc::new(Mutex::new(input)),
            child: Mutex::new(child),
            replies,
            sequence: AtomicU64::new(1),
        });
        let cancel = CancellationToken::new();
        tokio::time::timeout(std::time::Duration::from_secs(15), bridge.request("initialize", json!({
            "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "dsh-rust-bridge", "version": "0.2.0"}
        }), &cancel)).await.context("Legacy MCP initialization timed out")??;
        bridge
            .write(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
            .await?;
        Ok(bridge)
    }

    async fn write(&self, value: Value) -> Result<()> {
        let mut input = self.input.lock().await;
        input.write_all(format!("{value}\n").as_bytes()).await?;
        input.flush().await?;
        Ok(())
    }

    pub async fn request(
        &self,
        method: &str,
        params: Value,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        if cancel.is_cancelled() {
            bail!("Request cancelled before dispatch");
        }
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.replies.lock().await.insert(id, sender);
        let mut pending = PendingRequest {
            id,
            input: self.input.clone(),
            replies: self.replies.clone(),
            completed: false,
        };
        let result = async {
            self.write(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})).await?;
            tokio::select! {
                reply = receiver => reply.context("Legacy response channel closed")?.map_err(anyhow::Error::msg),
                _ = cancel.cancelled() => {
                    self.write(json!({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": id, "reason": "Caller cancelled"}})).await?;
                    bail!("Legacy request cancelled; completion is unknown")
                }
            }
        }.await;
        self.replies.lock().await.remove(&id);
        pending.completed = true;
        result
    }

    pub async fn close(&self) {
        let mut child = self.child.lock().await;
        if let Err(error) = child.kill().await {
            eprintln!("Legacy process shutdown: {error}");
        }
    }
}
