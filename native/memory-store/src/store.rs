use fs2::FileExt;
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BinaryHeap, HashMap},
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant, SystemTime},
};

pub enum Vector {
    Dense(Vec<f64>),
    Sparse {
        terms: Vec<(Vec<u16>, f64)>,
        lookup: HashMap<Vec<u16>, f64>,
        norm: f64,
    },
    Other,
}

impl Vector {
    pub fn sparse(terms: Vec<(Vec<u16>, f64)>, norm: f64) -> Self {
        let lookup = terms.iter().cloned().collect();
        Self::Sparse {
            terms,
            lookup,
            norm,
        }
    }

    pub fn similarity(&self, other: &Self) -> f64 {
        match (self, other) {
            (Self::Dense(a), Self::Dense(b)) => {
                // Keep JS's query-length arithmetic, including NaN for a short
                // stored vector; the adapter preserves JS sorting in that case.
                let (mut dot, mut na, mut nb) = (0.0, 0.0, 0.0);
                for (i, av) in a.iter().enumerate() {
                    let bv = b.get(i).copied().unwrap_or(f64::NAN);
                    dot += av * bv;
                    na += av * av;
                    nb += bv * bv;
                }
                let d = na.sqrt() * nb.sqrt();
                if d == 0.0 { 0.0 } else { dot / d }
            }
            (
                Self::Sparse {
                    terms, norm: an, ..
                },
                Self::Sparse {
                    lookup, norm: bn, ..
                },
            ) => {
                let mut dot = 0.0;
                for (key, value) in terms {
                    if let Some(w) = lookup.get(key)
                        && *w != 0.0
                        && !w.is_nan()
                    {
                        dot += value * w;
                    }
                }
                dot / (an * bn)
            }
            _ => 0.0,
        }
    }
}

pub struct Row {
    pub key: Vec<u16>,
    pub json: String,
    pub vector: Vector,
}
pub struct Hit {
    pub json: String,
    pub score: f64,
}
pub struct SearchResult {
    pub hits: Vec<Hit>,
    pub needs_js_sort: bool,
}
#[derive(Debug)]
pub struct Written {
    pub bytes: u64,
    pub bak: Option<PathBuf>,
    pub tmp: PathBuf,
}

#[derive(Clone, PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: SystemTime,
    created: Option<SystemTime>,
}

