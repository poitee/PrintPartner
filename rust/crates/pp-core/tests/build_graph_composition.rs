use reqwest::Client;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
};

#[tokio::test]
async fn one_owner_fixture_mounts_authenticated_build_graph_with_drafts() {
    let mut random = [0; 16];
    getrandom::fill(&mut random).unwrap();
    let directory =
        std::env::temp_dir().join(format!("pp-build-composition-{}", hex::encode(random)));
    let mut child = Command::new(env!("CARGO_BIN_EXE_drafts-http-fixture"))
        .arg(&directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let startup: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(startup["writer_owners"], 1);
    let origin = startup["origin"].as_str().unwrap();
    let client = Client::builder().no_proxy().build().unwrap();
    let registered = client
        .post(format!("{origin}/auth/register"))
        .header("Origin", origin)
        .json(&json!({"email":"composition@example.test","password":"composition-password-123"}))
        .send()
        .await
        .unwrap();
    assert_eq!(registered.status(), 200);
    let cookie = registered.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    let created = client
        .post(format!("{origin}/plans"))
        .header("Origin", origin)
        .header("Cookie", cookie)
        .json(&json!({"name":"Composed Build"}))
        .send()
        .await
        .unwrap();
    assert_eq!(created.status(), 200);
    let created: Value = created.json().await.unwrap();
    assert_eq!(created["name"], "Composed Build");
    let drafts = client
        .get(format!("{origin}/plans/{}/drafts", created["id"]))
        .header("Origin", origin)
        .header("Cookie", cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(drafts.status(), 200);
    child.stdin.take().unwrap().write_all(b"\n").unwrap();
    assert!(child.wait().unwrap().success());
    std::fs::remove_dir_all(directory).unwrap();
}
