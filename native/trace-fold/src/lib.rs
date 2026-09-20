pub mod fold;

#[cfg(feature = "addon")]
mod addon {
    use crate::fold;
    use napi::{
        Env, Task,
        bindgen_prelude::{AsyncTask, Float64Array},
    };
    use napi_derive::napi;
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    type SharedReader = Arc<Mutex<Option<fold::TraceReader>>>;
    fn error(e: std::io::Error) -> napi::Error {
        napi::Error::from_reason(e.to_string())
    }
    fn closed() -> napi::Error {
        napi::Error::from_reason("trace reader is closed or has already been folded")
    }

    #[napi(object)]
    pub struct EventBatch {
        pub lines: Vec<String>,
        pub done: bool,
    }
    #[napi(object)]
    pub struct Method {
        pub start: String,
        pub end: String,
        pub name: String,
    }
    #[napi(object)]
    pub struct Bucket {
        pub pid: String,
        pub methods: Vec<Method>,
    }
    #[napi(object)]
    pub struct Thread {
        pub tid: f64,
        pub pid: String,
    }
    #[napi(object)]
    pub struct Entry {
        pub stack: String,
        pub weight: f64,
    }
    #[napi(object)]
    pub struct FoldResult {
        pub entries: Vec<Entry>,
        pub stacks: u32,
        pub attempted: u32,
        pub resolved: u32,
    }

    pub struct ReadTask {
        reader: SharedReader,
        event: String,
    }
    impl Task for ReadTask {
        type Output = fold::Batch;
        type JsValue = EventBatch;
        fn compute(&mut self) -> napi::Result<Self::Output> {
            self.reader
                .lock()
                .map_err(|_| closed())?
                .as_mut()
                .ok_or_else(closed)?
                .next_events(&self.event)
                .map_err(error)
        }
        fn resolve(&mut self, _: Env, b: Self::Output) -> napi::Result<Self::JsValue> {
            Ok(EventBatch {
                lines: b.lines,
                done: b.done,
            })
        }
    }
    pub struct FoldTask {
        reader: SharedReader,
        options: Option<fold::Options>,
    }
    impl Task for FoldTask {
        type Output = fold::Folded;
        type JsValue = FoldResult;
        fn compute(&mut self) -> napi::Result<Self::Output> {
            let reader = self
                .reader
                .lock()
                .map_err(|_| closed())?
                .take()
                .ok_or_else(closed)?;
            fold::fold(reader, self.options.take().ok_or_else(closed)?).map_err(error)
        }
        fn resolve(&mut self, _: Env, r: Self::Output) -> napi::Result<Self::JsValue> {
            Ok(FoldResult {
                entries: r
                    .entries
                    .into_iter()
                    .map(|(stack, weight)| Entry { stack, weight })
                    .collect(),
                stacks: r.stacks,
                attempted: r.attempted,
                resolved: r.resolved,
            })
        }
    }

    #[napi]
    pub struct TraceReader {
        reader: SharedReader,
    }
    #[napi]
    impl TraceReader {
        #[napi(constructor)]
        pub fn new(path: String) -> napi::Result<Self> {
            Ok(Self {
                reader: Arc::new(Mutex::new(Some(
                    fold::TraceReader::open(path.into()).map_err(error)?,
                ))),
            })
        }
        #[napi]
        pub fn next_events(&self, event: String) -> AsyncTask<ReadTask> {
            AsyncTask::new(ReadTask {
                reader: self.reader.clone(),
                event,
            })
        }
        #[napi]
        pub fn close(&self) -> napi::Result<()> {
            self.reader.lock().map_err(|_| closed())?.take();
            Ok(())
        }
        #[napi]
        pub fn fold(
            &self,
            seeds: Float64Array,
            threads: Vec<Thread>,
            buckets: Vec<Bucket>,
            symbols: bool,
            recursion: bool,
        ) -> napi::Result<AsyncTask<FoldTask>> {
            let (rows, remainder) = seeds.as_chunks::<3>();
            if !remainder.is_empty()
                || rows
                    .iter()
                    .any(|s| !s[0].is_finite() || !s[1].is_finite() || s[2].is_nan())
            {
                return Err(napi::Error::from_reason("Invalid trace seed array"));
            }
            let mut options = fold::Options {
                seeds: rows.iter().map(|s| (s[0], s[1], s[2])).collect(),
                threads: HashMap::new(),
                methods: HashMap::new(),
                symbols,
                recursion,
            };
            for thread in threads {
                options.thread(thread.tid, thread.pid);
            }
            for bucket in buckets {
                let mut methods = Vec::new();
                for m in bucket.methods {
                    let start = fold::bigint(&m.start)
                        .ok_or_else(|| napi::Error::from_reason("Invalid JIT start address"))?;
                    let end = fold::bigint(&m.end)
                        .ok_or_else(|| napi::Error::from_reason("Invalid JIT end address"))?;
                    methods.push(fold::Method {
                        start,
                        end,
                        name: m.name,
                    });
                }
                options.methods.insert(bucket.pid, methods);
            }
            Ok(AsyncTask::new(FoldTask {
                reader: self.reader.clone(),
                options: Some(options),
            }))
        }
    }
}
