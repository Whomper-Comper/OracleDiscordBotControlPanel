use oracle_bot_panel::profiles::*;
use serde_json::json;

#[test]
fn legacy_migration_preserves_connection_and_bot() {
    let store = normalize(
        json!({"host":"example.test","app":"music","dir":"/home/opc/music","token":"private"}),
    )
    .unwrap();
    assert_eq!(store["server"]["token"], "private");
    assert_eq!(store["bots"][0]["app"], "music");
    assert_eq!(store["bots"][0]["managed"], false);
    assert_eq!(store["activeBotId"], "legacy");
}

#[test]
fn empty_fleet_remains_empty() {
    let raw = json!({"version":2,"server":{"host":"example.test"},"bots":[],"activeBotId":""});
    let store = normalize(raw).unwrap();
    assert_eq!(store["bots"], json!([]));
    assert_eq!(store["server"]["host"], "example.test");
}

#[test]
fn malformed_v2_is_rejected_instead_of_migrated() {
    assert!(normalize(json!({"version":2,"bots":"bad"})).is_err());
}

#[test]
fn duplicate_copies_only_deployment_and_generates_new_identity() {
    let mut s=Store::normalize(json!({"localEnv":"C:/secret.env","localBot":"C:/source","repo":"https://example.test/bot","buildCmd":"custom-build","cmdSyncCmd":"sync","token":"secret"})).unwrap();
    let source = s.bots[0].clone();
    s.duplicate(&json!({"id":"legacy","name":"Música"}))
        .unwrap();
    let b = &s.bots[1];
    assert_ne!(b.id, source.id);
    assert_eq!(b.app, "musica");
    assert!(b.managed);
    assert_eq!(b.build_cmd, "custom-build");
    assert_eq!(b.local_env, "");
    assert_eq!(b.local_bot, "");
    assert_eq!(s.server.token, "secret");
    assert_eq!(s.bots[0].local_env, "C:/secret.env");
    assert!(
        s.duplicate(&json!({"id":"legacy","name":"bad","repo":false}))
            .is_err()
    );
}

#[test]
fn updates_validate_collisions_and_cannot_overwrite_identity() {
    let mut s = Store::normalize(json!({})).unwrap();
    s.add(&json!({"name":"Second"})).unwrap();
    assert!(s.update(&json!({"app":"my-bot"})).is_err());
    assert!(
        s.update(&json!({"dir":"/home/opc/bots/my-bot/nested"}))
            .is_err()
    );
    assert!(s.update(&json!({"dir":"/home/opc/../danger"})).is_err());
    let updated = s
        .update(&json!({"id":"overwrite","managed":false,"name":"Renamed"}))
        .unwrap();
    assert_eq!(updated.bots[1].id, s.bots[1].id);
    assert!(updated.bots[1].managed);
}

#[test]
fn repository_backs_up_once_preserves_invalid_file_and_empty_fleet() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    std::fs::write(&path, r#"{"host":"example.test"}"#).unwrap();
    let repo = Repository { path: path.clone() };
    let mut s = repo.read().unwrap();
    repo.write(&s).unwrap();
    s.remove("legacy").unwrap();
    repo.write(&s).unwrap();
    assert!(repo.read().unwrap().bots.is_empty());
    assert_eq!(
        std::fs::read_to_string(dir.path().join("config.json.pre-profiles.bak")).unwrap(),
        r#"{"host":"example.test"}"#
    );
    std::fs::write(&path, "broken").unwrap();
    assert!(repo.read().is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), "broken");
}

#[test]
fn repository_reads_utf8_bom_from_windows_editors() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let original = b"\xef\xbb\xbf{\"host\":\"example.test\",\"name\":\"Windows config\"}";
    std::fs::write(&path, original).unwrap();
    let repo = Repository { path: path.clone() };
    let store = repo.read().unwrap();
    assert_eq!(store.server.host, "example.test");
    assert_eq!(store.bots[0].name, "Windows config");
    repo.write(&store).unwrap();
    assert_eq!(repo.read().unwrap().bots[0].name, "Windows config");
    assert_eq!(
        std::fs::read(dir.path().join("config.json.pre-profiles.bak")).unwrap(),
        original
    );
}
