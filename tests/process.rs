use oracle_bot_panel::process::{Redactor, run};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[test]
fn redacts_split_secrets_without_corrupting_utf8() {
    let input = "hello secret 🔒 goodbye".as_bytes();
    for chunk in 1..12 {
        let mut redactor = Redactor::new(vec!["secret".into()]);
        let mut output = String::new();
        for part in input.chunks(chunk) {
            output += &redactor.push(part, false);
        }
        output += &redactor.push(&[], true);
        assert_eq!(output, "hello *** 🔒 goodbye");
    }
}

#[test]
fn malformed_utf8_cannot_hide_the_start_of_a_secret() {
    for lead in [0xc2, 0xe1, 0xf1] {
        let mut input = vec![lead];
        input.extend_from_slice(b"secret");
        for chunk in 1..8 {
            let mut redactor = Redactor::new(vec!["secret".into()]);
            let mut output = String::new();
            for part in input.chunks(chunk) {
                output += &redactor.push(part, false);
            }
            output += &redactor.push(&[], true);
            assert!(!output.contains("secret"), "{output}");
            assert!(output.contains("***"));
        }
    }
}

#[cfg(windows)]
#[tokio::test]
async fn cancelling_a_parent_also_stops_its_local_descendant() {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, WAIT_TIMEOUT},
        System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, WaitForSingleObject},
    };
    let (tx, mut rx) = mpsc::channel(32);
    let cancel = CancellationToken::new();
    let worker_cancel = cancel.clone();
    let args=vec!["-NoProfile".into(),"-NonInteractive".into(),"-Command".into(),"$taskProcess=Start-Process ping.exe -ArgumentList '-t','127.0.0.1' -WindowStyle Hidden -PassThru; Write-Output $taskProcess.Id; Start-Sleep -Seconds 30".into()];
    let job = tokio::spawn(async move {
        run(
            "powershell.exe",
            &args,
            None,
            vec![],
            tx,
            worker_cancel,
            Duration::ZERO,
        )
        .await
    });
    let mut output = String::new();
    let pid = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            output += &rx.recv().await.unwrap();
            if let Ok(pid) = output.trim().parse::<u32>() {
                break pid;
            }
        }
    })
    .await
    .unwrap();
    cancel.cancel();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), job)
            .await
            .unwrap()
            .unwrap(),
        1
    );
    let alive = unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | 0x00100000, 0, pid);
        if handle.is_null() {
            false
        } else {
            let alive = WaitForSingleObject(handle, 2000) == WAIT_TIMEOUT;
            CloseHandle(handle);
            alive
        }
    };
    if alive {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .output();
    }
    assert!(!alive, "Cancelling left local descendant {pid} running");
}

#[tokio::test]
async fn runs_and_masks_a_real_process() {
    let (tx, mut rx) = mpsc::channel(32);
    let (exe, args) = if cfg!(windows) {
        ("cmd", vec!["/c".into(), "echo secret".into()])
    } else {
        ("sh", vec!["-c".into(), "echo secret".into()])
    };
    let code = run(
        exe,
        &args,
        None,
        vec!["secret".into()],
        tx,
        CancellationToken::new(),
        Duration::from_secs(5),
    )
    .await;
    let mut output = String::new();
    while let Some(s) = rx.recv().await {
        output += &s;
    }
    assert_eq!(code, 0);
    assert_eq!(output.trim(), "***");
}

#[tokio::test]
async fn empty_relative_parent_uses_the_current_directory() {
    let (tx, mut rx) = mpsc::channel(8);
    let (exe, args) = if cfg!(windows) {
        ("cmd", vec!["/c".into(), "echo relative-path".into()])
    } else {
        ("sh", vec!["-c".into(), "echo relative-path".into()])
    };
    let code = run(
        exe,
        &args,
        Some(std::path::Path::new("")),
        vec![],
        tx,
        CancellationToken::new(),
        Duration::from_secs(3),
    )
    .await;
    let mut output = String::new();
    while let Some(s) = rx.recv().await {
        output += &s;
    }
    assert_eq!(code, 0, "{output}");
    assert!(output.contains("relative-path"));
}

#[tokio::test]
async fn cancelled_process_never_starts() {
    let cancel = CancellationToken::new();
    cancel.cancel();
    let (tx, _) = mpsc::channel(2);
    assert_ne!(
        run(
            "must-not-run",
            &[],
            None,
            vec![],
            tx,
            cancel,
            Duration::from_secs(1)
        )
        .await,
        0
    );
}

#[tokio::test]
async fn timeout_terminates_a_running_child() {
    let (tx, mut rx) = mpsc::channel(32);
    let start = std::time::Instant::now();
    let (exe, args) = if cfg!(windows) {
        ("ping", vec!["-t".into(), "127.0.0.1".into()])
    } else {
        ("sleep", vec!["30".into()])
    };
    let code = run(
        exe,
        &args,
        None,
        vec![],
        tx,
        CancellationToken::new(),
        Duration::from_millis(150),
    )
    .await;
    assert_eq!(code, 124);
    assert!(start.elapsed() < Duration::from_secs(3));
    let mut output = String::new();
    while let Some(s) = rx.recv().await {
        output += &s;
    }
    assert!(output.contains("timed out"));
}

#[tokio::test]
async fn disconnect_terminates_child_instead_of_hanging() {
    let (tx, rx) = mpsc::channel(2);
    let cancel = CancellationToken::new();
    let other = cancel.clone();
    let (exe, args) = if cfg!(windows) {
        ("ping", vec!["-t".into(), "127.0.0.1".into()])
    } else {
        ("sleep", vec!["30".into()])
    };
    let job =
        tokio::spawn(
            async move { run(exe, &args, None, vec![], tx, cancel, Duration::ZERO).await },
        );
    tokio::time::sleep(Duration::from_millis(100)).await;
    drop(rx);
    other.cancel();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), job)
            .await
            .unwrap()
            .unwrap(),
        1
    );
}
