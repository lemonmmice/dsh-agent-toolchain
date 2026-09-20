use fs2::FileExt;
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::PathBuf,
    thread,
    time::{Duration, Instant, SystemTime},
};

pub struct IndexRow {
    pub key: Vec<u16>,
    pub ts: f64,
    pub bytes: u64,
    pub shard: String,
}

pub struct WriteRow {
    pub key: Vec<u16>,
    pub ts: f64,
    pub json: String,
    pub shard: String,
}

pub struct AppendResult {
    pub applied: Vec<bool>,
    pub reload: bool,
    pub duplicates: u32,
}

pub struct TrimPlan {
    pub keys: Vec<Vec<u16>>,
    pub kept_bytes: u64,
    pub dropped: usize,
    pub reason: &'static str,
}

#[derive(PartialEq, Eq)]
struct Stamp {
    name: String,
    len: u64,
    modified: SystemTime,
    created: Option<SystemTime>,
}

struct Meta {
    ts: f64,
    bytes: u64,
    shard: String,
}

pub struct Store {
    directory: PathBuf,
    stamps: Option<Vec<Stamp>>,
    indexed: bool,
    records: HashMap<Vec<u16>, Meta>,
    retained_bytes: u64,
}

fn is_shard(name: &str) -> bool {
    name == "records.jsonl"
        || (name.len() == 22
            && name.starts_with("records-")
            && name.ends_with(".jsonl")
            && name.as_bytes()[8..16].iter().all(u8::is_ascii_digit))
}

// The legacy shard precedes every dated shard, matching the existing JS reader.
fn shard_order(name: &str) -> (bool, &str) {
    (name != "records.jsonl", name)
}

fn changed() -> io::Error {
    io::Error::other(
        "CAPTURE_STORE_CHANGED: reload before writing; another writer changed the shards",
    )
}

