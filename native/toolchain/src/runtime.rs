use crate::{bridge::Bridge, config::Config, http, storage, tasks::TaskService, uia};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

const NATIVE_TOOLS: &[&str] = &[
    "http_request",
    "toolchain_job",
    "toolchain_status",
    "ui_observe",
];

tokio::task_local! {
    pub static CALL_META: Value;
}

pub struct Runtime {
    pub config: Config,
    pub tasks: Arc<TaskService>,
    client: reqwest::Client,
    bridge: Mutex<Option<Arc<Bridge>>>,
    tools: Vec<Value>,
    validators: HashMap<String, jsonschema::Validator>,
}

pub fn content(value: Value) -> Value {
    let failed = value["ok"] == false || value["verdict"] == "fail";
    json!({"content": [{"type": "text", "text": value.to_string()}], "isError": failed})
}

pub fn failure(error: impl std::fmt::Display) -> Value {
    let message = error.to_string();
    let mut value = json!({"ok": false, "error": message});
    for code in ["TASK_BUSY", "TASK_KEY_CONFLICT"] {
        if message.starts_with(code) {
            value["errorCode"] = json!(code);
            value["writesApplied"] = json!(false);
            if code == "TASK_BUSY" {
                value["retryable"] = json!(true);
                value["retryAfterMs"] = json!(25);
            }
        }
    }
    content(value)
}

impl Runtime {
    pub fn new(config: Config) -> Result<Arc<Self>> {
        let mut tools: Vec<Value> = serde_json::from_str(include_str!("../tools.json"))?;
        let profile = config.get("DSH_TOOL_PROFILE").unwrap_or("").to_lowercase();
        tools.retain(|tool| {
            let name = tool["name"].as_str().unwrap_or("");
            let group = name.split('_').next().unwrap_or("");
            let selected = profile.trim().is_empty()
                || ![
                    "ui", "build", "perf", "hang", "memory", "capture", "failure",
                ]
                .contains(&group)
                || profile
                    .split(|character: char| character == ',' || character.is_whitespace())
                    .any(|entry| entry == group);
            selected && (config.legacy.is_some() || NATIVE_TOOLS.contains(&name))
        });
        for tool in &mut tools {
            if tool["name"] == "http_request" {
                let properties = tool["inputSchema"]["properties"]
                    .as_object_mut()
                    .context("Invalid HTTP tool schema")?;
                properties.insert("asyncJob".to_string(), json!({"type": "boolean", "description": "Persist a background Rust task; poll toolchain_job."}));
                properties.insert(
                    "requestKey".to_string(),
                    json!({"type": "string", "minLength": 1, "maxLength": 256}),
                );
                properties.insert(
                    "jobTimeoutMs".to_string(),
                    json!({"type": "integer", "minimum": 1, "maximum": 86400000}),
                );
            }
            if config.legacy.is_none() && tool["name"] == "ui_observe" {
                tool["description"] = json!(
                    "Read Windows UIA through an isolated Rust worker. Native mode supports state, state-live, read and find with exact name/AutomationId selectors. Screenshots, injected WPF trees and advanced selectors require the legacy bridge."
                );
                tool["inputSchema"]["properties"]["action"]["enum"] =
                    json!(["state", "state-live", "read", "find"]);
            }
            if config.legacy.is_none() && tool["name"] == "toolchain_status" {
                tool["description"] = json!(
                    "Inspect the independent Rust runtime, native tools and bridge configuration. Desktop/dump/ETW readiness is unverified without the legacy diagnostics bridge."
                );
            }
        }
        let mut validators = HashMap::new();
        for tool in &tools {
            validators.insert(
                tool["name"]
                    .as_str()
                    .context("Tool name is missing")?
                    .to_string(),
                jsonschema::validator_for(&tool["inputSchema"])?,
            );
        }
        let tasks = TaskService::new(
            config.directory("DSH_TASK_DIR", "tasks").join("rust-v1"),
            2,
            32,
        );
        Ok(Arc::new(Self {
            config,
            tasks,
            client: http::client()?,
            bridge: Mutex::new(None),
            tools,
            validators,
        }))
    }

    pub fn list(&self) -> Value {
        json!({"tools": self.tools})
    }

    fn arguments(&self, name: &str, mut args: Value) -> Result<Value> {
        let validator = self
            .validators
            .get(name)
            .context("Unknown or disabled tool")?;
        if !validator.is_valid(&args) {
            bail!("Tool arguments do not match inputSchema");
        }
        let tool = self
            .tools
            .iter()
            .find(|tool| tool["name"] == name)
            .context("Missing tool")?;
        if let (Some(object), Some(properties)) = (
            args.as_object_mut(),
            tool["inputSchema"]["properties"].as_object(),
        ) {
            for (key, schema) in properties {
                if !object.contains_key(key)
                    && let Some(value) = schema.get("default")
                {
                    object.insert(key.clone(), value.clone());
                }
            }
        }
        Ok(args)
    }

    async fn legacy(&self, name: &str, args: Value, cancel: &CancellationToken) -> Value {
        let bridge = {
            let mut instance = self.bridge.lock().await;
            if instance.is_none() {
                match Bridge::start(&self.config).await {
                    Ok(bridge) => *instance = Some(bridge),
                    Err(error) => return failure(error),
                }
            }
            instance.as_ref().unwrap().clone()
        };
        let mut parameters = json!({"name": name, "arguments": args});
        if let Ok(metadata) = CALL_META.try_with(Clone::clone)
            && metadata.is_object()
        {
            parameters["_meta"] = metadata;
        }
        match bridge.request("tools/call", parameters, cancel).await {
            Ok(value) => value,
            Err(error) => content(
                json!({"ok": false, "unknown": true, "incomplete": true, "error": error.to_string()}),
            ),
        }
    }

