use anyhow::{Context, Result};
use oracle_bot_panel::{cli::Options, profiles::Repository};

#[tokio::main]
async fn main() {
    if let Err(e) = start().await {
        eprintln!("Control panel could not start: {e:#}");
        std::process::exit(1);
    }
}

async fn start() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        println!(
            "Oracle bot control panel {}\n\nUsage: oracle-bot-panel [--config PATH] [--port PORT] [--no-browser]\n\nConfiguration defaults to config.json beside this executable.\nOpenSSH (ssh/scp) and tar must be available for remote operations.\nThe panel binds only to 127.0.0.1; keep the terminal open while using it.",
            env!("CARGO_PKG_VERSION")
        );
        return Ok(());
    }
    if args == ["--version"] {
        println!("oracle-bot-panel {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let options = Options::parse(&args, &std::env::current_exe()?)?;
    let repo = Repository {
        path: options.config.clone(),
    };
    repo.read().context("Configuration could not be loaded")?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, options.port))
        .await
        .with_context(|| {
            format!(
                "Port {} is unavailable. Stop the previous panel or select --port.",
                options.port
            )
        })?;
    let url = format!("http://localhost:{}", options.port);
    println!(
        "Oracle bot control panel {}\nOpen {url}\nSettings: {}\nPress Ctrl+C to stop.",
        env!("CARGO_PKG_VERSION"),
        options.config.display()
    );
    if options.browser {
        open_browser(&url);
    }
    let shutdown = tokio_util::sync::CancellationToken::new();
    let signal = shutdown.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        signal.cancel();
    });
    oracle_bot_panel::http::serve(listener, repo, shutdown).await?;
    Ok(())
}
fn open_browser(url: &str) {
    let url = url.to_owned();
    std::thread::spawn(move || {
        #[cfg(windows)]
        let mut command = {
            use std::os::windows::process::CommandExt;
            let mut c = std::process::Command::new("rundll32.exe");
            c.args(["url.dll,FileProtocolHandler", &url])
                .creation_flags(0x08000000);
            c
        };
        #[cfg(target_os = "macos")]
        let mut command = {
            let mut c = std::process::Command::new("open");
            c.arg(&url);
            c
        };
        #[cfg(all(not(windows), not(target_os = "macos")))]
        let mut command = {
            let mut c = std::process::Command::new("xdg-open");
            c.arg(&url);
            c
        };
        if let Err(e) = command.status() {
            eprintln!("Open {url} in your browser ({e})");
        }
    });
}
