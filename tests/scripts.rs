use oracle_bot_panel::scripts;
use serde_json::Value;

#[test]
fn every_remote_action_preserves_original_command_behavior() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("fixtures/scripts.json")).unwrap();
    for case in cases {
        assert_eq!(
            scripts::script(
                &case["config"],
                case["action"].as_str().unwrap(),
                &case["params"]
            )
            .unwrap(),
            case["want"].as_str().unwrap(),
            "action={} managed={}",
            case["action"],
            case["config"]["managed"]
        );
    }
}

#[test]
fn generated_pm2_and_removal_preserve_safety_contracts() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("fixtures/scripts.json")).unwrap();
    let c = &cases[0]["config"];
    assert_eq!(
        scripts::ecosystem(c),
        include_str!("fixtures/ecosystem.cjs")
    );
    for delete in [true, false] {
        let want = if delete {
            include_str!("fixtures/removal-true.sh")
        } else {
            include_str!("fixtures/removal-false.sh")
        };
        assert_eq!(
            scripts::removal(c, &["/home/opc/bots/other".into()], delete).unwrap(),
            want
        );
    }
}

#[test]
fn values_are_quoted_and_never_reexpanded_as_template_markers() {
    let c = serde_json::json!({"app":"safe","dir":"/home/opc/bot's folder","branch":"main","buildCmd":"echo '{{sync_cmd}}'","cmdSyncCmd":"echo synced"});
    let output = scripts::script(&c, "redeploy", &serde_json::json!({})).unwrap();
    assert!(output.contains("DIR='/home/opc/bot'\\''s folder'"));
    assert!(output.contains("echo '{{sync_cmd}}'"));
    assert!(output.contains("echo synced"));
}

#[test]
fn status_maps_only_the_selected_pm2_application() {
    let output = "@@UP up 2 days\n@@LOAD 0.1 0.2 0.3\n@@MEM 100/1024 MB\n@@DISK 1G/20G (5%)\n@@PM2 [{\"name\":\"music\",\"pm2_env\":{\"status\":\"online\",\"pm_uptime\":123,\"restart_time\":2},\"monit\":{\"memory\":456,\"cpu\":1}}]\n";
    let result = scripts::parse_status(output, 0, "music");
    assert_eq!(result["app"]["restarts"], 2);
    assert_eq!(result["app"]["mem"], 456);
    assert_eq!(result["load"], "0.1 0.2 0.3");
    assert!(scripts::parse_status(output, 0, "absent")["app"].is_null());
    assert!(
        scripts::parse_status("ssh failed", 255, "music")["error"]
            .as_str()
            .unwrap()
            .contains("ssh failed")
    );
}
