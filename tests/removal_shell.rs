use oracle_bot_panel::scripts;
use serde_json::json;
use std::{path::Path, process::Command};
fn posix(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        format!("/{}{}", s[..1].to_lowercase(), &s[2..])
    } else {
        s
    }
}
#[test]
fn cleanup_executes_only_inside_the_selected_bot_folder() {
    let bash = if cfg!(windows) {
        "C:/Program Files/Git/bin/bash.exe"
    } else {
        "/bin/bash"
    };
    if !Path::new(bash).exists() {
        eprintln!("Bash unavailable; shell execution fixture skipped");
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("bots/music");
    let other = root.path().join("bots/other");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::create_dir_all(&other).unwrap();
    std::fs::write(dir.join(".env"), "secret").unwrap();
    std::fs::write(other.join("keep"), "keep").unwrap();
    let run = |target: String, others: Vec<String>, delete: bool| {
        let c = json!({"id":"music-id","app":"music","dir":target,"managed":true});
        let shell = scripts::removal(&c, &others, delete).unwrap();
        let prefix = format!(
            "export HOME={}; pm2(){{ if [ \"$1\" = jlist ]; then echo '[{{\"name\":\"music\"}},{{\"name\":\"other\"}}]'; else echo \"$*\"; fi; }}; ",
            scripts::q(&posix(root.path()))
        );
        Command::new(bash)
            .args(["--noprofile", "--norc", "-c", &(prefix + &shell)])
            .output()
            .unwrap()
    };
    let keep = run(posix(&dir), vec![], false);
    assert!(
        keep.status.success(),
        "{}",
        String::from_utf8_lossy(&keep.stderr)
    );
    let output = String::from_utf8_lossy(&keep.stdout);
    assert!(output.contains("delete music"));
    assert!(!output.contains("delete other"));
    assert!(dir.join(".env").exists());
    for target in [
        posix(root.path()),
        posix(&root.path().join("bots")),
        posix(&root.path().join(".ssh")),
        "/etc".into(),
        "/".into(),
    ] {
        let result = run(target, vec![posix(&other)], true);
        assert!(!result.status.success());
        assert!(!String::from_utf8_lossy(&result.stdout).contains("save --force"));
    }
    assert!(
        !run(posix(&dir), vec![posix(&dir.join("nested"))], true)
            .status
            .success()
    );
    #[cfg(unix)]
    {
        let link = root.path().join("bots/link");
        std::os::unix::fs::symlink(&other, &link).unwrap();
        assert!(!run(posix(&link), vec![], true).status.success());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let link = root.path().join("bots/link");
        let result = Command::new("cmd")
            .raw_arg(format!(
                "/c mklink /J \"{}\" \"{}\"",
                link.display(),
                other.display()
            ))
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "Could not create junction fixture: {} {}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(!run(posix(&link), vec![], true).status.success());
    }
    let result = run(posix(&dir), vec![posix(&other)], true);
    assert!(
        result.status.success(),
        "{} {}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(!dir.exists());
    assert!(other.join("keep").exists());
    assert!(run(posix(&dir), vec![posix(&other)], true).status.success());
}
