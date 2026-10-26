use anyhow::{Context, Result, bail};
use serde::Serialize;
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug)]
pub struct LocalPaths {
    config_parent: PathBuf,
    home: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
pub struct PathPreview {
    pub resolved: String,
    pub error: Option<String>,
    pub warning: Option<String>,
}

impl LocalPaths {
    pub fn new(config: &Path, home: Option<PathBuf>) -> Result<Self> {
        reject_ambiguous_path(config)?;
        let config = if config.is_absolute() {
            config.to_owned()
        } else {
            std::env::current_dir()
                .context("Could not determine the configuration directory")?
                .join(config)
        };
        let config_parent = config
            .parent()
            .context("The configuration file must have a parent directory")?
            .to_owned();
        Ok(Self {
            config_parent,
            home,
        })
    }

    /// Expand a local spelling at use time without canonicalizing symlinks or `..`.
    pub fn resolve(&self, value: &str) -> Result<Option<PathBuf>> {
        // Stored paths have already lost their Copy-as-path quotes. Do not trim
        // significant filename spaces a second time when resolving that spelling.
        let value = value
            .trim()
            .strip_prefix('"')
            .and_then(|inside| inside.strip_suffix('"'))
            .unwrap_or(value);
        if value.trim().is_empty() {
            return Ok(None);
        }
        let path = if let Some(remainder) = home_remainder(value) {
            let home = self
                .home
                .as_ref()
                .context("The home directory is unavailable; enter an absolute path instead")?;
            home.join(remainder.trim_start_matches(['/', '\\']))
        } else {
            PathBuf::from(value)
        };
        reject_ambiguous_path(&path)?;
        Ok(Some(if path.is_absolute() {
            path
        } else {
            self.config_parent.join(path)
        }))
    }

    pub fn preview(&self, field: &str, value: &str) -> PathPreview {
        let mut preview = PathPreview {
            resolved: String::new(),
            error: None,
            warning: None,
        };
        let path = match self.resolve(value) {
            Ok(Some(path)) => path,
            Ok(None) => return preview,
            Err(error) => {
                preview.error = Some(error.to_string());
                return preview;
            }
        };
        preview.resolved = path.to_string_lossy().into_owned();
        let (label, directory) = match field {
            "key" => ("SSH key", false),
            "localEnv" => ("Local environment file", false),
            "localBot" => ("Local bot directory", true),
            _ => {
                preview.error = Some("Unknown local path field".into());
                return preview;
            }
        };
        preview.error = check_kind(&path, label, directory)
            .err()
            .map(|error| error.to_string());
        if field == "key"
            && path
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("pub"))
        {
            preview.warning = Some(
                "This looks like a public key (.pub); SSH usually requires the private key.".into(),
            );
        }
        preview
    }

    pub fn require_file(&self, value: &str, label: &str) -> Result<PathBuf> {
        self.require(value, label, false)
    }

    pub fn require_dir(&self, value: &str, label: &str) -> Result<PathBuf> {
        self.require(value, label, true)
    }

    fn require(&self, value: &str, label: &str, directory: bool) -> Result<PathBuf> {
        let path = self
            .resolve(value)?
            .with_context(|| format!("{label} is required"))?;
        check_kind(&path, label, directory)?;
        Ok(path)
    }
}

fn home_remainder(value: &str) -> Option<&str> {
    const PROFILE: &str = "%USERPROFILE%";
    let remainder = if let Some(remainder) = value.strip_prefix('~') {
        remainder
    } else if value
        .get(..PROFILE.len())
        .is_some_and(|token| token.eq_ignore_ascii_case(PROFILE))
    {
        &value[PROFILE.len()..]
    } else {
        return None;
    };
    (remainder.is_empty() || remainder.starts_with(['/', '\\'])).then_some(remainder)
}

fn check_kind(path: &Path, label: &str, directory: bool) -> Result<()> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            bail!("{label} does not exist: {}", path.display());
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("Could not inspect {label}: {}", path.display()));
        }
    };
    if directory && !metadata.is_dir() {
        bail!("{label} must be a directory: {}", path.display());
    }
    if !directory && !metadata.is_file() {
        bail!("{label} must be a file: {}", path.display());
    }
    Ok(())
}

fn reject_ambiguous_path(path: &Path) -> Result<()> {
    #[cfg(windows)]
    if !path.is_absolute()
        && (path.has_root()
            || matches!(
                path.components().next(),
                Some(std::path::Component::Prefix(_))
            ))
    {
        bail!(
            "Use an absolute path with a drive and root, a UNC path, or a path relative to the configuration file"
        );
    }
    #[cfg(not(windows))]
    let _ = path;
    Ok(())
}
