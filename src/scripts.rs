use anyhow::{Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::collections::HashMap;

pub fn text<'a>(c: &'a Value, k: &str) -> &'a str {
    c[k].as_str().unwrap_or("")
}
pub fn q(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
pub fn encode(s: &str) -> String {
    const SET: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    percent_encoding::utf8_percent_encode(s, SET).to_string()
}
// Scan the template once: a user value containing a marker is never interpolated again.
fn render(template: &str, values: &HashMap<&str, String>) -> String {
    let mut out = String::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let tail = &rest[start + 2..];
        if let Some(end) = tail.find("}}") {
            out.push_str(
                values
                    .get(&tail[..end])
                    .expect("known embedded template marker"),
            );
            rest = &tail[end + 2..];
        } else {
            out.push_str(&rest[start..]);
            return out;
        }
    }
    out.push_str(rest);
    out
}
pub fn ecosystem(c: &Value) -> String {
    let values = HashMap::from([
        ("dir_json", json!(text(c, "dir")).to_string()),
        ("app_json", json!(text(c, "app")).to_string()),
        ("entry_json", json!(text(c, "entryFile")).to_string()),
    ]);
    render(include_str!("../templates/ecosystem.cjs"), &values)
}
pub fn header(c: &Value) -> String {
    render(
        include_str!("../templates/header.sh"),
        &HashMap::from([("app", q(text(c, "app"))), ("dir", q(text(c, "dir")))]),
    )
}
pub fn script(c: &Value, a: &str, p: &Value) -> Result<String> {
    macro_rules! action {($($name:literal),*)=>{match a {$($name=>include_str!(concat!("../templates/",$name,".sh")),)* _=>bail!("Unknown action")}};}
    let template = action!(
        "test",
        "setup",
        "sysupdate",
        "memory",
        "npmupdate",
        "deploy",
        "redeploy",
        "prepare",
        "pull",
        "clone",
        "resetrepo",
        "gitstatus",
        "cmds",
        "start",
        "solo",
        "stop",
        "restart",
        "status",
        "logs",
        "follow",
        "flush",
        "sysinfo",
        "backup",
        "envshow",
        "reboot",
        "custom"
    );
    let managed = c["managed"].as_bool().unwrap_or(false);
    let id = text(c, "id");
    if managed
        && (id.is_empty()
            || !id
                .chars()
                .all(|v| v.is_ascii_alphanumeric() || "_-".contains(v)))
    {
        bail!("Invalid bot profile ID");
    }
    let managed_files = if managed {
        format!(
            "\nPANEL_DIR=\"$HOME/.bot-panel/{id}\"\nmkdir -p \"$PANEL_DIR\"\nprintf '%s' {} | base64 -d > \"$PANEL_DIR/ecosystem.config.cjs\"\n",
            q(&STANDARD.encode(ecosystem(c)))
        )
    } else {
        String::new()
    };
    let token = text(c, "token");
    let repo = text(c, "repo");
    let url = if token.is_empty() {
        repo.to_owned()
    } else {
        repo.replacen("https://", &format!("https://{}@", encode(token)), 1)
    };
    let lines = p["lines"]
        .as_i64()
        .or_else(|| p["lines"].as_str().and_then(|s| s.parse().ok()))
        .filter(|n| *n != 0)
        .unwrap_or(200)
        .max(1);
    let filter = text(p, "filter");
    let build = text(c, "buildCmd");
    let sync = text(c, "cmdSyncCmd");
    let values = HashMap::from([
        ("repo", q(&url)),
        (
            "branch",
            q(if text(c, "branch").is_empty() {
                "main"
            } else {
                text(c, "branch")
            }),
        ),
        ("managed_files", managed_files),
        (
            "pm_config",
            if managed {
                "\"$PANEL_DIR/ecosystem.config.cjs\"".into()
            } else {
                "ecosystem.config.cjs".into()
            },
        ),
        (
            "build_cmd",
            if build.is_empty() { "true" } else { build }.into(),
        ),
        (
            "sync_cmd",
            if sync.is_empty() {
                if a == "cmds" {
                    "echo \"No command sync configured for this bot\""
                } else {
                    "echo \"Skipped (no command configured)\""
                }
            } else {
                sync
            }
            .into(),
        ),
        ("lines", lines.to_string()),
        (
            "log_err",
            if p["err"].as_bool().unwrap_or(false) {
                " --err"
            } else {
                ""
            }
            .into(),
        ),
        (
            "log_filter",
            if filter.is_empty() {
                String::new()
            } else {
                format!(" | grep -i --line-buffered -e {}", q(filter))
            },
        ),
        (
            "custom",
            if text(p, "cmd").is_empty() {
                "echo \"Type a command first\""
            } else {
                text(p, "cmd")
            }
            .into(),
        ),
        (
            "other_apps",
            c["otherApps"]
                .as_array()
                .map(|apps| {
                    apps.iter()
                        .map(|v| {
                            let app = q(v.as_str().unwrap_or(""));
                            format!(
                                "if pm2 describe {app} >/dev/null 2>&1; then pm2 stop {app}; fi"
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                })
                .unwrap_or_default(),
        ),
    ]);
    Ok(header(c) + &render(template, &values))
}

pub const STATUS: &str = include_str!("../templates/dashboard-status.sh");
pub fn parse_status(output: &str, code: i32, selected: &str) -> Value {
    let get = |key: &str| {
        output
            .lines()
            .find_map(|line| line.strip_prefix(&format!("@@{key} ")))
    };
    if code != 0 || get("UP").is_none() {
        return json!({"error":output.lines().rev().take(2).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" ")});
    }
    let apps:Vec<Value>=serde_json::from_str::<Vec<Value>>(get("PM2").unwrap_or("[]")).unwrap_or_default().into_iter().map(|a|json!({"name":a["name"],"status":a["pm2_env"]["status"],"uptime":a["pm2_env"]["pm_uptime"],"mem":a["monit"]["memory"],"cpu":a["monit"]["cpu"],"restarts":a["pm2_env"]["restart_time"]})).collect();
    json!({"up":get("UP"),"load":get("LOAD"),"mem":get("MEM"),"disk":get("DISK"),"app":apps.iter().find(|a|a["name"]==selected),"apps":apps})
}
pub fn removal(c: &Value, others: &[String], delete: bool) -> Result<String> {
    let id = text(c, "id");
    if id.is_empty()
        || !id
            .chars()
            .all(|v| v.is_ascii_alphanumeric() || "_-".contains(v))
    {
        bail!("Invalid bot profile ID");
    }
    let dir = crate::profiles::linux_path(text(c, "dir"))?;
    let checks = if delete {
        format!(
            r#"HOME_DIR=$(realpath -e -- "$HOME")
TARGET=$(realpath -m -- "$DIR")
[ "$TARGET" = "$DIR" ] || {{ echo 'Refusing file deletion through a symlink.'; exit 1; }}
case "$TARGET" in "$HOME_DIR"/*) ;; *) echo 'File deletion requires a bot subfolder inside the SSH user home.'; exit 1;; esac
RELATIVE=${{TARGET#"$HOME_DIR"/}}
case "$RELATIVE" in .*|bots|bots/.*) echo 'Refusing deletion of a shared or hidden home folder.'; exit 1;; esac
{}
"#,
            others
                .iter()
                .map(|other| format!(
                    r#"OTHER=$(realpath -m -- {})
case "$TARGET/" in "$OTHER/"*) echo 'Folder overlaps another bot.'; exit 1;; esac
case "$OTHER/" in "$TARGET/"*) echo 'Folder contains another bot.'; exit 1;; esac"#,
                    q(other)
                ))
                .collect::<Vec<_>>()
                .join("\n")
        )
    } else {
        String::new()
    };
    let managed = c["managed"].as_bool().unwrap_or(false);
    let guard = if managed {
        format!(
            "PANEL_DIR=\"$HOME/.bot-panel/{id}\"\nif [ -L \"$HOME/.bot-panel\" ] || [ -L \"$PANEL_DIR\" ]; then echo 'Refusing a symlinked panel configuration folder.'; exit 1; fi\n"
        )
    } else {
        String::new()
    };
    let js = format!(
        "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{{try{{const apps=JSON.parse(s);if(!Array.isArray(apps))throw Error();process.stdout.write(apps.some(a=>a.name==={})?'yes':'no');}}catch{{console.error('Could not read the PM2 process list.');process.exitCode=1;}}}});",
        json!(text(c, "app"))
    );
    let cleanup = if managed {
        "rm -f -- \"$PANEL_DIR/ecosystem.config.cjs\"\nrmdir -- \"$PANEL_DIR\" 2>/dev/null || true"
    } else {
        ""
    };
    let files = if delete {
        "rm -rf -- \"$TARGET\"\necho \"Removed bot files: $TARGET\""
    } else {
        "echo \"Kept bot files: $DIR\""
    };
    Ok(format!(
        "set -euo pipefail\nAPP={}; DIR={}\ncd \"$HOME\"\n{checks}\n{guard}\nPRESENT=$(pm2 jlist | node -e {})\nif [ \"$PRESENT\" = yes ]; then pm2 delete \"$APP\"; fi\npm2 save --force\n{cleanup}\n{files}\necho \"Removed PM2 app: $APP\"\n",
        q(text(c, "app")),
        q(&dir),
        q(&js)
    ))
}
