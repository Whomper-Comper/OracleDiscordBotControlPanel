use crate::{
    process,
    profiles::{Repository, Store},
    scripts::{self, q, text},
};
use anyhow::{Context, Result, bail};
use axum::{
    Router,
    body::{Body, Bytes, to_bytes},
    extract::{Request, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::{Stream, StreamExt};
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex as SyncMutex},
    task::{Context as TaskContext, Poll},
    time::Duration,
};
use tokio::{
    io::AsyncWriteExt,
    sync::{Mutex, OwnedMutexGuard, mpsc},
};
use tokio_util::sync::CancellationToken;

pub const MAX_UPLOAD: usize = 64 * 1024 * 1024;
#[derive(Clone)]
struct AppState {
    repo: Repository,
    port: u16,
    gate: Arc<Mutex<()>>,
    status: Arc<SyncMutex<Option<CancellationToken>>>,
    shutdown: CancellationToken,
}
pub fn app(repo: Repository, port: u16) -> Router {
    app_with_shutdown(repo, port, CancellationToken::new())
}
fn app_with_shutdown(repo: Repository, port: u16, shutdown: CancellationToken) -> Router {
    Router::new().fallback(handle).with_state(AppState {
        repo,
        port,
        gate: Arc::new(Mutex::new(())),
        status: Arc::new(SyncMutex::new(None)),
        shutdown,
    })
}
pub async fn serve(
    listener: tokio::net::TcpListener,
    repo: Repository,
    shutdown: CancellationToken,
) -> std::io::Result<()> {
    use std::future::IntoFuture;
    let port = listener.local_addr()?.port();
    let server = axum::serve(listener, app_with_shutdown(repo, port, shutdown.clone()))
        .with_graceful_shutdown(shutdown.clone().cancelled_owned())
        .into_future();
    tokio::pin!(server);
    tokio::select! {
        result=&mut server=>result,
        _=shutdown.cancelled()=>{
            // A slow/incomplete incoming body must not keep Ctrl+C waiting forever.
            match tokio::time::timeout(Duration::from_secs(3),&mut server).await {Ok(result)=>result,Err(_)=>Ok(())}
        }
    }
}
fn error(status: StatusCode, e: impl std::fmt::Display) -> Response {
    (status, axum::Json(json!({"error":e.to_string()}))).into_response()
}
fn json(v: Value) -> Response {
    axum::Json(v).into_response()
}
fn asset(mime: &'static str, body: &'static str) -> Response {
    (
        [
            (axum::http::header::CONTENT_TYPE, mime),
            (axum::http::header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
        .into_response()
}
fn decode(s: &str) -> Result<String> {
    Ok(percent_encoding::percent_decode_str(s)
        .decode_utf8()?
        .into_owned())
}
fn resolved(store: &Store, input: &Value) -> Result<Value> {
    store
        .update(input)?
        .active(input["botId"].as_str().filter(|s| !s.is_empty()))
}

async fn handle(State(state): State<AppState>, req: Request) -> Response {
    let mut response = handle_request(state, req).await;
    // Config, action output and errors can all contain administrator credentials.
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

async fn handle_request(state: AppState, req: Request) -> Response {
    let host = req
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if host != format!("localhost:{}", state.port) && host != format!("127.0.0.1:{}", state.port) {
        return error(StatusCode::FORBIDDEN, "Forbidden host");
    }
    let path = req.uri().path().to_owned();
    if req.method() == Method::GET {
        return match path.as_str() {
            "/" => asset("text/html;charset=utf-8", include_str!("../index.html")),
            "/dashboard.js" => asset(
                "text/javascript;charset=utf-8",
                include_str!("../dashboard.js"),
            ),
            "/panel-ui.js" => asset(
                "text/javascript;charset=utf-8",
                include_str!("../panel-ui.js"),
            ),
            "/api/config" => match state.repo.read().and_then(|s| s.view(None)) {
                Ok(v) => json(v),
                Err(e) => error(StatusCode::BAD_REQUEST, e),
            },
            _ => error(StatusCode::NOT_FOUND, "Not found"),
        };
    }
    if req.method() != Method::POST {
        return error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
    }
    if req.headers().get("x-panel").and_then(|v| v.to_str().ok()) != Some("1") {
        return error(StatusCode::FORBIDDEN, "Missing panel header");
    }
    if let Some(origin) = req.headers().get("origin").and_then(|v| v.to_str().ok())
        && origin != format!("http://{host}")
    {
        return error(StatusCode::FORBIDDEN, "Forbidden origin");
    }
    if ![
        "/api/config",
        "/api/profiles",
        "/api/status",
        "/api/run",
        "/api/upload",
    ]
    .contains(&path.as_str())
    {
        return error(StatusCode::NOT_FOUND, "Not found");
    }
    if path != "/api/status"
        && let Some(token) = state.status.lock().unwrap().take()
    {
        token.cancel();
    }
    let guard =
        match tokio::time::timeout(Duration::from_secs(2), state.gate.clone().lock_owned()).await {
            Ok(g) => g,
            Err(_) => {
                return error(
                    StatusCode::CONFLICT,
                    "Another panel action is active. Wait or cancel it first.",
                );
            }
        };
    match post(state, req, &path, guard).await {
        Ok(r) => r,
        Err(e) => error(StatusCode::BAD_REQUEST, format!("{e:#}")),
    }
}

struct CancelOnDrop(CancellationToken);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}
struct OutputStream {
    rx: mpsc::Receiver<String>,
    cancel: CancellationToken,
}
impl Stream for OutputStream {
    type Item = Result<Bytes, Infallible>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx).map(|s| s.map(|s| Ok(Bytes::from(s))))
    }
}
impl Drop for OutputStream {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

fn stream_action(
    c: Value,
    action: String,
    params: Value,
    guard: OwnedMutexGuard<()>,
    upload: Option<Upload>,
    cancel: CancellationToken,
) -> Response {
    let (tx, rx) = mpsc::channel(32);
    let worker_cancel = cancel.clone();
    tokio::spawn(async move {
        let _guard = guard;
        let result = if let Some(upload) = upload {
            send_upload(&c, &upload, tx.clone(), worker_cancel.clone()).await
        } else {
            execute(&c, &action, &params, tx.clone(), worker_cancel.clone()).await
        };
        let code = match result {
            Ok(code) => code,
            Err(e) => {
                let mut r = process::Redactor::new(process::masks(&c));
                let s = r.push(format!("✖ {e:#}\n").as_bytes(), true);
                let _ = tx.send(s).await;
                1
            }
        };
        let result = if code == 0 {
            "\n✔ Done\n".into()
        } else {
            format!("\n✖ Failed (exit {code})\n")
        };
        let _ = tx.send(result).await;
    });
    (
        [
            (axum::http::header::CONTENT_TYPE, "text/plain;charset=utf-8"),
            (axum::http::header::CACHE_CONTROL, "no-cache"),
        ],
        Body::from_stream(OutputStream { rx, cancel }),
    )
        .into_response()
}

async fn collect_ssh(
    c: &Value,
    shell: &str,
    cancel: CancellationToken,
    timeout: Duration,
) -> (i32, String) {
    let (tx, mut rx) = mpsc::channel(32);
    let process = process::ssh(c, shell, tx, cancel, timeout);
    tokio::pin!(process);
    let mut output = String::new();
    let code = loop {
        tokio::select! {code=&mut process=>break code,Some(s)=rx.recv()=>{output.push_str(&s);if output.len()>65536{let mut cut=output.len()-65536;while !output.is_char_boundary(cut){cut+=1;}output.drain(..cut);}}}
    };
    while let Ok(s) = rx.try_recv() {
        output.push_str(&s);
    }
    (code, output)
}

async fn post(
    state: AppState,
    req: Request,
    path: &str,
    guard: OwnedMutexGuard<()>,
) -> Result<Response> {
    if path == "/api/upload" {
        if req
            .headers()
            .get("content-length")
            .and_then(|s| s.to_str().ok())
            .and_then(|s| s.parse::<usize>().ok())
            .is_some_and(|n| n > MAX_UPLOAD)
        {
            return Ok(error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Upload limit is 64 MiB per file",
            ));
        }
        let target = decode(
            req.headers()
                .get("x-target")
                .and_then(|v| v.to_str().ok())
                .unwrap_or(""),
        )?;
        if !target.starts_with('/')
            || target.contains("..")
            || !target
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "/_. @+-".contains(c))
        {
            bail!("Invalid absolute Linux upload destination");
        }
        let cfg: Value = serde_json::from_str(&decode(
            req.headers()
                .get("x-cfg")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("%7B%7D"),
        )?)?;
        let c = resolved(&state.repo.read()?, &cfg)?;
        if text(&c, "host").is_empty() {
            bail!("Set the host / IP first");
        }
        let temp = tempfile::tempdir()?;
        let file = temp.path().join("file");
        let mut dest = tokio::fs::File::create(&file).await?;
        let mut size = 0usize;
        let mut chunks = req.into_body().into_data_stream();
        while let Some(chunk) = chunks.next().await {
            let chunk = chunk?;
            size += chunk.len();
            if size > MAX_UPLOAD {
                return Ok(error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Upload limit is 64 MiB per file",
                ));
            }
            dest.write_all(&chunk).await?;
        }
        dest.flush().await?;
        drop(dest);
        return Ok(stream_action(
            c,
            "upload".into(),
            json!({}),
            guard,
            Some(Upload {
                _temp: temp,
                file,
                target,
            }),
            state.shutdown.child_token(),
        ));
    }
    let bytes = to_bytes(req.into_body(), 1024 * 1024)
        .await
        .context("JSON body exceeds limit or could not be read")?;
    let b: Value = serde_json::from_slice(&bytes).context("Invalid JSON body")?;
    if !b.is_object() {
        bail!("JSON body must be an object");
    }
    let mut store = state.repo.read()?;
    match path {
        "/api/config" => {
            let next = store.update(&b)?;
            state.repo.write(&next)?;
            Ok(json(next.view(b["botId"].as_str())?))
        }
        "/api/profiles" => {
            match text(&b, "action") {
                "add" => store.add(&b)?,
                "duplicate" => store.duplicate(&b)?,
                "select" => {
                    let id = text(&b, "id");
                    store.bot(id)?;
                    store.active_bot_id = id.into();
                }
                "remove" => {
                    let id = text(&b, "id");
                    let c = store.active(Some(id))?;
                    if text(&b, "revision") != store.revision(id)? {
                        bail!("Bot or server settings changed. Reopen the removal dialog.");
                    }
                    let mode = text(&b, "mode");
                    if !["profile", "uninstall", "delete"].contains(&mode) {
                        bail!("Choose a removal mode");
                    }
                    if b["confirmation"] != c["app"] {
                        bail!("Type the selected bot PM2 app name to confirm removal");
                    }
                    if mode == "delete" && b["deleteFilesConfirmed"] != true {
                        bail!("Confirm permanent deletion of bot files");
                    }
                    let mut output = String::new();
                    if mode != "profile" {
                        if text(&c, "host").is_empty() {
                            bail!("Set the host / IP before server cleanup");
                        }
                        let others = store
                            .bots
                            .iter()
                            .filter(|bot| bot.id != id)
                            .map(|b| b.dir.clone())
                            .collect::<Vec<_>>();
                        let shell = scripts::removal(&c, &others, mode == "delete")?;
                        let cancel = state.shutdown.child_token();
                        let _scope = CancelOnDrop(cancel.clone());
                        let (code, out) = collect_ssh(&c, &shell, cancel, Duration::ZERO).await;
                        output = out;
                        if code != 0 {
                            return Ok((StatusCode::BAD_REQUEST,axum::Json(json!({"error":"Server cleanup failed. Profile kept; remote changes may already have completed.","output":output}))).into_response());
                        }
                    }
                    store.remove(id)?;
                    state.repo.write(&store)?;
                    let mut v = store.view(None)?;
                    v["output"] = json!(output);
                    return Ok(json(v));
                }
                _ => bail!("Unknown profile action"),
            }
            state.repo.write(&store)?;
            Ok(json(store.view(None)?))
        }
        "/api/status" => {
            let c = resolved(&store, &b["cfg"])?;
            if text(&c, "host").is_empty() {
                bail!("Set the host / IP first");
            }
            let cancel = state.shutdown.child_token();
            *state.status.lock().unwrap() = Some(cancel.clone());
            let _scope = CancelOnDrop(cancel.clone());
            let (code, output) =
                collect_ssh(&c, scripts::STATUS, cancel, Duration::from_secs(45)).await;
            Ok(json(scripts::parse_status(&output, code, text(&c, "app"))))
        }
        "/api/run" => {
            let mut c = resolved(&store, &b["cfg"])?;
            let action = text(&b, "action");
            if action == "solo" {
                c["otherApps"] = json!(
                    store
                        .bots
                        .iter()
                        .filter(|bot| bot.id != text(&c, "id"))
                        .map(|b| b.app.clone())
                        .collect::<Vec<_>>()
                );
            }
            if action != "fixkey" && text(&c, "host").is_empty() {
                bail!("Set the host / IP first");
            }
            Ok(stream_action(
                c,
                action.into(),
                b["params"].clone(),
                guard,
                None,
                state.shutdown.child_token(),
            ))
        }
        _ => bail!("Unknown endpoint"),
    }
}

