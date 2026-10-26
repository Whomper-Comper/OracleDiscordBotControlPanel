use oracle_bot_panel::local_paths::LocalPaths;
use std::{fs, path::Path};

#[test]
fn relative_paths_use_the_config_parent_without_requiring_the_target_to_exist() {
    let dir = tempfile::tempdir().unwrap();
    let paths = LocalPaths::new(&dir.path().join("settings/config.json"), None).unwrap();
    assert_eq!(
        paths.resolve("../Música/bot").unwrap().unwrap(),
        dir.path().join("settings/../Música/bot")
    );
}

#[test]
fn relative_config_paths_are_based_on_the_current_directory() {
    let paths = LocalPaths::new(Path::new("settings/config.json"), None).unwrap();
    assert_eq!(
        paths.resolve("bot").unwrap().unwrap(),
        std::env::current_dir().unwrap().join("settings/bot")
    );
}

#[test]
fn copy_as_path_quotes_and_outer_whitespace_preserve_spaces_inside_quotes() {
    let dir = tempfile::tempdir().unwrap();
    let paths = LocalPaths::new(&dir.path().join("config.json"), None).unwrap();
    assert_eq!(
        paths
            .resolve(" \t\" Música folder /key \"\r\n")
            .unwrap()
            .unwrap(),
        dir.path().join(" Música folder /key ")
    );
    assert_eq!(
        paths.resolve("  key  ").unwrap().unwrap(),
        dir.path().join("  key  ")
    );
    for blank in ["", " \t\r\n", " \"\" "] {
        assert!(paths.resolve(blank).unwrap().is_none());
        let preview = paths.preview("key", blank);
        assert!(preview.resolved.is_empty());
        assert!(preview.error.is_none());
        assert!(preview.warning.is_none());
    }
}

#[test]
fn home_shortcuts_expand_only_complete_leading_tokens() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("Usuário Home");
    let paths = LocalPaths::new(&dir.path().join("config.json"), Some(home.clone())).unwrap();
    for shortcut in ["~", "%USERPROFILE%", "%userprofile%"] {
        assert_eq!(paths.resolve(shortcut).unwrap().unwrap(), home);
    }
    for shortcut in [
        "~/Música/key",
        "%USERPROFILE%/Música/key",
        "%UsErPrOfIlE%/Música/key",
    ] {
        assert_eq!(
            paths.resolve(shortcut).unwrap().unwrap(),
            home.join("Música/key")
        );
    }
    for literal in [
        "~someone/key",
        "~name",
        "%USERPROFILE%suffix",
        "%OTHER%/key",
        "nested/~/key",
        "nested/%USERPROFILE%/key",
    ] {
        assert_eq!(
            paths.resolve(literal).unwrap().unwrap(),
            dir.path().join(literal)
        );
    }
    #[cfg(windows)]
    for shortcut in [r"~\Música\key", r"%USERPROFILE%\Música\key"] {
        assert_eq!(
            paths.resolve(shortcut).unwrap().unwrap(),
            home.join("Música/key")
        );
    }
}

#[test]
fn missing_home_is_reported_only_when_a_supported_shortcut_needs_it() {
    let dir = tempfile::tempdir().unwrap();
    let paths = LocalPaths::new(&dir.path().join("config.json"), None).unwrap();
    for shortcut in ["~", "~/key", "%USERPROFILE%/key"] {
        assert!(
            paths
                .resolve(shortcut)
                .unwrap_err()
                .to_string()
                .to_lowercase()
                .contains("home")
        );
        assert!(paths.preview("key", shortcut).error.is_some());
    }
    assert_eq!(
        paths.resolve("~other/key").unwrap().unwrap(),
        dir.path().join("~other/key")
    );
}

#[test]
fn previews_and_operations_agree_on_existing_files_and_directories() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("private.key"), "private data").unwrap();
    fs::write(dir.path().join("bot.env"), "TOKEN=secret").unwrap();
    fs::create_dir(dir.path().join("bot")).unwrap();
    let paths = LocalPaths::new(&dir.path().join("config.json"), None).unwrap();
    for (field, value) in [("key", "private.key"), ("localEnv", "bot.env")] {
        let resolved = paths.require_file(value, "Local file").unwrap();
        let preview = paths.preview(field, value);
        assert_eq!(preview.resolved, resolved.to_string_lossy());
        assert!(preview.error.is_none());
        assert!(preview.warning.is_none());
    }
    let resolved = paths.require_dir("bot", "Local bot").unwrap();
    let preview = paths.preview("localBot", "bot");
    assert_eq!(preview.resolved, resolved.to_string_lossy());
    assert!(preview.error.is_none());
}

