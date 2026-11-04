use crate::storage;
use anyhow::{Context, Result, bail};
use chrono::Utc;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap, future::Future, path::PathBuf, pin::Pin, sync::Arc, time::Duration,
};
use tokio::sync::{Mutex, Semaphore};
use tokio_util::sync::CancellationToken;

pub type Executor =
    Box<dyn FnOnce(CancellationToken) -> Pin<Box<dyn Future<Output = Value> + Send>> + Send>;

struct Job {
    record: Mutex<Value>,
    cancel: CancellationToken,
}

pub struct TaskService {
    directory: PathBuf,
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    workers: Arc<Semaphore>,
    capacity: Arc<Semaphore>,
    admission: Mutex<()>,
}

pub fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn terminal(state: &str) -> bool {
    ["done", "failed", "cancelled", "unknown"].contains(&state)
}

pub fn flags(value: &Value) -> Value {
    let payload = value
        .get("content")
        .and_then(Value::as_array)
        .and_then(|blocks| {
            blocks.iter().find_map(|block| {
                if block["type"] == "text" {
                    serde_json::from_str::<Value>(block["text"].as_str()?).ok()
                } else {
                    None
                }
            })
        })
        .unwrap_or_else(|| value.clone());
    json!({"failed": value["isError"] == true || payload["ok"] == false || payload["verdict"] == "fail",
        "unknown": payload["unknown"] == true, "cancelled": payload["cancelled"] == true,
        "incomplete": payload["incomplete"] == true || payload["verdict"] == "incomplete"})
}

impl TaskService {
    pub fn new(directory: PathBuf, concurrency: usize, queued: usize) -> Arc<Self> {
        Arc::new(Self {
            directory,
            jobs: Mutex::new(HashMap::new()),
            workers: Arc::new(Semaphore::new(concurrency)),
            capacity: Arc::new(Semaphore::new(concurrency + queued)),
            admission: Mutex::new(()),
        })
    }

    async fn persist(&self, record: Value) -> Result<()> {
        let path = storage::record_path(
            &self.directory,
            record["jobId"].as_str().context("Missing job id")?,
            ".json",
        )?;
        tokio::task::spawn_blocking(move || storage::write_json(&path, &record)).await??;
        Ok(())
    }

