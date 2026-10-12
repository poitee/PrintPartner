use super::*;
use crate::Limits;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

#[test]
fn bounded_auth_workers_and_cancelled_queue_do_not_write() {
    let directory = std::env::temp_dir().join(format!(
        "pp-auth-queue-{}",
        hex::encode(rand::random::<[u8; 16]>())
    ));
    let (owner, _) = WriterOwner::open(
        &directory,
        Limits {
            queued_writes: 1,
            readers: 1,
        },
    )
    .unwrap();
    let client = owner.auth(FirstUserTenant::NewUser);
    // Capacity assertions must not compete with other tests using the global pool.
    let pool = Pool::new();
    let storage = owner.client();
    let held = storage.shared.queue.lock().unwrap();
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut replies = Vec::new();
    for _ in 0..35 {
        match client.submit_to_pool(
            Request::RequestReset {
                email: "queue@example.com".into(),
            },
            cancelled.clone(),
            Duration::ZERO,
            &pool,
        ) {
            Ok(reply) => replies.push(reply),
            Err(error) => {
                assert_eq!(error.to_string(), "Authentication queue full");
                break;
            }
        }
    }
    assert!((32..=34).contains(&replies.len()));
    cancelled.store(true, Ordering::Release);
    drop(held);
    for reply in replies {
        assert!(reply.recv_timeout(Duration::from_secs(5)).unwrap().is_err());
    }
    owner.shutdown().unwrap();
    let connection = Connection::open(directory.join("print-partner.db")).unwrap();
    let users: i64 = connection
        .query_row("SELECT count(*) FROM users", [], |row| row.get(0))
        .unwrap();
    let resets: i64 = connection
        .query_row("SELECT count(*) FROM password_reset_tokens", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!((users, resets), (0, 0));
}

fn run(client: &AuthClient, request: Request) -> Result<Outcome> {
    client
        .submit(
            request,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(5),
        )?
        .recv()
        .unwrap()
}

fn legacy_hash(password: &str) -> String {
    let salt = [7; 16];
    let params = scrypt::Params::new(14, 8, 1, 64).unwrap();
    let mut hash = [0; 64];
    scrypt::scrypt(password.as_bytes(), &salt, &params, &mut hash).unwrap();
    format!(
        "scrypt:16384:8:1:{}:{}",
        URL_SAFE_NO_PAD.encode(salt),
        URL_SAFE_NO_PAD.encode(hash)
    )
}

#[test]
fn verified_short_legacy_password_logs_in_without_rehashing() {
    let directory = std::env::temp_dir().join(format!(
        "pp-auth-short-legacy-{}",
        hex::encode(rand::random::<[u8; 16]>())
    ));
    let (owner, _) = WriterOwner::open(&directory, Limits::default()).unwrap();
    let client = owner.auth(FirstUserTenant::NewUser);
    run(
        &client,
        Request::Register {
            email: "legacy@example.com".into(),
            display_name: "Legacy".into(),
            password: Secret::new("initial-password".into()),
        },
    )
    .unwrap();
    owner.shutdown().unwrap();

    let stored = legacy_hash("short");
    let db = Connection::open(directory.join("print-partner.db")).unwrap();
    db.execute(
        "UPDATE users SET password_hash=?1 WHERE email='legacy@example.com'",
        [&stored],
    )
    .unwrap();
    drop(db);

    let (owner, _) = WriterOwner::open(&directory, Limits::default()).unwrap();
    let client = owner.auth(FirstUserTenant::NewUser);
    assert!(
        run(
            &client,
            Request::Login {
                email: "legacy@example.com".into(),
                password: Secret::new("wrong".into()),
            },
        )
        .is_err()
    );
    assert!(matches!(
        run(
            &client,
            Request::Login {
                email: "legacy@example.com".into(),
                password: Secret::new("short".into()),
            },
        )
        .unwrap(),
        Outcome::Session { .. }
    ));
    owner.shutdown().unwrap();

    let db = Connection::open(directory.join("print-partner.db")).unwrap();
    let current: String = db
        .query_row(
            "SELECT password_hash FROM users WHERE email='legacy@example.com'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let sessions: i64 = db
        .query_row("SELECT count(*) FROM sessions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(current, stored);
    assert_eq!(sessions, 2);
}
#[test]
fn concurrent_legacy_logins_reverify_after_upgrade_without_losing_sessions() {
    let directory = std::env::temp_dir().join(format!(
        "pp-auth-upgrade-race-{}",
        hex::encode(rand::random::<[u8; 16]>())
    ));
    let (owner, _) = WriterOwner::open(&directory, Limits::default()).unwrap();
    let client = owner.auth(FirstUserTenant::NewUser);
    run(
        &client,
        Request::Register {
            email: "upgrade@example.com".into(),
            display_name: "Upgrade".into(),
            password: Secret::new("initial-password".into()),
        },
    )
    .unwrap();
    owner.shutdown().unwrap();
    let db = Connection::open(directory.join("print-partner.db")).unwrap();
    db.execute(
        "UPDATE users SET password_hash=?1",
        [include_str!("../../tests/node-scrypt.txt").trim()],
    )
    .unwrap();
    drop(db);
    let (owner, _) = WriterOwner::open(&directory, Limits::default()).unwrap();
    let client = owner.auth(FirstUserTenant::NewUser);
    let cancelled = AtomicBool::new(false);
    let read = || {
        let Reply::Credential(Some(credential)) = client
            .command(
                Command::CredentialByEmail("upgrade@example.com".into()),
                &cancelled,
            )
            .unwrap()
        else {
            panic!("credential expected")
        };
        credential
    };
    // Both workers read the legacy hash before either submits its login write.
    let first = read();
    let second = read();
    assert_eq!(first.hash, second.hash);
    let password = Secret::new("legacy-🖨️-password".into());
    let Outcome::Session {
        token: first_token, ..
    } = client.login(first, &password, &cancelled).unwrap()
    else {
        panic!("session expected")
    };
    let upgraded = read().hash.unwrap();
    assert!(upgraded.starts_with("$argon2id$"));
    let Outcome::Session {
        token: second_token,
        ..
    } = client.login(second, &password, &cancelled).unwrap()
    else {
        panic!("session expected")
    };
    assert_ne!(first_token.expose(), second_token.expose());
    assert_eq!(read().hash.as_ref(), Some(&upgraded));
    for token in [first_token, second_token] {
        assert!(matches!(
            run(&client, Request::ResolveSession { token }).unwrap(),
            Outcome::User(Some(_))
        ));
    }
    owner.shutdown().unwrap();
    let db = Connection::open(directory.join("print-partner.db")).unwrap();
    let sessions: i64 = db
        .query_row("SELECT count(*) FROM sessions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(sessions, 3);
}

#[test]
fn ticket_t_17_transaction_cas_rejects_verified_login_after_public_reset() {
    let directory = std::env::temp_dir().join(format!(
        "pp-auth-cas-{}",
        hex::encode(rand::random::<[u8; 16]>())
    ));
    let (owner, _) = WriterOwner::open(&directory, Limits::default()).unwrap();
    let client = owner.auth(FirstUserTenant::NewUser);
    let Outcome::Session {
        token: old_session, ..
    } = run(
        &client,
        Request::Register {
            email: "race@example.com".into(),
            display_name: "Race".into(),
            password: Secret::new("password-before".into()),
        },
    )
    .unwrap()
    else {
        panic!("session expected")
    };
    let Outcome::ResetToken(Some(token)) = run(
        &client,
        Request::RequestReset {
            email: "race@example.com".into(),
        },
    )
    .unwrap() else {
        panic!("reset expected")
    };
    owner.shutdown().unwrap();
    let db = Connection::open(directory.join("print-partner.db")).unwrap();
    db.execute(
        "UPDATE users SET password_hash=?1",
        [include_str!("../../tests/node-scrypt.txt").trim()],
    )
    .unwrap();
    drop(db);
    let (owner, _) = WriterOwner::open(&directory, Limits::default()).unwrap();
    let client = owner.auth(FirstUserTenant::NewUser);
    let cancelled = AtomicBool::new(false);
    let Reply::Credential(Some(credential)) = client
        .command(
            Command::CredentialByEmail("race@example.com".into()),
            &cancelled,
        )
        .unwrap()
    else {
        panic!("credential expected")
    };
    let Reply::Credential(Some(retry_credential)) = client
        .command(
            Command::CredentialByEmail("race@example.com".into()),
            &cancelled,
        )
        .unwrap()
    else {
        panic!("credential expected")
    };
    let old_password = Secret::new("legacy-🖨️-password".into());
    assert!(crypto::verify(
        &old_password,
        credential.hash.as_ref().unwrap()
    ));
    let replacement = crypto::hash(&old_password).unwrap();
    let Outcome::Session {
        token: reset_session,
        ..
    } = run(
        &client,
        Request::ResetPassword {
            token,
            replacement: Secret::new("reset-winner-password".into()),
        },
    )
    .unwrap()
    else {
        panic!("reset session expected")
    };
    let Reply::Credential(Some(after_reset)) = client
        .command(
            Command::CredentialByEmail("race@example.com".into()),
            &cancelled,
        )
        .unwrap()
    else {
        panic!("reset credential expected")
    };
    assert_ne!(after_reset.hash, credential.hash);
    assert!(crypto::verify(
        &Secret::new("reset-winner-password".into()),
        after_reset.hash.as_ref().unwrap()
    ));
    let old = client.command(
        Command::Login {
            credential,
            replacement: Some(replacement),
        },
        &cancelled,
    );
    assert_eq!(
        old.err().map(|error| error.to_string()).unwrap(),
        "Credential changed"
    );
    assert_eq!(
        client
            .login(retry_credential, &old_password, &cancelled)
            .err()
            .unwrap()
            .to_string(),
        "Invalid email or password"
    );
    let Reply::Credential(Some(after_rejected_login)) = client
        .command(
            Command::CredentialByEmail("race@example.com".into()),
            &cancelled,
        )
        .unwrap()
    else {
        panic!("credential expected")
    };
    assert_eq!(after_rejected_login.hash, after_reset.hash);
    assert!(matches!(
        run(&client, Request::ResolveSession { token: old_session }).unwrap(),
        Outcome::User(None)
    ));
    assert!(matches!(
        run(
            &client,
            Request::ResolveSession {
                token: reset_session,
            }
        )
        .unwrap(),
        Outcome::User(Some(_))
    ));
    assert!(
        run(
            &client,
            Request::Login {
                email: "race@example.com".into(),
                password: Secret::new("reset-winner-password".into())
            }
        )
        .is_ok()
    );
    assert!(
        run(
            &client,
            Request::Login {
                email: "race@example.com".into(),
                password: Secret::new("legacy-🖨️-password".into())
            }
        )
        .is_err()
    );
    owner.shutdown().unwrap();
    let db = Connection::open(directory.join("print-partner.db")).unwrap();
    let sessions: i64 = db
        .query_row("SELECT count(*) FROM sessions", [], |row| row.get(0))
        .unwrap();
    let resets: i64 = db
        .query_row("SELECT count(*) FROM password_reset_tokens", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!((sessions, resets), (2, 0));
}
