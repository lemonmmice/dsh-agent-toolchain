use anyhow::{Context, Result, bail};
use serde_json::Value;
use std::{collections::HashMap, path::PathBuf};

#[derive(Clone)]
pub struct Config {
    pub values: HashMap<String, String>,
    pub home: PathBuf,
    pub legacy: Option<PathBuf>,
}

impl Config {
    pub fn load() -> Result<Self> {
        let mut values: HashMap<String, String> = std::env::vars().collect();
        let home = values
            .get("USERPROFILE")
            .or_else(|| values.get("HOME"))
            .map(PathBuf::from)
            .context("Home directory is not configured")?;
        let file = values
            .get("DSH_ENV_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".dsh-agent-toolchain/env.json"));
        if !file.to_string_lossy().eq_ignore_ascii_case("none") && file.exists() {
            let data =
                std::fs::read_to_string(&file).context("Cannot read DSH environment file")?;
            let parsed: Value = serde_json::from_str(data.trim_start_matches('\u{feff}'))
                .context("Invalid DSH environment file")?;
            let object = parsed
                .as_object()
                .context("DSH environment file must be an object")?;
            for (key, value) in object {
                if key.starts_with("DSH_")
                    && !key.starts_with("DSH_CRED_")
                    && key.bytes().all(|byte| {
                        byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
                    })
                    && let Some(text) = value.as_str()
                {
                    values.insert(key.clone(), text.to_string());
                }
            }
        }
        let mut legacy = values
            .get("DSH_LEGACY_MCP_SERVER")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from);
        let mut arguments = std::env::args().skip(1);
        while let Some(argument) = arguments.next() {
            match argument.as_str() {
                "--legacy-server" => {
                    legacy = Some(PathBuf::from(
                        arguments
                            .next()
                            .context("--legacy-server requires a path")?,
                    ))
                }
                "--native-only" | "--adapter" | "--uia-worker" => {}
                _ => bail!("Unknown argument: {argument}"),
            }
        }
        if std::env::args().any(|argument| argument == "--native-only") {
            legacy = None;
        }
        Ok(Self {
            values,
            home,
            legacy,
        })
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.values
            .get(key)
            .map(String::as_str)
            .filter(|value| !value.is_empty())
    }

    pub fn directory(&self, key: &str, suffix: &str) -> PathBuf {
        self.get(key)
            .map(PathBuf::from)
            .unwrap_or_else(|| self.home.join(".dsh-agent-toolchain").join(suffix))
    }
}
