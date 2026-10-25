use oracle_bot_panel::cli::Options;
use std::path::Path;
#[test]
fn portable_config_is_resolved_next_to_executable() {
    let o = Options::parse(&[], Path::new("/portable/oracle-bot-panel.exe")).unwrap();
    assert_eq!(o.config, Path::new("/portable/config.json"));
    assert_eq!(o.port, 4321);
    assert!(o.browser);
}
#[test]
fn flags_support_testing_without_opening_browser() {
    let args = [
        "--config",
        "fixture.json",
        "--port",
        "54321",
        "--no-browser",
    ]
    .map(String::from);
    let o = Options::parse(&args, Path::new("/portable/panel.exe")).unwrap();
    assert_eq!(o.config, Path::new("fixture.json"));
    assert_eq!(o.port, 54321);
    assert!(!o.browser);
    for bad in [
        vec!["--port", "0"],
        vec!["--port", "bad"],
        vec!["--config"],
        vec!["--unknown"],
    ] {
        assert!(
            Options::parse(
                &bad.into_iter().map(String::from).collect::<Vec<_>>(),
                Path::new("/panel.exe")
            )
            .is_err()
        );
    }
}
