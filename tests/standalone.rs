use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
struct ChildGuard(Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn request(port: u16, method: &str, path: &str, body: &str) -> String {
    let mut socket = TcpStream::connect(("127.0.0.1", port)).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    write!(socket,"{method} {path} HTTP/1.1\r\nHost: localhost:{port}\r\nX-Panel: 1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
    let mut response = String::new();
    socket.read_to_string(&mut response).unwrap();
    response
}
#[test]
fn copied_executable_serves_embedded_ui_and_writes_config_beside_it() {
    let dir = tempfile::tempdir().unwrap();
    let filename = if cfg!(windows) {
        "portable.exe"
    } else {
        "portable"
    };
    let exe = dir.path().join(filename);
    std::fs::copy(env!("CARGO_BIN_EXE_oracle-bot-panel"), &exe).unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let child = Command::new(&exe)
        .args(["--no-browser", "--port", &port.to_string()])
        .current_dir(std::env::temp_dir())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut child = ChildGuard(child);
    let start = Instant::now();
    while TcpStream::connect(("127.0.0.1", port)).is_err() {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "EXE exited during startup"
        );
        assert!(start.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(25));
    }
    for path in ["/", "/dashboard.js", "/panel-ui.js"] {
        let r = request(port, "GET", path, "");
        assert!(r.starts_with("HTTP/1.1 200"), "{r}");
        assert!(r.len() > 1000);
    }
    assert!(
        request(port, "POST", "/api/config", r#"{"name":"Portable"}"#).starts_with("HTTP/1.1 200")
    );
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("config.json")).unwrap()).unwrap();
    assert_eq!(saved["bots"][0]["name"], "Portable");
    let result = Command::new(&exe)
        .args(["--no-browser", "--port", &port.to_string()])
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("Port"));
}
