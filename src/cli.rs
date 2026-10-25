use anyhow::{Context, Result, bail};
use std::path::{Path, PathBuf};
pub struct Options {
    pub config: PathBuf,
    pub port: u16,
    pub browser: bool,
}
impl Options {
    pub fn parse(args: &[String], exe: &Path) -> Result<Self> {
        let mut options = Self {
            config: exe
                .parent()
                .context("Executable has no parent folder")?
                .join("config.json"),
            port: 4321,
            browser: true,
        };
        let mut args = args.iter();
        while let Some(flag) = args.next() {
            match flag.as_str() {
                "--config" => {
                    options.config = args.next().context("--config requires a path")?.into()
                }
                "--port" => {
                    options.port = args
                        .next()
                        .context("--port requires a number")?
                        .parse()
                        .context("Invalid port")?;
                    if options.port == 0 {
                        bail!("Port must be between 1 and 65535");
                    }
                }
                "--no-browser" => options.browser = false,
                _ => bail!("Unknown option {flag}. Use --help for usage."),
            }
        }
        Ok(options)
    }
}