impl Store {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            stamps: None,
            indexed: false,
            records: HashMap::new(),
            retained_bytes: 0,
        }
    }

    fn scan(&self) -> io::Result<Vec<Stamp>> {
        let entries = match fs::read_dir(&self.directory) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        let mut stamps = Vec::new();
        for entry in entries {
            let entry = entry?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !is_shard(&name) {
                continue;
            }
            let metadata = entry.metadata()?;
            if !metadata.is_file() {
                return Err(io::Error::other("capture shard is not a regular file"));
            }
            stamps.push(Stamp {
                name,
                len: metadata.len(),
                modified: metadata.modified()?,
                created: metadata.created().ok(),
            });
        }
        stamps.sort_by(|a, b| shard_order(&a.name).cmp(&shard_order(&b.name)));
        Ok(stamps)
    }

    // Lock handles live only for an operation; the OS releases them on process exit.
    // A persistent lock file avoids unlink/reopen races between cooperating writers.
    fn lock(&self, create: bool) -> io::Result<Option<File>> {
        if create {
            fs::create_dir_all(&self.directory)?;
        } else if !self.directory.try_exists()? {
            return Ok(None);
        }
        let file = match OpenOptions::new()
            .read(true)
            .write(create)
            .create(create)
            .truncate(false)
            .open(self.directory.join(".capture-store.lock"))
        {
            Ok(file) => file,
            Err(e) if !create && e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        let started = Instant::now();
        loop {
            match if create {
                FileExt::try_lock_exclusive(&file)
            } else {
                FileExt::try_lock_shared(&file)
            } {
                Ok(()) => return Ok(Some(file)),
                // Windows reports ERROR_LOCK_VIOLATION (33), which std does not
                // classify as WouldBlock. Use fs2's platform-specific code.
                Err(e)
                    if e.raw_os_error() == fs2::lock_contended_error().raw_os_error()
                        && started.elapsed() < Duration::from_secs(2) =>
                {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(e) => return Err(e),
            }
        }
    }

    pub fn is_fresh(&self) -> io::Result<bool> {
        Ok(self.stamps.as_ref() == Some(&self.scan()?))
    }

    fn require_fresh(&self) -> io::Result<()> {
        if self.indexed && self.stamps.as_ref() == Some(&self.scan()?) {
            Ok(())
        } else {
            Err(changed())
        }
    }

    pub fn load(&mut self) -> io::Result<Vec<(String, String)>> {
        let _lock = self.lock(false)?;
        self.indexed = false;
        let stamps = self.scan()?;
        let mut shards = Vec::new();
        for stamp in &stamps {
            let bytes = fs::read(self.directory.join(&stamp.name))?;
            shards.push((
                stamp.name.clone(),
                String::from_utf8_lossy(&bytes).into_owned(),
            ));
        }
        if self.scan()? != stamps {
            return Err(changed());
        }
        self.stamps = Some(stamps);
        Ok(shards)
    }

    pub fn index(&mut self, rows: Vec<IndexRow>) -> io::Result<()> {
        let _lock = self.lock(false)?;
        if self.stamps.as_ref() != Some(&self.scan()?) {
            return Err(changed());
        }
        self.records.clear();
        self.retained_bytes = 0;
        for row in rows {
            self.apply(row);
        }
        self.indexed = true;
        Ok(())
    }

    fn apply(&mut self, row: IndexRow) -> bool {
        if let Some(old) = self.records.get(&row.key) {
            if shard_order(&row.shard) < shard_order(&old.shard) {
                return false;
            }
            self.retained_bytes -= old.bytes;
        }
        self.retained_bytes += row.bytes;
        self.records.insert(
            row.key,
            Meta {
                ts: row.ts,
                bytes: row.bytes,
                shard: row.shard,
            },
        );
        true
    }

    fn validate(rows: &[WriteRow]) -> io::Result<()> {
        for row in rows {
            if !is_shard(&row.shard) || !row.ts.is_finite() || row.json.contains(['\n', '\r']) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "invalid capture row or shard name",
                ));
            }
        }
        Ok(())
    }

    pub fn append(&mut self, rows: Vec<WriteRow>) -> io::Result<AppendResult> {
        Self::validate(&rows)?;
        let _lock = self.lock(true)?;
        self.require_fresh()?;
        let last_shard = self
            .stamps
            .as_ref()
            .and_then(|s| s.last())
            .map(|s| s.name.as_str())
            .unwrap_or("records.jsonl");
        let reload = rows
            .iter()
            .any(|r| shard_order(&r.shard) < shard_order(last_shard));
        let mut groups: BTreeMap<&str, Vec<&WriteRow>> = BTreeMap::new();
        for row in &rows {
            groups.entry(&row.shard).or_default().push(row);
        }
        self.indexed = false;
        for (name, group) in groups {
            let mut file = OpenOptions::new()
                .read(true)
                .append(true)
                .create(true)
                .open(self.directory.join(name))?;
            // Recover an incomplete final line without joining the new record to it.
            if file.metadata()?.len() > 0 {
                file.seek(SeekFrom::End(-1))?;
                let mut last = [0];
                file.read_exact(&mut last)?;
                if last[0] != b'\n' {
                    file.write_all(b"\n")?;
                }
            }
            let mut batch = Vec::new();
            for row in group {
                batch.extend_from_slice(row.json.as_bytes());
                batch.push(b'\n');
            }
            file.write_all(&batch)?;
        }
        let mut applied = Vec::new();
        let mut duplicates = 0;
        for row in rows {
            if self.records.contains_key(&row.key) {
                duplicates += 1;
            }
            applied.push(self.apply(IndexRow {
                key: row.key,
                ts: row.ts,
                bytes: row.json.len() as u64 + 1,
                shard: row.shard,
            }));
        }
        self.stamps = Some(self.scan()?);
        self.indexed = true;
        Ok(AppendResult {
            applied,
            reload,
            duplicates,
        })
    }

    pub fn replace(&mut self, rows: Vec<WriteRow>) -> io::Result<()> {
        Self::validate(&rows)?;
        let _lock = self.lock(true)?;
        self.require_fresh()?;
        let mut groups: BTreeMap<String, Vec<&WriteRow>> = BTreeMap::new();
        for row in &rows {
            groups.entry(row.shard.clone()).or_default().push(row);
        }
        let mut staged = Vec::new();
        let result = (|| {
            // Stage EVERY shard before publishing any. A stage/write failure
            // leaves the original store untouched, including earlier shards.
            for (name, group) in &groups {
                let tmp = self.directory.join(format!("{name}.tmp"));
                let mut file = File::create(&tmp)?;
                staged.push(tmp);
                let mut out = io::BufWriter::new(&mut file);
                for row in group {
                    out.write_all(row.json.as_bytes())?;
                    out.write_all(b"\n")?;
                }
                out.flush()?;
                drop(out);
                file.sync_all()?;
            }
            self.indexed = false;
            for name in groups.keys() {
                fs::rename(
                    self.directory.join(format!("{name}.tmp")),
                    self.directory.join(name),
                )?;
            }
            // Delete obsolete shards only after all replacement files exist.
            for stamp in self.stamps.as_ref().into_iter().flatten() {
                if !groups.contains_key(&stamp.name) {
                    fs::remove_file(self.directory.join(&stamp.name))?;
                }
            }
            Ok(())
        })();
        // Preserve the original error; cleanup is limited to files we staged.
        for tmp in staged {
            let _ = fs::remove_file(tmp);
        }
        result
    }

    pub fn stats(&self) -> (usize, u64, u64) {
        (
            self.records.len(),
            self.retained_bytes,
            self.stamps
                .as_ref()
                .into_iter()
                .flatten()
                .map(|s| s.len)
                .sum(),
        )
    }

    pub fn plan(&self, max_records: usize, max_bytes: f64) -> Option<TrimPlan> {
        let budget = (max_bytes * 0.9).floor() as u64;
        if self.records.len() <= max_records && self.retained_bytes <= budget {
            return None;
        }
        let mut newest: Vec<_> = self.records.iter().collect();
        newest.sort_by(|(ak, a), (bk, b)| b.ts.total_cmp(&a.ts).then_with(|| bk.cmp(ak)));
        let mut keys = Vec::new();
        let mut kept_bytes = 0;
        let mut reason = "max-records";
        for (key, row) in newest {
            if keys.len() >= max_records {
                break;
            }
            if !keys.is_empty() && kept_bytes + row.bytes > budget {
                reason = "max-bytes";
                break;
            }
            kept_bytes += row.bytes;
            keys.push(key.clone());
        }
        let dropped = self.records.len() - keys.len();
        if dropped == 0 {
            return None;
        }
        Some(TrimPlan {
            keys,
            kept_bytes,
            dropped,
            reason,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, ts: f64, shard: &str) -> WriteRow {
        WriteRow {
            key: id.encode_utf16().collect(),
            ts,
            shard: shard.to_owned(),
            json: format!("{{\"id\":\"{id}\",\"ts\":{ts}}}"),
        }
    }

    fn empty(directory: PathBuf) -> Store {
        let mut store = Store::new(directory);
        assert!(store.load().unwrap().is_empty());
        store.index(Vec::new()).unwrap();
        store
    }

    #[test]
    fn rejects_traversal_before_creating_files() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = empty(temp.path().join("data"));
        assert!(
            store
                .append(vec![row("a", 1.0, "../escape.jsonl")])
                .is_err()
        );
        assert!(!temp.path().join("data").exists());
    }

    #[test]
    fn accounting_tracks_replacements_and_single_oversized_record_survives() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = empty(temp.path().to_owned());
        store
            .append(vec![row("a", 1.0, "records-20260101.jsonl")])
            .unwrap();
        let before = store.stats().1;
        let result = store
            .append(vec![row("a", 2.0, "records-20260101.jsonl")])
            .unwrap();
        assert_eq!(result.duplicates, 1);
        assert_eq!(store.stats().0, 1);
        assert_eq!(store.stats().1, before);
        assert!(store.plan(20000, 1.0).is_none());
        store
            .append(vec![row("b", 3.0, "records-20260101.jsonl")])
            .unwrap();
        let plan = store.plan(20000, 1.0).unwrap();
        assert_eq!(
            plan.keys,
            vec!['b'.to_string().encode_utf16().collect::<Vec<_>>()]
        );
        assert_eq!(plan.dropped, 1);
    }

    #[test]
    fn stale_replace_cannot_delete_another_writers_append() {
        let temp = tempfile::tempdir().unwrap();
        let mut first = empty(temp.path().to_owned());
        let mut second = empty(temp.path().to_owned());
        first
            .append(vec![row("a", 1.0, "records-20260101.jsonl")])
            .unwrap();
        assert!(
            second
                .replace(Vec::new())
                .unwrap_err()
                .to_string()
                .contains("CAPTURE_STORE_CHANGED")
        );
        assert!(
            fs::read_to_string(temp.path().join("records-20260101.jsonl"))
                .unwrap()
                .contains("\"a\"")
        );
    }

    #[test]
    fn all_staging_finishes_before_any_replacement_is_published() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = empty(temp.path().to_owned());
        store
            .append(vec![
                row("a", 1.0, "records-20260101.jsonl"),
                row("b", 2.0, "records-20260102.jsonl"),
            ])
            .unwrap();
        let first = temp.path().join("records-20260101.jsonl");
        let before = fs::read(&first).unwrap();
        fs::create_dir(temp.path().join("records-20260102.jsonl.tmp")).unwrap();
        assert!(
            store
                .replace(vec![
                    row("changed", 1.0, "records-20260101.jsonl"),
                    row("b", 2.0, "records-20260102.jsonl")
                ])
                .is_err()
        );
        assert_eq!(fs::read(first).unwrap(), before);
    }
}