struct Upload {
    _temp: tempfile::TempDir,
    file: PathBuf,
    target: String,
}
async fn send_upload(
    c: &Value,
    upload: &Upload,
    tx: mpsc::Sender<String>,
    cancel: CancellationToken,
) -> Result<i32> {
    let parent = upload
        .target
        .rsplit_once('/')
        .map(|p| p.0)
        .filter(|s| !s.is_empty())
        .unwrap_or("/");
    let code = process::ssh(
        c,
        &format!("mkdir -p {}", q(parent)),
        tx.clone(),
        cancel.clone(),
        Duration::ZERO,
    )
    .await;
    if code != 0 {
        return Ok(code);
    }
    let code = process::scp(c, &upload.file, &upload.target, tx.clone(), cancel.clone()).await;
    if code != 0 {
        return Ok(code);
    }
    let mode = if upload.target.ends_with(".env") {
        format!("chmod 600 {}; ", q(&upload.target))
    } else {
        String::new()
    };
    Ok(process::ssh(
        c,
        &format!("{mode}ls -l {}", q(&upload.target)),
        tx,
        cancel,
        Duration::ZERO,
    )
    .await)
}
async fn execute(
    c: &Value,
    action: &str,
    p: &Value,
    tx: mpsc::Sender<String>,
    cancel: CancellationToken,
) -> Result<i32> {
    match action {
        "fixkey" => {
            let key = text(c, "key");
            if key.is_empty() || !Path::new(key).is_file() {
                bail!("Private key file not found");
            }
            let code = process::run(
                "icacls",
                &[key.into(), "/inheritance:r".into()],
                None,
                process::masks(c),
                tx.clone(),
                cancel.clone(),
                Duration::ZERO,
            )
            .await;
            if code != 0 {
                return Ok(code);
            }
            let user = std::env::var("USERNAME").context("Windows username unavailable")?;
            Ok(process::run(
                "icacls",
                &[key.into(), "/grant:r".into(), format!("{user}:R")],
                None,
                process::masks(c),
                tx,
                cancel,
                Duration::ZERO,
            )
            .await)
        }
        "env" => {
            let file = Path::new(text(c, "localEnv"));
            if !file.is_file() {
                bail!("Local .env file not found. Set its path in the sidebar.");
            }
            let code = process::scp(
                c,
                file,
                &format!("{}/.env", text(c, "dir")),
                tx.clone(),
                cancel.clone(),
            )
            .await;
            if code != 0 {
                return Ok(code);
            }
            Ok(process::ssh(
                c,
                &format!(
                    "{}chmod 600 \"$DIR/.env\"; echo \"✔ .env uploaded\"",
                    scripts::header(c)
                ),
                tx,
                cancel,
                Duration::ZERO,
            )
            .await)
        }
        "code" => {
            let source = Path::new(text(c, "localBot"));
            if !source.is_dir() {
                bail!("Local bot folder not found");
            }
            let temp = tempfile::tempdir()?;
            let archive = temp.path().join("bot-upload.tgz");
            let args = vec![
                "--exclude=node_modules".into(),
                "--exclude=.git".into(),
                "--exclude=dist".into(),
                "--exclude=.env".into(),
                "--exclude=*.db*".into(),
                "-czf".into(),
                archive.to_string_lossy().into_owned(),
                "-C".into(),
                source.to_string_lossy().into_owned(),
                ".".into(),
            ];
            let code = process::run(
                "tar",
                &args,
                None,
                process::masks(c),
                tx.clone(),
                cancel.clone(),
                Duration::ZERO,
            )
            .await;
            if code != 0 {
                return Ok(code);
            }
            let remote = format!("/tmp/bot-panel-{}.tgz", uuid::Uuid::new_v4());
            let code = process::scp(c, &archive, &remote, tx.clone(), cancel.clone()).await;
            if code != 0 {
                return Ok(code);
            }
            let shell = format!(
                "set -e\ntrap 'rm -f -- {}' EXIT\n{}mkdir -p \"$DIR\"\ntar xzf {} -C \"$DIR\"\nrm -f -- {}\n{}",
                q(&remote),
                scripts::header(c),
                q(&remote),
                q(&remote),
                scripts::script(c, "redeploy", &json!({}))?
            );
            Ok(process::ssh(c, &shell, tx, cancel, Duration::ZERO).await)
        }
        _ => Ok(process::ssh(
            c,
            &scripts::script(c, action, p)?,
            tx,
            cancel,
            Duration::ZERO,
        )
        .await),
    }
}