#[test]
fn missing_paths_and_wrong_kinds_are_distinguished_from_blank_fields() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("file"), "").unwrap();
    fs::create_dir(dir.path().join("folder")).unwrap();
    let paths = LocalPaths::new(&dir.path().join("config.json"), None).unwrap();
    for field in ["key", "localEnv", "localBot"] {
        let preview = paths.preview(field, "missing");
        assert_eq!(
            preview.resolved,
            dir.path().join("missing").to_string_lossy()
        );
        assert!(preview.error.unwrap().contains("does not exist"));
        assert!(paths.preview(field, "").error.is_none());
    }
    assert!(
        paths
            .preview("key", "folder")
            .error
            .unwrap()
            .contains("file")
    );
    assert!(
        paths
            .preview("localEnv", "folder")
            .error
            .unwrap()
            .contains("file")
    );
    assert!(
        paths
            .preview("localBot", "file")
            .error
            .unwrap()
            .contains("directory")
    );
    assert!(paths.require_file("folder", "SSH key").is_err());
    assert!(paths.require_dir("file", "Local bot").is_err());
    assert!(
        paths
            .require_file("", "SSH key")
            .unwrap_err()
            .to_string()
            .contains("SSH key")
    );
    assert!(paths.require_dir("", "Local bot").is_err());
}

#[test]
fn public_key_suffix_warns_without_blocking_file_use() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("identity.PUB"), "not inspected").unwrap();
    let paths = LocalPaths::new(&dir.path().join("config.json"), None).unwrap();
    let preview = paths.preview("key", "identity.PUB");
    assert!(preview.error.is_none());
    assert!(preview.warning.unwrap().contains("private"));
    assert!(paths.require_file("identity.PUB", "SSH key").is_ok());
    assert!(paths.preview("localEnv", "identity.PUB").warning.is_none());
}

#[test]
fn resolving_does_not_collapse_parent_segments() {
    let dir = tempfile::tempdir().unwrap();
    let paths = LocalPaths::new(&dir.path().join("settings/config.json"), None).unwrap();
    let resolved = paths.resolve("linked/../key").unwrap().unwrap();
    assert!(resolved.as_os_str().to_string_lossy().contains(".."));
    assert_eq!(resolved, dir.path().join("settings/linked/../key"));
}

#[cfg(windows)]
#[test]
fn ambiguous_windows_paths_are_rejected_but_absolute_and_unc_paths_are_supported() {
    let paths = LocalPaths::new(Path::new(r"C:\settings\config.json"), None).unwrap();
    for ambiguous in [r"C:key", "C:", r"\key", "/key"] {
        let error = paths.resolve(ambiguous).unwrap_err().to_string();
        assert!(
            error.contains("absolute") || error.contains("relative"),
            "{error}"
        );
        assert!(paths.preview("key", ambiguous).error.is_some());
    }
    for absolute in [r"C:\keys\key", r"\\server\share\key", "//server/share/key"] {
        assert_eq!(
            paths.resolve(absolute).unwrap().unwrap(),
            Path::new(absolute)
        );
    }
}

#[cfg(unix)]
#[test]
fn parent_segments_follow_the_filesystem_after_a_symlink() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("settings")).unwrap();
    fs::create_dir_all(dir.path().join("actual/child")).unwrap();
    fs::write(dir.path().join("actual/key"), "").unwrap();
    std::os::unix::fs::symlink(
        dir.path().join("actual/child"),
        dir.path().join("settings/link"),
    )
    .unwrap();
    let paths = LocalPaths::new(&dir.path().join("settings/config.json"), None).unwrap();
    assert_eq!(
        paths.require_file("link/../key", "SSH key").unwrap(),
        dir.path().join("settings/link/../key")
    );
}