fn stamp(path: &Path) -> io::Result<Option<Stamp>> {
    match fs::metadata(path) {
        Ok(m) if m.is_file() => Ok(Some(Stamp {
            len: m.len(),
            modified: m.modified()?,
            created: m.created().ok(),
        })),
        Ok(_) => Err(io::Error::other("memory index is not a regular file")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}
fn changed() -> io::Error {
    io::Error::other(
        "MEMORY_STORE_CHANGED: index changed externally; pending changes were not published",
    )
}

pub struct Store {
    file: PathBuf,
    stamp: Option<Option<Stamp>>,
    loaded: bool,
    dirty: bool,
    rows: Vec<Option<Row>>,
    index: BTreeMap<Vec<u16>, Vec<usize>>,
    count: usize,
}

// BinaryHeap holds the WORST selected hit at its root. Equal scores keep the
// earlier row, matching stable JS Array.sort, with only O(k) ranking memory.
#[derive(Clone, Copy)]
struct Rank {
    score: f64,
    index: usize,
}
impl PartialEq for Rank {
    fn eq(&self, other: &Self) -> bool {
        self.score == other.score && self.index == other.index
    }
}
impl Eq for Rank {}
impl PartialOrd for Rank {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Rank {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .score
            .partial_cmp(&self.score)
            .unwrap_or(Ordering::Equal)
            .then(self.index.cmp(&other.index))
    }
}

impl Store {
    pub fn new(file: PathBuf) -> Self {
        Self {
            file,
            stamp: None,
            loaded: false,
            dirty: false,
            rows: Vec::new(),
            index: BTreeMap::new(),
            count: 0,
        }
    }

    fn lock(&self, write: bool) -> io::Result<Option<File>> {
        let path = suffixed(&self.file, ".lock");
        if write && let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = match OpenOptions::new()
            .read(true)
            .write(write)
            .create(write)
            .truncate(false)
            .open(path)
        {
            Ok(file) => file,
            Err(e) if !write && e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let begin = Instant::now();
        loop {
            match if write {
                FileExt::try_lock_exclusive(&file)
            } else {
                FileExt::try_lock_shared(&file)
            } {
                Ok(()) => return Ok(Some(file)),
                Err(e)
                    if e.raw_os_error() == fs2::lock_contended_error().raw_os_error()
                        && begin.elapsed() < Duration::from_secs(2) =>
                {
                    thread::sleep(Duration::from_millis(10))
                }
                Err(e) => return Err(e),
            }
        }
    }

    pub fn load(&mut self) -> io::Result<Option<String>> {
        let _lock = self.lock(false)?;
        let current = stamp(&self.file)?;
        if self.loaded && self.stamp.as_ref() == Some(&current) {
            return Ok(None);
        }
        if self.dirty {
            return Err(changed());
        }
        let text = if current.is_some() {
            String::from_utf8_lossy(&fs::read(&self.file)?).into_owned()
        } else {
            String::new()
        };
        if stamp(&self.file)? != current {
            return Err(changed());
        }
        self.loaded = false;
        self.stamp = Some(current);
        Ok(Some(text))
    }

    pub fn hydrate(&mut self, rows: Vec<Row>) -> io::Result<()> {
        let _lock = self.lock(false)?;
        if self.dirty || self.stamp.as_ref() != Some(&stamp(&self.file)?) {
            return Err(changed());
        }
        self.rows = rows.into_iter().map(Some).collect();
        self.reindex();
        self.loaded = true;
        Ok(())
    }

    fn reindex(&mut self) {
        self.index.clear();
        self.count = 0;
        for (i, row) in self.rows.iter().enumerate() {
            if let Some(row) = row {
                self.index.entry(row.key.clone()).or_default().push(i);
                self.count += 1;
            }
        }
    }

    fn writable(&self) -> io::Result<()> {
        if self.loaded {
            Ok(())
        } else {
            Err(io::Error::other(
                "memory index must be loaded before mutation",
            ))
        }
    }

    pub fn upsert(&mut self, row: Row) -> io::Result<()> {
        self.writable()?;
        if let Some(indices) = self.index.get(&row.key) {
            self.rows[indices[0]] = Some(row);
        } else {
            self.index.insert(row.key.clone(), vec![self.rows.len()]);
            self.rows.push(Some(row));
            self.count += 1;
        }
        self.dirty = true;
        Ok(())
    }

    pub fn remove_prefix(&mut self, prefix: &[u16], exact: bool) -> io::Result<usize> {
        self.writable()?;
        let keys: Vec<_> = self
            .index
            .range(prefix.to_vec()..)
            .take_while(|(key, _)| key.starts_with(prefix))
            .filter(|(key, _)| !exact || key.as_slice() == prefix)
            .map(|(key, _)| key.clone())
            .collect();
        let mut removed = 0;
        for key in keys {
            for at in self.index.remove(&key).unwrap_or_default() {
                self.rows[at] = None;
                removed += 1;
            }
        }
        self.count -= removed;
        self.dirty |= removed > 0;
        Ok(removed)
    }

    pub fn replace_prefix(&mut self, prefix: &[u16], rows: Vec<Row>) -> io::Result<()> {
        self.writable()?;
        if rows.iter().any(|row| !row.key.starts_with(prefix)) {
            return Err(io::Error::other("replacement row must belong to prefix"));
        }
        self.remove_prefix(prefix, false)?;
        for row in rows {
            self.upsert(row)?;
        }
        Ok(())
    }

    pub fn count_prefix(&self, prefix: &[u16]) -> usize {
        self.index
            .range(prefix.to_vec()..)
            .take_while(|(key, _)| key.starts_with(prefix))
            .map(|(_, indices)| indices.len())
            .sum()
    }
    pub fn count(&self) -> usize {
        self.count
    }
    pub fn ids(&self) -> Vec<Vec<u16>> {
        self.rows
            .iter()
            .flatten()
            .map(|row| row.key.clone())
            .collect()
    }
    pub fn rows(&self) -> Vec<String> {
        self.rows
            .iter()
            .flatten()
            .map(|row| row.json.clone())
            .collect()
    }

    pub fn search(&self, query: &Vector, k: usize) -> SearchResult {
        if k == 0 {
            return SearchResult {
                hits: Vec::new(),
                needs_js_sort: false,
            };
        }
        let mut heap = BinaryHeap::<Rank>::with_capacity(k.min(self.count));
        let mut needs_js_sort = false;
        for (i, row) in self.rows.iter().enumerate() {
            let Some(row) = row else { continue };
            let score = query.similarity(&row.vector);
            if score.is_nan() {
                needs_js_sort = true;
                break;
            }
            let rank = Rank { score, index: i };
            if heap.len() < k {
                heap.push(rank);
            } else if heap.peek().is_some_and(|worst| rank < *worst) {
                heap.pop();
                heap.push(rank);
            }
        }
        if needs_js_sort {
            return SearchResult {
                needs_js_sort,
                hits: self
                    .rows
                    .iter()
                    .flatten()
                    .map(|r| Hit {
                        json: r.json.clone(),
                        score: query.similarity(&r.vector),
                    })
                    .collect(),
            };
        }
        let mut ranked = heap.into_vec();
        ranked.sort();
        SearchResult {
            needs_js_sort,
            hits: ranked
                .into_iter()
                .map(|r| Hit {
                    json: self.rows[r.index]
                        .as_ref()
                        .expect("rank points to a live row")
                        .json
                        .clone(),
                    score: r.score,
                })
                .collect(),
        }
    }

    pub fn flush(&mut self) -> io::Result<Option<Written>> {
        if !self.dirty {
            return Ok(None);
        }
        let _lock = self.lock(true)?;
        if self.stamp.as_ref() != Some(&stamp(&self.file)?) {
            return Err(changed());
        }
        let tmp = suffixed(&self.file, &format!(".tmp-{}", std::process::id()));
        let bak = self
            .stamp
            .as_ref()
            .is_some_and(Option::is_some)
            .then(|| suffixed(&self.file, ".bak"));
        let bak_tmp = suffixed(&tmp, ".bak");
        let mut created_tmp = false;
        let mut created_bak_tmp = false;
        let mut bytes = 0;
        let result = (|| {
            let mut file = File::create(&tmp)?;
            created_tmp = true;
            let mut out = io::BufWriter::new(&mut file);
            for row in self.rows.iter().flatten() {
                out.write_all(row.json.as_bytes())?;
                out.write_all(b"\n")?;
                bytes += row.json.len() as u64 + 1;
            }
            if self.count == 0 {
                out.write_all(b"\n")?;
                bytes = 1;
            }
            out.flush()?;
            drop(out);
            file.sync_all()?;
            drop(file);
            if let Some(bak) = &bak {
                fs::copy(&self.file, &bak_tmp)?;
                created_bak_tmp = true;
                OpenOptions::new().write(true).open(&bak_tmp)?.sync_all()?;
                fs::rename(&bak_tmp, bak)?;
            }
            fs::rename(&tmp, &self.file)?;
            self.stamp = Some(stamp(&self.file)?);
            self.dirty = false;
            // Compact tombstones only after successful persistence.
            self.rows.retain(Option::is_some);
            self.reindex();
            Ok(Some(Written {
                bytes,
                bak,
                tmp: tmp.clone(),
            }))
        })();
        if created_tmp && tmp.exists() {
            let _ = fs::remove_file(tmp);
        }
        if created_bak_tmp && bak_tmp.exists() {
            let _ = fs::remove_file(bak_tmp);
        }
        result
    }

    pub fn discard(&mut self) {
        self.rows.clear();
        self.index.clear();
        self.count = 0;
        self.loaded = false;
        self.dirty = false;
        self.stamp = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(id: &str, vector: Vec<f64>) -> Row {
        Row {
            key: id.encode_utf16().collect(),
            json: format!("{{\"id\":\"{id}\"}}"),
            vector: Vector::Dense(vector),
        }
    }
    fn loaded(file: PathBuf) -> Store {
        let mut s = Store::new(file);
        s.load().unwrap();
        s.hydrate(Vec::new()).unwrap();
        s
    }
    #[test]
    fn top_k_is_stable_and_descending() {
        let temp = tempfile::tempdir().unwrap();
        let mut s = loaded(temp.path().join("store.jsonl"));
        for (id, v) in [
            ("opposite", vec![-1., 0.]),
            ("first", vec![1., 0.]),
            ("second", vec![1., 0.]),
            ("zero", vec![0., 0.]),
        ] {
            s.upsert(row(id, v)).unwrap();
        }
        let result = s.search(&Vector::Dense(vec![1., 0.]), 2);
        assert_eq!(
            result
                .hits
                .iter()
                .map(|h| h.json.as_str())
                .collect::<Vec<_>>(),
            vec!["{\"id\":\"first\"}", "{\"id\":\"second\"}"]
        );
        assert!(!result.needs_js_sort);
        assert_eq!(s.search(&Vector::Dense(vec![1., 0., 1.]), 2).hits.len(), 4);
        assert!(s.search(&Vector::Dense(vec![1., 0., 1.]), 2).needs_js_sort);
    }
    #[test]
    fn sparse_uses_utf16_terms() {
        let key = vec![0xd800, 0x61];
        let a = Vector::sparse(vec![(key.clone(), 2.)], 2.);
        let b = Vector::sparse(vec![(key, 3.)], 3.);
        assert_eq!(a.similarity(&b), 1.);
    }
    #[test]
    fn prefix_replacement_and_failed_validation_preserve_rows() {
        let temp = tempfile::tempdir().unwrap();
        let mut s = loaded(temp.path().join("store.jsonl"));
        s.upsert(row("file:a:old", vec![1.])).unwrap();
        s.upsert(row("file:b:old", vec![1.])).unwrap();
        let prefix: Vec<_> = "file:a:".encode_utf16().collect();
        assert!(
            s.replace_prefix(&prefix, vec![row("outside", vec![1.])])
                .is_err()
        );
        assert_eq!(s.count_prefix(&prefix), 1);
        s.replace_prefix(&prefix, vec![row("file:a:new", vec![1.])])
            .unwrap();
        assert_eq!(s.count(), 2);
        assert_eq!(s.count_prefix(&prefix), 1);
    }
    #[test]
    fn backup_is_previous_generation_and_failed_stage_keeps_main() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("store.jsonl");
        let mut s = loaded(file.clone());
        s.upsert(row("first", vec![1.])).unwrap();
        s.flush().unwrap();
        let first = fs::read(&file).unwrap();
        s.upsert(row("second", vec![1.])).unwrap();
        s.flush().unwrap();
        assert_eq!(fs::read(suffixed(&file, ".bak")).unwrap(), first);
        let before = fs::read(&file).unwrap();
        fs::create_dir(suffixed(&file, &format!(".tmp-{}", std::process::id()))).unwrap();
        s.upsert(row("third", vec![1.])).unwrap();
        assert!(s.flush().is_err());
        assert_eq!(fs::read(file).unwrap(), before);
    }
    #[test]
    fn stale_writer_cannot_replace_new_disk_state() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("store.jsonl");
        let mut a = loaded(file.clone());
        let mut b = loaded(file.clone());
        a.upsert(row("a", vec![1.])).unwrap();
        b.upsert(row("b", vec![1.])).unwrap();
        a.flush().unwrap();
        assert!(
            b.flush()
                .unwrap_err()
                .to_string()
                .contains("MEMORY_STORE_CHANGED")
        );
        assert_eq!(fs::read_to_string(file).unwrap(), "{\"id\":\"a\"}\n");
    }
}