    pub async fn submit(
        self: &Arc<Self>,
        tool: String,
        args: Value,
        side_effects: bool,
        resources: Vec<String>,
        execute: Executor,
    ) -> Result<Value> {
        let timeout_ms = args
            .get("jobTimeoutMs")
            .map(|value| value.as_u64().context("jobTimeoutMs must be an integer"))
            .transpose()?
            .unwrap_or(300000);
        if !(1..=86400000).contains(&timeout_ms) {
            bail!("jobTimeoutMs must be between 1 and 86400000");
        }
        let request_key = args
            .get("requestKey")
            .map(|value| value.as_str().context("requestKey must be a string"))
            .transpose()?;
        if request_key.is_some_and(|key| key.is_empty() || key.len() > 256) {
            bail!("requestKey must contain 1..256 bytes");
        }
        let mut parameters = args.clone();
        if let Some(object) = parameters.as_object_mut() {
            for key in ["asyncJob", "requestKey", "jobTimeoutMs"] {
                object.remove(key);
            }
        }
        let binding = digest(&json!([tool, parameters]).to_string());
        let _admission = self.admission.lock().await;
        let key_path = request_key.map(|key| {
            self.directory.join(format!(
                "request-{}.json",
                digest(&format!("{tool}\0{key}"))
            ))
        });
        let _request_lock = match &key_path {
            Some(path) => Some(
                storage::try_lock(&path.with_extension("lock"))?
                    .context("TASK_BUSY: request key is locked")?,
            ),
            None => None,
        };
        if let Some(path) = &key_path
            && path.exists()
        {
            let saved = storage::read_json(path)?;
            if saved["binding"] != binding {
                bail!("TASK_KEY_CONFLICT: request key is bound to different arguments");
            }
            let mut record = self
                .status(saved["jobId"].as_str().context("Invalid request record")?)
                .await?;
            record["accepted"] = json!(false);
            record["deduplicated"] = json!(true);
            return Ok(record);
        }
        let capacity = self
            .capacity
            .clone()
            .try_acquire_owned()
            .context("TASK_BUSY: task queue is full")?;
        let job_id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let record = json!({"version": 1, "jobId": job_id, "runId": args["runId"].as_str().unwrap_or(""),
            "attemptId": uuid::Uuid::new_v4().to_string(), "tool": tool, "ownerPid": std::process::id(),
            "state": "queued", "queuedAt": now, "observedAt": now, "startedAt": null, "completedAt": null,
            "completeness": "pending", "evidenceRefs": [], "cancelRequested": false});
        self.persist(record.clone()).await?;
        if let Some(path) = key_path {
            storage::write_json(&path, &json!({"jobId": job_id, "binding": binding}))?;
        }
        let job = Arc::new(Job {
            record: Mutex::new(record.clone()),
            cancel: CancellationToken::new(),
        });
        self.jobs.lock().await.insert(job_id.clone(), job.clone());
        let service = self.clone();
        tokio::spawn(async move {
            let result = service
                .run(job.clone(), side_effects, resources, timeout_ms, execute)
                .await;
            if let Err(error) = result {
                let mut record = job.record.lock().await;
                record["state"] = json!("unknown");
                record["completeness"] = json!("incomplete");
                record["error"] = json!(format!("Task persistence failed: {error}"));
                eprintln!("Task {job_id}: persistence failed");
            } else {
                service.jobs.lock().await.remove(&job_id);
            }
            drop(capacity);
        });
        let mut accepted = record;
        accepted["ok"] = json!(true);
        accepted["taskJob"] = json!(true);
        accepted["accepted"] = json!(true);
        Ok(accepted)
    }

