use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use oracle_bot_panel::{http::app, profiles::Repository};
use serde_json::{Value, json};
use tower::ServiceExt;

fn fixture() -> (tempfile::TempDir, axum::Router) {
    let d = tempfile::tempdir().unwrap();
    let app = app(
        Repository {
            path: d.path().join("config.json"),
        },
        4321,
    );
    (d, app)
}
fn request(method: &str, url: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(url)
        .header("Host", "localhost:4321")
        .header("X-Panel", "1")
        .body(Body::from(body.to_string()))
        .unwrap()
}

#[tokio::test]
async fn embedded_assets_are_served_without_source_directory() {
    let (_d, app) = fixture();
    for path in ["/", "/dashboard.js", "/panel-ui.js"] {
        let r = app
            .clone()
            .oneshot(request("GET", path, json!({})))
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        assert!(r.into_body().collect().await.unwrap().to_bytes().len() > 1000);
    }
}

#[tokio::test]
async fn host_header_and_post_guard_are_enforced() {
    let (_d, app) = fixture();
    let r = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/config")
                .header("Host", "evil.test:4321")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
    let r = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/config")
                .header("Host", "localhost:4321")
                .body(Body::from("{}"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn config_duplicate_and_offline_removal_persist() {
    let (d, app) = fixture();
    let r = app
        .clone()
        .oneshot(request(
            "POST",
            "/api/config",
            json!({"name":"Source","repo":"https://example.test/bot","localEnv":"C:/secret.env"}),
        ))
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let r = app
        .clone()
        .oneshot(request(
            "POST",
            "/api/profiles",
            json!({"action":"duplicate","id":"legacy","name":"Copy"}),
        ))
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    let v: Value =
        serde_json::from_slice(&r.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(v["bots"].as_array().unwrap().len(), 2);
    assert_eq!(v["localEnv"], "");
    let id = v["activeBotId"].clone();
    let r=app.clone().oneshot(request("POST","/api/profiles",json!({"action":"remove","id":id,"revision":"stale","mode":"profile","confirmation":v["app"]}))).await.unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    let r=app.oneshot(request("POST","/api/profiles",json!({"action":"remove","id":id,"revision":v["removalRevision"],"mode":"profile","confirmation":v["app"]}))).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(
        Repository {
            path: d.path().join("config.json")
        }
        .read()
        .unwrap()
        .bots
        .len(),
        1
    );
}

#[tokio::test]
async fn malformed_json_and_unknown_routes_fail() {
    let (_d, app) = fixture();
    let r = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/config")
                .header("Host", "localhost:4321")
                .header("X-Panel", "1")
                .body(Body::from("{bad"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    let r = app
        .oneshot(request("GET", "/server.cjs", json!({})))
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn upload_limit_is_checked_before_allocating_body() {
    let (_d, app) = fixture();
    let req = Request::builder()
        .method("POST")
        .uri("/api/upload")
        .header("Host", "localhost:4321")
        .header("X-Panel", "1")
        .header("Content-Length", "67108865")
        .body(Body::empty())
        .unwrap();
    let r = app.oneshot(req).await.unwrap();
    assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn cross_origin_writes_are_rejected() {
    let (_d, app) = fixture();
    let mut req = request("POST", "/api/config", json!({"name":"changed"}));
    req.headers_mut()
        .insert("origin", "https://evil.test".parse().unwrap());
    assert_eq!(
        app.oneshot(req).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn incomplete_action_streams_release_the_operation_lock() {
    let (d, app) = fixture();
    let repo = Repository {
        path: d.path().join("config.json"),
    };
    let mut s = repo.read().unwrap();
    s.server.host = "example.test".into();
    repo.write(&s).unwrap();
    // Unknown action produces a streamed failure without ever invoking SSH.
    let r = app
        .clone()
        .oneshot(request("POST", "/api/run", json!({"action":"unknown"})))
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    drop(r);
    let r = app
        .oneshot(request(
            "POST",
            "/api/config",
            json!({"name":"after-cancel"}),
        ))
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::OK);
}

#[tokio::test]
async fn shutdown_is_bounded_even_with_an_incomplete_request_body() {
    use tokio::io::AsyncWriteExt;
    let dir = tempfile::tempdir().unwrap();
    let repo = Repository {
        path: dir.path().join("config.json"),
    };
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let shutdown = tokio_util::sync::CancellationToken::new();
    let worker = shutdown.clone();
    let mut server =
        tokio::spawn(async move { oracle_bot_panel::http::serve(listener, repo, worker).await });
    let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    socket.write_all(format!("POST /api/config HTTP/1.1\r\nHost: localhost:{port}\r\nX-Panel: 1\r\nContent-Length: 1000\r\n\r\n{{").as_bytes()).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    shutdown.cancel();
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), &mut server).await;
    if result.is_err() {
        server.abort();
    }
    assert!(
        result.is_ok(),
        "Shutdown waited indefinitely for the browser request"
    );
}
