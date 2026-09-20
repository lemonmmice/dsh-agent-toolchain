pub mod store;

#[cfg(feature = "addon")]
mod addon {
    use crate::store;
    use napi_derive::napi;

    #[napi(object)]
    pub struct Vector {
        pub kind: u32,
        pub dense: napi::bindgen_prelude::Float64Array,
        pub keys: Vec<Vec<u16>>,
        pub values: Vec<f64>,
        pub norm: f64,
    }

    #[napi(object)]
    pub struct Row {
        pub key: Vec<u16>,
        pub json: String,
        pub vector: Vector,
    }

    #[napi(object)]
    pub struct Hit {
        pub json: String,
        pub score: f64,
    }

    #[napi(object)]
    pub struct SearchResult {
        pub hits: Vec<Hit>,
        pub needs_js_sort: bool,
    }

    #[napi(object)]
    pub struct Written {
        pub bytes: f64,
        pub bak: Option<String>,
        pub tmp: String,
    }

    fn error(e: std::io::Error) -> napi::Error {
        napi::Error::from_reason(e.to_string())
    }
    fn vector(v: Vector) -> napi::Result<store::Vector> {
        if v.keys.len() != v.values.len() {
            return Err(napi::Error::from_reason(
                "Sparse keys/values length mismatch",
            ));
        }
        Ok(match v.kind {
            1 => store::Vector::Dense(v.dense.to_vec()),
            2 => store::Vector::sparse(v.keys.into_iter().zip(v.values).collect(), v.norm),
            _ => store::Vector::Other,
        })
    }
    fn row(r: Row) -> napi::Result<store::Row> {
        Ok(store::Row {
            key: r.key,
            json: r.json,
            vector: vector(r.vector)?,
        })
    }

    #[napi]
    pub struct MemoryStore {
        inner: store::Store,
    }

    #[napi]
    impl MemoryStore {
        #[napi(constructor)]
        pub fn new(file: String) -> Self {
            Self {
                inner: store::Store::new(file.into()),
            }
        }
        #[napi]
        pub fn load(&mut self) -> napi::Result<Option<String>> {
            self.inner.load().map_err(error)
        }
        #[napi]
        pub fn hydrate(&mut self, rows: Vec<Row>) -> napi::Result<()> {
            self.inner
                .hydrate(rows.into_iter().map(row).collect::<napi::Result<_>>()?)
                .map_err(error)
        }
        #[napi]
        pub fn upsert(&mut self, value: Row) -> napi::Result<()> {
            self.inner.upsert(row(value)?).map_err(error)
        }
        #[napi]
        pub fn remove_prefix(&mut self, prefix: Vec<u16>, exact: bool) -> napi::Result<u32> {
            self.inner
                .remove_prefix(&prefix, exact)
                .map(|n| n as u32)
                .map_err(error)
        }
        #[napi]
        pub fn replace_prefix(&mut self, prefix: Vec<u16>, rows: Vec<Row>) -> napi::Result<()> {
            self.inner
                .replace_prefix(
                    &prefix,
                    rows.into_iter().map(row).collect::<napi::Result<_>>()?,
                )
                .map_err(error)
        }
        #[napi]
        pub fn count_prefix(&self, prefix: Vec<u16>) -> u32 {
            self.inner.count_prefix(&prefix) as u32
        }
        #[napi]
        pub fn ids(&self) -> Vec<Vec<u16>> {
            self.inner.ids()
        }
        #[napi]
        pub fn rows(&self) -> Vec<String> {
            self.inner.rows()
        }
        #[napi]
        pub fn count(&self) -> u32 {
            self.inner.count() as u32
        }
        #[napi]
        pub fn search(&self, query: Vector, k: u32) -> napi::Result<SearchResult> {
            let result = self.inner.search(&vector(query)?, k as usize);
            Ok(SearchResult {
                needs_js_sort: result.needs_js_sort,
                hits: result
                    .hits
                    .into_iter()
                    .map(|h| Hit {
                        json: h.json,
                        score: h.score,
                    })
                    .collect(),
            })
        }
        #[napi]
        pub fn flush(&mut self) -> napi::Result<Option<Written>> {
            Ok(self.inner.flush().map_err(error)?.map(|r| Written {
                bytes: r.bytes as f64,
                bak: r.bak.map(|p| p.to_string_lossy().into_owned()),
                tmp: r.tmp.to_string_lossy().into_owned(),
            }))
        }
        #[napi]
        pub fn discard(&mut self) {
            self.inner.discard();
        }
    }
}
