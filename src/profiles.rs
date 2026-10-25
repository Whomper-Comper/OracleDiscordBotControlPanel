use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, io::Write, path::PathBuf};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

const SHARED: &[&str] = &["host", "port", "user", "key", "token"];
const BOT: &[&str] = &[
    "name",
    "repo",
    "branch",
    "dir",
    "app",
    "buildCmd",
    "cmdSyncCmd",
    "localEnv",
    "localBot",
    "entryFile",
];

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Connection {
    pub host: String,
    pub port: String,
    pub user: String,
    pub key: String,
    pub token: String,
}
impl Default for Connection {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: "22".into(),
            user: "opc".into(),
            key: String::new(),
            token: String::new(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Bot {
    pub id: String,
    pub managed: bool,
    pub name: String,
    pub repo: String,
    pub branch: String,
    pub dir: String,
    pub app: String,
    pub build_cmd: String,
    pub cmd_sync_cmd: String,
    pub local_env: String,
    pub local_bot: String,
    pub entry_file: String,
}
impl Default for Bot {
    fn default() -> Self {
        Self {
            id: "legacy".into(),
            managed: false,
            name: "My bot".into(),
            repo: String::new(),
            branch: "main".into(),
            dir: "/home/opc/bots/my-bot".into(),
            app: "my-bot".into(),
            build_cmd: "npm run build --if-present".into(),
            cmd_sync_cmd: String::new(),
            local_env: String::new(),
            local_bot: String::new(),
            entry_file: String::new(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Store {
    pub version: u8,
    pub server: Connection,
    pub active_bot_id: String,
    pub bots: Vec<Bot>,
}

pub fn normalize(raw: Value) -> Result<Value> {
    Ok(serde_json::to_value(Store::normalize(raw)?)?)
}
impl Store {
    pub fn normalize(raw: Value) -> Result<Self> {
        if !raw.is_object() {
            bail!("Configuration must be a JSON object");
        }
        let store = if raw.get("version").is_some() {
            if raw["version"] != 2 {
                bail!("Unsupported configuration version");
            }
            serde_json::from_value(raw).context("Invalid version 2 configuration")?
        } else {
            Self {
                version: 2,
                server: serde_json::from_value(raw.clone())?,
                active_bot_id: "legacy".into(),
                bots: vec![serde_json::from_value(raw)?],
            }
        };
        store.validate()?;
        Ok(store)
    }
    pub fn validate(&self) -> Result<()> {
        if self
            .server
            .port
            .parse::<u16>()
            .ok()
            .filter(|p| *p > 0)
            .is_none()
        {
            bail!("SSH port must be between 1 and 65535");
        }
        if !self
            .server
            .user
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-".contains(c))
            || self.server.user.is_empty()
        {
            bail!("Invalid SSH user");
        }
        if self.server.host.starts_with('-')
            || self
                .server
                .host
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || "@/\\".contains(c))
        {
            bail!("Invalid SSH host");
        }
        let mut apps = HashSet::new();
        let mut ids = HashSet::new();
        let mut dirs: Vec<String> = Vec::new();
        for b in &self.bots {
            if b.id.is_empty()
                || !b
                    .id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "_-".contains(c))
                || !ids.insert(&b.id)
            {
                bail!("Invalid or duplicate bot profile ID");
            }
            if b.name.trim().is_empty()
                || b.app.is_empty()
                || !b.app.starts_with(|c: char| c.is_ascii_alphanumeric())
                || !b
                    .app
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "_-".contains(c))
                || b.app.chars().all(|c| c.is_ascii_digit())
                || b.app == "all"
            {
                bail!(
                    "Use a bot name and a nonnumeric PM2 name containing letters, numbers, hyphens or underscores (not all)"
                );
            }
            let dir = linux_path(&b.dir)?;
            if dir == "/" || !apps.insert(&b.app) || dirs.iter().any(|d| overlap(d, &dir)) {
                bail!(
                    "Bots need unique PM2 names and separate, non-nested absolute install folders"
                );
            }
            dirs.push(dir);
        }
        if self.bots.is_empty() {
            if !self.active_bot_id.is_empty() {
                bail!("Empty fleet has an invalid selection");
            }
        } else {
            self.bot(&self.active_bot_id)?;
        }
        Ok(())
    }
    pub fn bot(&self, id: &str) -> Result<&Bot> {
        self.bots
            .iter()
            .find(|b| b.id == id)
            .context("Unknown bot profile. Refresh the panel.")
    }
    pub fn active(&self, id: Option<&str>) -> Result<Value> {
        let bot = self.bot(id.unwrap_or(&self.active_bot_id))?;
        let mut v = serde_json::to_value(&self.server)?;
        v.as_object_mut()
            .unwrap()
            .extend(serde_json::to_value(bot)?.as_object().unwrap().clone());
        v["botId"] = json!(bot.id);
        Ok(v)
    }
    pub fn revision(&self, id: &str) -> Result<String> {
        Ok(format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&self.active(Some(id))?)?)
        ))
    }
    pub fn view(&self, id: Option<&str>) -> Result<Value> {
        let id = id.unwrap_or(&self.active_bot_id);
        let mut v = if self.bots.is_empty() {
            serde_json::to_value(&self.server)?
        } else {
            self.active(Some(id))?
        };
        v["bots"] = serde_json::to_value(&self.bots)?;
        v["activeBotId"] = json!(id);
        v["removalRevision"] = json!(if self.bots.is_empty() {
            String::new()
        } else {
            self.revision(id)?
        });
        Ok(v)
    }
    pub fn update(&self, input: &Value) -> Result<Self> {
        let mut next = self.clone();
        let id = input["botId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(&self.active_bot_id);
        let mut server = serde_json::to_value(&next.server)?;
        patch(&mut server, input, SHARED);
        next.server = serde_json::from_value(server)?;
        if !id.is_empty() || !next.bots.is_empty() {
            let b = next
                .bots
                .iter_mut()
                .find(|b| b.id == id)
                .context("Unknown bot profile")?;
            let mut v = serde_json::to_value(&*b)?;
            patch(&mut v, input, BOT);
            *b = serde_json::from_value(v)?;
        }
        next.validate()?;
        Ok(next)
    }
    pub fn add(&mut self, input: &Value) -> Result<()> {
        let name = input["name"].as_str().unwrap_or("").trim();
        if name.is_empty() {
            bail!("Enter a bot name");
        }
        let mut slug = String::new();
        for c in name
            .nfkd()
            .filter(|c| !unicode_normalization::char::is_combining_mark(*c))
            .flat_map(char::to_lowercase)
        {
            if c.is_ascii_alphanumeric() {
                slug.push(c)
            } else if !slug.ends_with('-') && !slug.is_empty() {
                slug.push('-')
            }
        }
        slug = slug.trim_matches('-').chars().take(48).collect();
        if slug.is_empty() {
            slug = "bot".into()
        }
        if slug == "all" || slug.chars().all(|c| c.is_ascii_digit()) {
            slug = format!("bot-{slug}")
        }
        let home = if self.server.user == "root" {
            "/root".into()
        } else {
            format!("/home/{}", self.server.user)
        };
        let base = slug.clone();
        let mut n = 2;
        while self
            .bots
            .iter()
            .any(|b| b.app == slug || b.dir == format!("{home}/bots/{slug}"))
        {
            slug = format!("{base}-{n}");
            n += 1;
        }
        let bot = Bot {
            id: Uuid::new_v4().to_string(),
            managed: true,
            name: name.into(),
            app: slug.clone(),
            dir: format!("{home}/bots/{slug}"),
            repo: input["repo"].as_str().unwrap_or("").trim().into(),
            entry_file: input["entryFile"].as_str().unwrap_or("").trim().into(),
            ..Bot::default()
        };
        self.active_bot_id = bot.id.clone();
        self.bots.push(bot);
        self.validate()
    }
    pub fn duplicate(&mut self, input: &Value) -> Result<()> {
        let id = input["id"]
            .as_str()
            .context("Choose a bot profile to duplicate")?;
        let source = self.bot(id)?.clone();
        for key in ["repo", "entryFile"] {
            if input.get(key).is_some() && !input[key].is_string() {
                bail!("{key} must be a string");
            }
        }
        let data = json!({"name":input["name"],"repo":input.get("repo").unwrap_or(&json!(source.repo)),"entryFile":input.get("entryFile").unwrap_or(&json!(source.entry_file))});
        self.add(&data)?;
        let b = self.bots.last_mut().unwrap();
        b.branch = source.branch;
        b.build_cmd = source.build_cmd;
        b.cmd_sync_cmd = source.cmd_sync_cmd;
        self.validate()
    }
    pub fn remove(&mut self, id: &str) -> Result<()> {
        self.bot(id)?;
        self.bots.retain(|b| b.id != id);
        if self.active_bot_id == id {
            self.active_bot_id = self.bots.first().map(|b| b.id.clone()).unwrap_or_default();
        }
        self.validate()
    }
}
fn patch(target: &mut Value, input: &Value, keys: &[&str]) {
    for key in keys {
        if let Some(v) = input.get(*key).filter(|v| v.is_string()) {
            target[*key] = v.clone();
        }
    }
}
pub fn overlap(a: &str, b: &str) -> bool {
    a == b || a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/"))
}
pub fn linux_path(value: &str) -> Result<String> {
    if !value.starts_with('/') || value.contains('\0') || value.split('/').any(|s| s == "..") {
        bail!("Use an absolute Linux folder without parent traversal");
    }
    let parts: Vec<_> = value
        .split('/')
        .filter(|s| !s.is_empty() && *s != ".")
        .collect();
    Ok(format!("/{}", parts.join("/")))
}

#[derive(Clone)]
pub struct Repository {
    pub path: PathBuf,
}
impl Repository {
    pub fn read(&self) -> Result<Store> {
        match fs::read(&self.path) {
            Ok(raw) => Store::normalize(
                serde_json::from_slice(&raw)
                    .context("Could not parse config.json; your existing file was preserved")?,
            ),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Store::normalize(json!({})),
            Err(e) => Err(e.into()),
        }
    }
    pub fn write(&self, store: &Store) -> Result<()> {
        store.validate()?;
        let parent = self
            .path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(std::path::Path::new("."));
        let backup = PathBuf::from(format!("{}.pre-profiles.bak", self.path.display()));
        if self.path.exists() && !backup.exists() {
            fs::copy(&self.path, backup)?;
        }
        let mut temp = tempfile::NamedTempFile::new_in(parent)?;
        temp.write_all(&serde_json::to_vec_pretty(store)?)?;
        temp.as_file_mut().sync_all()?;
        temp.persist(&self.path).map_err(|e| e.error)?;
        Ok(())
    }
}
