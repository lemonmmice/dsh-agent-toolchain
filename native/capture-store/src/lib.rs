pub mod store;

#[cfg(feature = "addon")]
mod addon {
    use crate::store;
    use napi_derive::napi;

    #[napi(object)]
    pub struct IndexRow {
        // UTF-16 preserves JS ID equality and ordering, including lone surrogates.
        pub key: Vec<u16>,
        pub ts: f64,
        pub bytes: f64,
        pub shard: String,
    }

    #[napi(object)]
    pub struct WriteRow {
        pub key: Vec<u16>,
        pub ts: f64,
        pub json: String,
        pub shard: String,
    }

    #[napi(object)]
    pub struct Shard {
        pub file: String,
        pub text: String,
    }

    #[napi(object)]
    pub struct Stats {
        pub count: u32,
        pub retained_bytes: f64,
        pub physical_bytes: f64,
    }

    #[napi(object)]
    pub struct AppendResult {
        pub applied: Vec<bool>,
        pub reload: bool,
        pub duplicates: u32,
    }

    #[napi(object)]
    pub struct TrimPlan {
        pub keys: Vec<Vec<u16>>,
        pub kept_bytes: f64,
        pub dropped: u32,
        pub truncated_by: String,
    }

    fn error(e: std::io::Error) -> napi::Error {
        napi::Error::from_reason(e.to_string())
    }

    fn writes(rows: Vec<WriteRow>) -> Vec<store::WriteRow> {
        rows.into_iter()
            .map(|r| store::WriteRow {
                key: r.key,
                ts: r.ts,
                json: r.json,
                shard: r.shard,
            })
            .collect()
    }

    #[napi]
    pub struct CaptureStore {
        inner: store::Store,
    }

    #[napi]
    impl CaptureStore {
        #[napi(constructor)]
        pub fn new(directory: String) -> Self {
            Self {
                inner: store::Store::new(directory.into()),
            }
        }

        #[napi]
        pub fn is_fresh(&self) -> napi::Result<bool> {
            self.inner.is_fresh().map_err(error)
        }

        #[napi]
        pub fn load(&mut self) -> napi::Result<Vec<Shard>> {
            Ok(self
                .inner
                .load()
                .map_err(error)?
                .into_iter()
                .map(|(file, text)| Shard { file, text })
                .collect())
        }

        #[napi]
        pub fn index(&mut self, rows: Vec<IndexRow>) -> napi::Result<()> {
            let rows = rows
                .into_iter()
                .map(|r| store::IndexRow {
                    key: r.key,
                    ts: r.ts,
                    bytes: r.bytes as u64,
                    shard: r.shard,
                })
                .collect();
            self.inner.index(rows).map_err(error)
        }

        #[napi]
        pub fn append(&mut self, rows: Vec<WriteRow>) -> napi::Result<AppendResult> {
            let result = self.inner.append(writes(rows)).map_err(error)?;
            Ok(AppendResult {
                applied: result.applied,
                reload: result.reload,
                duplicates: result.duplicates,
            })
        }

        #[napi]
        pub fn replace(&mut self, rows: Vec<WriteRow>) -> napi::Result<()> {
            self.inner.replace(writes(rows)).map_err(error)
        }

        #[napi]
        pub fn stats(&self) -> Stats {
            let (count, retained, physical) = self.inner.stats();
            Stats {
                count: count as u32,
                retained_bytes: retained as f64,
                physical_bytes: physical as f64,
            }
        }

        #[napi]
        pub fn plan(&self, max_records: u32, max_bytes: f64) -> Option<TrimPlan> {
            self.inner
                .plan(max_records as usize, max_bytes)
                .map(|p| TrimPlan {
                    keys: p.keys,
                    kept_bytes: p.kept_bytes as f64,
                    dropped: p.dropped as u32,
                    truncated_by: p.reason.to_owned(),
                })
        }
    }
}
