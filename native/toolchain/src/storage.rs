use anyhow::{Context, Result, bail};
use fs2::FileExt;
use serde_json::Value;
use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

pub fn record_path(directory: &Path, id: &str, suffix: &str) -> Result<PathBuf> {
    if !valid_id(id) {
        bail!("Invalid record id");
    }
    Ok(directory.join(format!("{id}{suffix}")))
}

pub fn write_json(path: &Path, value: &Value) -> Result<()> {
    let directory = path
        .parent()
        .context("Evidence path needs a parent directory")?;
    std::fs::create_dir_all(directory)?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    serde_json::to_writer(&mut temporary, value)?;
    temporary.write_all(b"\n")?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

pub fn read_json(path: &Path) -> Result<Value> {
    Ok(serde_json::from_reader(File::open(path)?)?)
}

pub fn try_lock(path: &Path) -> Result<Option<File>> {
    std::fs::create_dir_all(path.parent().context("Lock needs a parent directory")?)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)?;
    match file.try_lock_exclusive() {
        Ok(()) => Ok(Some(file)),
        Err(error)
            if error.kind() == std::io::ErrorKind::WouldBlock
                || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
        {
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn replacement_and_identifier_boundaries() -> Result<()> {
        let directory = tempfile::tempdir()?;
        for id in ["../outside", "", "a/b", "a\\b", "a:b"] {
            assert!(record_path(directory.path(), id, ".json").is_err());
        }
        let path = record_path(directory.path(), "safe", ".json")?;
        write_json(&path, &json!({"version": 1}))?;
        write_json(&path, &json!({"version": 2}))?;
        assert_eq!(read_json(&path)?["version"], 2);
        let lock_path = directory.path().join("test.lock");
        let guard = try_lock(&lock_path)?.unwrap();
        assert!(try_lock(&lock_path)?.is_none());
        drop(guard);
        assert!(try_lock(&lock_path)?.is_some());
        Ok(())
    }
}