    pub async fn execute(&self, name: &str, mut args: Value, cancel: CancellationToken) -> Value {
        match name {
            "http_request" if self.config.legacy.is_some() => {
                self.legacy(name, args, &cancel).await
            }
            "http_request" => content(http::send(&self.client, &args, &cancel).await),
            "toolchain_job" => match self.tasks.control(&args).await {
                Ok(value) => content(value),
                Err(error) => failure(error),
            },
            "toolchain_status" if self.config.legacy.is_none() => content(
                json!({"ok": true, "runtime": "rust", "version": env!("CARGO_PKG_VERSION"),
                "observedAt": chrono::Utc::now().to_rfc3339(), "nativeTools": NATIVE_TOOLS, "legacyConfigured": false,
                "readyFor": {"http": {"ok": true}, "tasks": {"ok": true}, "desktopDiagnostics": {"ok": null, "note": "Not checked; requires the legacy diagnostics bridge"}}}),
            ),
            "ui_observe" => {
                if self.config.legacy.is_some() {
                    return self.legacy(name, args, &cancel).await;
                }
                let mode = args["action"].as_str().unwrap_or("state").to_string();
                let supported = ["state", "state-live", "read", "find"].contains(&mode.as_str())
                    && ["match", "inAid", "inName", "waitFor"].iter().all(|key| {
                        args.get(key)
                            .is_none_or(|value| value.is_null() || value == "")
                    });
                if !supported {
                    return self.legacy(name, args, &cancel).await;
                }
                args["action"] = json!(mode);
                if args["procId"].as_u64().is_none_or(|pid| pid == 0) {
                    args["procName"] = json!(self.config.get("DSH_UI_PROC_NAME").unwrap_or(""));
                }
                if args["winTitle"].as_str().is_none_or(str::is_empty) {
                    args["winTitle"] = json!(self.config.get("DSH_UI_WINDOW_NAME").unwrap_or(""));
                }
                match uia::isolated(&args, &cancel).await {
                    Ok(value) => content(value),
                    Err(error) => failure(error),
                }
            }
            _ => self.legacy(name, args, &cancel).await,
        }
    }

    pub async fn call(
        self: &Arc<Self>,
        name: &str,
        args: Value,
        cancel: CancellationToken,
    ) -> Value {
        let mut args = match self.arguments(name, args) {
            Ok(args) => args,
            Err(error) => return failure(error),
        };
        if args["asyncJob"] == true {
            if name == "build_run" && args["background"] == true {
                return failure("asyncJob and build background cannot be combined");
            }
            let resources = if name.starts_with("ui_") {
                vec!["ui-desktop".to_string()]
            } else if ["perf_trace", "perf_uifreeze"].contains(&name) {
                vec!["etw-kernel".to_string()]
            } else if name == "build_run" {
                vec!["build".to_string()]
            } else if name == "memory_index" {
                vec!["memory-index".to_string()]
            } else {
                Vec::new()
            };
            let side_effects = ![
                "ui_tree",
                "ui_observe",
                "perf_analyze",
                "perf_heap",
                "perf_gcroot",
                "perf_hotstacks",
                "perf_flame",
                "perf_allocflame",
                "perf_clrevents",
                "hang_analyze",
            ]
            .contains(&name);
            let submitted = args.clone();
            if let Some(object) = args.as_object_mut() {
                for key in ["asyncJob", "requestKey", "jobTimeoutMs"] {
                    object.remove(key);
                }
            }
            let runtime = self.clone();
            let tool = name.to_string();
            let metadata = CALL_META.try_with(Clone::clone).unwrap_or(Value::Null);
            let execute = Box::new(
                move |token| -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send>> {
                    Box::pin(async move {
                        CALL_META
                            .scope(metadata, runtime.execute(&tool, args, token))
                            .await
                    })
                },
            );
            return match self
                .tasks
                .submit(
                    name.to_string(),
                    submitted,
                    side_effects,
                    resources,
                    execute,
                )
                .await
            {
                Ok(value) => content(value),
                Err(error) => failure(error),
            };
        }
        self.execute(name, args, cancel).await
    }

    pub async fn adapter(
        self: &Arc<Self>,
        method: &str,
        args: Value,
        cancel: CancellationToken,
    ) -> Result<Value> {
        match method {
            "dsh/http" => Ok(http::send(&self.client, &args, &cancel).await),
            "dsh/evidence" => {
                let path =
                    PathBuf::from(args["path"].as_str().context("Evidence path is required")?);
                if !path.is_absolute() {
                    bail!("Evidence path must be absolute");
                }
                let value = args
                    .get("value")
                    .context("Evidence value is required")?
                    .clone();
                tokio::task::spawn_blocking(move || {
                    let _guard = storage::try_lock(&path.with_extension("rust.lock"))?
                        .context("Evidence is being written by another Rust process")?;
                    storage::write_json(&path, &value)
                })
                .await??;
                Ok(json!({"ok": true}))
            }
            "dsh/task" => {
                let name = args["name"]
                    .as_str()
                    .context("Task tool name is required")?;
                let mut arguments = args["arguments"].clone();
                arguments["asyncJob"] = json!(true);
                Ok(self.call(name, arguments, cancel).await)
            }
            "dsh/task-control" => self.tasks.control(&args).await,
            _ => bail!("Unknown adapter method"),
        }
    }

    pub async fn close(&self) {
        self.tasks.close().await;
        if let Some(bridge) = self.bridge.lock().await.as_ref() {
            bridge.close().await;
        }
    }
}
