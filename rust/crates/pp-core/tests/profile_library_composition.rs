use reqwest::{Client, Method};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Command, Stdio},
};

const NODE_FIXTURE: &str = include_str!("fixtures/profile-library-node.json");

fn directory() -> PathBuf {
    let mut random = [0; 12];
    getrandom::fill(&mut random).unwrap();
    std::env::temp_dir().join(format!("pp-profile-core-fixture-{}", hex::encode(random)))
}

#[tokio::test]
async fn actual_loopback_fixture_composes_auth_storage_and_profile_http() {
    let directory = directory();
    std::fs::create_dir_all(&directory).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_profiles-http-fixture"))
        .env("PP_PROFILE_FIXTURE_DATA_DIR", &directory)
        .env("PP_PROFILE_FIXTURE_LISTEN", "127.0.0.1:0")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let line = BufReader::new(child.stdout.take().unwrap())
        .lines()
        .next()
        .unwrap()
        .unwrap();
    let started: Value = serde_json::from_str(&line).unwrap();
    let origin = started["origin"].as_str().unwrap();
    let client = Client::builder().no_proxy().build().unwrap();
    let registration = client
        .post(format!("{origin}/auth/register"))
        .header("Origin", origin)
        .json(&json!({"email":"core-profile@example.test","password":"profile-password-123"}))
        .send()
        .await
        .unwrap();
    assert_eq!(registration.status(), 200);
    let cookie = registration.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let expected: Value = serde_json::from_str(NODE_FIXTURE).unwrap();
    let expected_keys = expected["profiles"][0]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    for path in ["/profile-library", "/api/v1/profile-library"] {
        let response = client
            .get(format!("{origin}{path}"))
            .header("Origin", origin)
            .header("Cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["profiles"].as_array().unwrap().len(), 12);
        for profile in body["profiles"].as_array().unwrap() {
            assert_eq!(
                profile
                    .as_object()
                    .unwrap()
                    .keys()
                    .cloned()
                    .collect::<BTreeSet<_>>(),
                expected_keys
            );
        }
        assert!(!body.to_string().contains("sourcePath"));
        assert!(!body.to_string().contains("resolvedFlatConfig"));
        let head = client
            .request(Method::HEAD, format!("{origin}{path}"))
            .header("Origin", origin)
            .header("Cookie", &cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(head.status(), 200);
        assert!(head.bytes().await.unwrap().is_empty());
    }
    unsafe {
        libc::kill(child.id() as i32, libc::SIGINT);
    }
    assert!(child.wait().unwrap().success());
    std::fs::remove_dir_all(directory).unwrap();
}
