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

#[test]
fn copied_local_paths_work_in_legacy_and_version_two_configs() {
    for (pasted, expected) in [
        (
            r#""C:\Users\A Person\ssh-key.key""#,
            r"C:\Users\A Person\ssh-key.key",
        ),
        (
            " \t\"C:\\Bots\\Música bot\\.env\"\r\n",
            "C:\\Bots\\Música bot\\.env",
        ),
        (
            r#""\\server\shared folder\bot""#,
            r"\\server\shared folder\bot",
        ),
        (r"C:\Users\O'Brien\bot", r"C:\Users\O'Brien\bot"),
        (" \" folder with spaces \" ", " folder with spaces "),
        (r#""C:\unfinished"#, r#""C:\unfinished"#),
        ("", ""),
        ("\"\"", ""),
    ] {
        let legacy = json!({"key":pasted,"localEnv":pasted,"localBot":pasted});
        let version_two = json!({"version":2,"server":{"key":pasted},"activeBotId":"first","bots":[
            {"id":"first","app":"first","dir":"/home/opc/first","localEnv":pasted,"localBot":pasted},
            {"id":"second","app":"second","dir":"/home/opc/second","localEnv":pasted,"localBot":pasted}
        ]});
        for raw in [legacy, version_two] {
            let store = Store::normalize(raw).unwrap();
            assert_eq!(store.server.key, expected);
            for bot in &store.bots {
                assert_eq!(bot.local_env, expected);
                assert_eq!(bot.local_bot, expected);
            }
            let unchanged = store.update(&json!({})).unwrap();
            assert_eq!(unchanged.server.key, expected);
            assert_eq!(unchanged.bots[0].local_env, expected);
            assert_eq!(unchanged.bots[0].local_bot, expected);
        }
    }
}

#[test]
fn updated_local_paths_are_ready_for_actions_and_persist_without_quotes() {
    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("key with spaces.key");
    std::fs::write(&key, "test fixture, not a private key").unwrap();
    let pasted = format!("  \"{}\"  ", key.display());
    let command = r#"echo "keep these quotes""#;
    let token = r#""keep-this-token-verbatim""#;
    let store = Store::normalize(json!({}))
        .unwrap()
        .update(&json!({
            "key":pasted,"localEnv":pasted,"localBot":format!("\"{}\"",dir.path().display()),
            "buildCmd":command,"token":token
        }))
        .unwrap();
    let active = store.active(None).unwrap();
    assert!(std::path::Path::new(active["key"].as_str().unwrap()).is_file());
    assert!(std::path::Path::new(active["localEnv"].as_str().unwrap()).is_file());
    assert!(std::path::Path::new(active["localBot"].as_str().unwrap()).is_dir());
    assert_eq!(active["buildCmd"], command);
    assert_eq!(active["token"], token);
    let repo = Repository {
        path: dir.path().join("config.json"),
    };
    repo.write(&store).unwrap();
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&repo.path).unwrap()).unwrap();
    assert_eq!(saved["server"]["key"], key.to_str().unwrap());
    assert_eq!(repo.read().unwrap().server.key, key.to_str().unwrap());
}
