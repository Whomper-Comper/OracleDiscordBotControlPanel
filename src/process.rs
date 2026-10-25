use crate::scripts::{encode, text};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command, sync::mpsc};
use tokio_util::sync::CancellationToken;

pub struct Redactor {
    secrets: Vec<Vec<u8>>,
    pending: Vec<u8>,
}
impl Redactor {
    pub fn new(secrets: Vec<String>) -> Self {
        let mut secrets: Vec<_> = secrets
            .into_iter()
            .filter(|s| !s.is_empty())
            .map(String::into_bytes)
            .collect();
        secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
        Self {
            secrets,
            pending: Vec::new(),
        }
    }
    pub fn push(&mut self, bytes: &[u8], eof: bool) -> String {
        self.pending.extend_from_slice(bytes);
        let mut i = 0;
        let mut out = String::new();
        while i < self.pending.len() {
            let rest = &self.pending[i..];
            if !eof
                && self
                    .secrets
                    .iter()
                    .any(|s| s.starts_with(rest) && s.len() > rest.len())
            {
                break;
            }
            if let Some(secret) = self.secrets.iter().find(|s| rest.starts_with(s)) {
                out.push_str("***");
                i += secret.len();
                continue;
            }
            let len = match rest[0] {
                0..=127 => 1,
                194..=223 => 2,
                224..=239 => 3,
                240..=244 => 4,
                _ => 1,
            };
            if rest.len() < len && !eof {
                break;
            }
            let mut size = len.min(rest.len());
            if let Err(error) = std::str::from_utf8(&rest[..size]) {
                // Do not swallow the first ASCII byte after an invalid UTF-8 leader:
                // it may be the beginning of a secret and must be matched next.
                size = error.error_len().unwrap_or(size);
            }
            out.push_str(&String::from_utf8_lossy(&rest[..size]));
            i += size;
        }
        self.pending.drain(..i);
        out
    }
}

async fn emit(tx: &mpsc::Sender<String>, cancel: &CancellationToken, s: String) -> bool {
    if s.is_empty() {
        return true;
    }
    tokio::select! {_ = cancel.cancelled()=>false, result=tx.send(s)=>result.is_ok()}
}
pub async fn run(
    exe: &str,
    args: &[String],
    cwd: Option<&Path>,
    mask: Vec<String>,
    tx: mpsc::Sender<String>,
    cancel: CancellationToken,
    timeout: Duration,
) -> i32 {
    if cancel.is_cancelled() || tx.is_closed() {
        return 1;
    }
    let mut cmd = Command::new(exe);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd.filter(|p| !p.as_os_str().is_empty()) {
        cmd.current_dir(cwd);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x08000000 | 0x00000004); // NO_WINDOW | SUSPENDED
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let mut r = Redactor::new(mask);
            emit(
                &tx,
                &cancel,
                r.push(format!("✖ Could not start {exe}: {e}\n").as_bytes(), true),
            )
            .await;
            return 1;
        }
    };
    let _tree = match crate::process_tree::ProcessTree::attach(&child) {
        Ok(tree) => tree,
        Err(e) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            emit(
                &tx,
                &cancel,
                format!("✖ Could not own the local process tree: {e}\n"),
            )
            .await;
            return 1;
        }
    };
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let mut out = Redactor::new(mask.clone());
    let mut err = Redactor::new(mask);
    let mut a = [0u8; 4096];
    let mut b = [0u8; 4096];
    let (mut out_done, mut err_done, mut code) = (false, false, None);
    let deadline = async {
        if timeout.is_zero() {
            std::future::pending::<()>().await
        } else {
            tokio::time::sleep(timeout).await
        }
    };
    tokio::pin!(deadline);
    loop {
        if out_done
            && err_done
            && let Some(code) = code
        {
            return code;
        }
        tokio::select! {
            _=cancel.cancelled()=>{let _=child.kill().await;let _=child.wait().await;return 1;}
            _=tx.closed()=>{let _=child.kill().await;let _=child.wait().await;return 1;}
            _=&mut deadline=>{let _=child.kill().await;let _=child.wait().await;emit(&tx,&cancel,"✖ Process timed out. The VM may be overloaded or unreachable.\n".into()).await;return 124;}
            result=child.wait(),if code.is_none()=>{code=Some(result.ok().and_then(|s|s.code()).unwrap_or(1));}
            result=stdout.read(&mut a),if !out_done=>{
                let n=result.unwrap_or(0);out_done=n==0;
                if !emit(&tx,&cancel,out.push(&a[..n],out_done)).await{let _=child.kill().await;let _=child.wait().await;return 1;}
            }
            result=stderr.read(&mut b),if !err_done=>{
                let n=result.unwrap_or(0);err_done=n==0;
                if !emit(&tx,&cancel,err.push(&b[..n],err_done)).await{let _=child.kill().await;let _=child.wait().await;return 1;}
            }
        }
    }
}

pub fn masks(c: &Value) -> Vec<String> {
    let token = text(c, "token");
    vec![token.into(), encode(token)]
}
fn connection_args(c: &Value, scp: bool) -> Vec<String> {
    let mut args = Vec::new();
    if !text(c, "key").is_empty() {
        args.extend(["-i".into(), text(c, "key").into()]);
    }
    args.extend([if scp { "-P" } else { "-p" }.into(), text(c, "port").into()]);
    for option in [
        "StrictHostKeyChecking=accept-new",
        "BatchMode=yes",
        "ConnectTimeout=30",
        "ConnectionAttempts=1",
        "ServerAliveInterval=20",
        "ServerAliveCountMax=9",
    ] {
        args.extend(["-o".into(), option.into()]);
    }
    args
}
pub async fn ssh(
    c: &Value,
    shell: &str,
    tx: mpsc::Sender<String>,
    cancel: CancellationToken,
    timeout: Duration,
) -> i32 {
    let mut args = connection_args(c, false);
    args.extend([
        "-T".into(),
        format!("{}@{}", text(c, "user"), text(c, "host")),
        format!("bash -lc \"$(echo {}|base64 -d)\"", STANDARD.encode(shell)),
    ]);
    run("ssh", &args, None, masks(c), tx, cancel, timeout).await
}
pub async fn scp(
    c: &Value,
    file: &Path,
    target: &str,
    tx: mpsc::Sender<String>,
    cancel: CancellationToken,
) -> i32 {
    let mut args = connection_args(c, true);
    args.extend([
        file.file_name().unwrap().to_string_lossy().into_owned(),
        format!("{}@{}:{target}", text(c, "user"), text(c, "host")),
    ]);
    run(
        "scp",
        &args,
        file.parent(),
        masks(c),
        tx,
        cancel,
        Duration::ZERO,
    )
    .await
}