    async fn run(
        &self,
        job: Arc<Job>,
        side_effects: bool,
        mut resources: Vec<String>,
        timeout_ms: u64,
        execute: Executor,
    ) -> Result<()> {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        let mut started = false;
        let mut result = None;
        let work = async {
            let _worker = self
                .workers
                .acquire()
                .await
                .context("Task workers closed")?;
            resources.sort();
            resources.dedup();
            let mut guards = Vec::new();
            for resource in &resources {
                let path = self
                    .directory
                    .join(format!("resource-{}.lock", digest(resource)));
                loop {
                    if let Some(guard) = storage::try_lock(&path)? {
                        guards.push(guard);
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
            }
            if job.cancel.is_cancelled() {
                return Ok::<(), anyhow::Error>(());
            }
            {
                let mut record = job.record.lock().await;
                record["state"] = json!("running");
                record["startedAt"] =
                    json!(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
                record["queueMs"] = json!(
                    (Utc::now()
                        - chrono::DateTime::parse_from_rfc3339(
                            record["queuedAt"].as_str().unwrap()
                        )?
                        .with_timezone(&Utc))
                    .num_milliseconds()
                );
                self.persist(record.clone()).await?;
            }
            started = true;
            result = Some(execute(job.cancel.clone()).await);
            Ok(())
        };
        let mut timed_out = false;
        let execution = tokio::select! {
            biased;
            _ = job.cancel.cancelled() => Ok(()),
            _ = tokio::time::sleep_until(deadline) => { timed_out = true; job.cancel.cancel(); Ok(()) },
            outcome = work => outcome,
        };
        let mut record = job.record.lock().await;
        if let Some(result) = result {
            let path = storage::record_path(
                &self.directory,
                record["jobId"].as_str().unwrap(),
                ".result.json",
            )?;
            let persisted_result = result.clone();
            let target = path.clone();
            tokio::task::spawn_blocking(move || storage::write_json(&target, &persisted_result))
                .await??;
            let flags = flags(&result);
            let state = if flags["unknown"] == true
                || (flags["cancelled"] == true && flags["failed"] == true)
            {
                "unknown"
            } else if flags["cancelled"] == true {
                "cancelled"
            } else if flags["failed"] == true {
                "failed"
            } else {
                "done"
            };
            record["state"] = json!(state);
            record["completeness"] = json!(if flags["incomplete"] == true || state == "unknown" {
                "incomplete"
            } else {
                "complete"
            });
            record["result"] = json!({"path": path});
            record["evidenceRefs"] = json!([path]);
        } else {
            record["state"] = json!(if started && side_effects {
                "unknown"
            } else if job.cancel.is_cancelled() {
                "cancelled"
            } else {
                "failed"
            });
            record["completeness"] = json!("incomplete");
        }
        if timed_out {
            record["errorCode"] = json!("TASK_TIMEOUT");
        }
        if let Err(error) = execution {
            record["error"] = json!(error.to_string());
        }
        record["cancelRequested"] = json!(job.cancel.is_cancelled());
        record["completedAt"] =
            json!(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        record["observedAt"] = record["completedAt"].clone();
        self.persist(record.clone()).await
    }

    pub async fn status(&self, id: &str) -> Result<Value> {
        let path = storage::record_path(&self.directory, id, ".json")?;
        let job = self.jobs.lock().await.get(id).cloned();
        let mut record = if let Some(job) = job {
            job.record.lock().await.clone()
        } else {
            let mut record =
                tokio::task::spawn_blocking(move || storage::read_json(&path)).await??;
            if !terminal(record["state"].as_str().unwrap_or("")) {
                record["lastPersistedState"] = record["state"].clone();
                record["state"] = json!("unknown");
                record["completeness"] = json!("incomplete");
                record["recoveryNote"] = json!(
                    "Owned by another or previous service; execution is never replayed automatically."
                );
            }
            record
        };
        record["ok"] = json!(true);
        record["taskJob"] = json!(true);
        if let Some(time) = record["observedAt"]
            .as_str()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        {
            record["ageMs"] = json!(
                (Utc::now() - time.with_timezone(&Utc))
                    .num_milliseconds()
                    .max(0)
            );
        }
        Ok(record)
    }

    pub async fn control(&self, args: &Value) -> Result<Value> {
        let id = args["jobId"].as_str().context("jobId is required")?;
        match args["action"].as_str().unwrap_or("status") {
            "cancel" => {
                let job = self.jobs.lock().await.get(id).cloned();
                if let Some(job) = job {
                    let mut record = job.record.lock().await;
                    if !terminal(record["state"].as_str().unwrap_or("")) {
                        record["cancelRequested"] = json!(true);
                        record["state"] = json!(if record["state"] == "queued" {
                            "cancelled"
                        } else {
                            "cancelling"
                        });
                        record["completeness"] = json!("incomplete");
                        job.cancel.cancel();
                        self.persist(record.clone()).await?;
                    }
                    let mut result = record.clone();
                    result["ok"] = json!(true);
                    result["cancellationApplied"] = json!(true);
                    return Ok(result);
                }
                let mut record = self.status(id).await?;
                record["cancellationApplied"] = json!(false);
                if record.get("recoveryNote").is_some() {
                    record["ok"] = json!(false);
                    record["error"] = json!("Cancellation requires the owning service process");
                }
                Ok(record)
            }
            "result" => {
                let mut record = self.status(id).await?;
                record["resultReady"] = json!(record["result"]["path"].is_string());
                Ok(record)
            }
            "status" => self.status(id).await,
            _ => bail!("Unknown task control action"),
        }
    }

    pub async fn close(&self) {
        let jobs: Vec<_> = self.jobs.lock().await.values().cloned().collect();
        for job in jobs {
            let mut record = job.record.lock().await;
            if terminal(record["state"].as_str().unwrap_or("")) {
                continue;
            }
            job.cancel.cancel();
            record["state"] = json!(if record["state"] == "queued" {
                "cancelled"
            } else {
                "unknown"
            });
            record["cancelRequested"] = json!(true);
            record["completeness"] = json!("incomplete");
            if let Err(error) = self.persist(record.clone()).await {
                eprintln!("Task shutdown persistence failed: {error}");
            }
        }
    }
}
