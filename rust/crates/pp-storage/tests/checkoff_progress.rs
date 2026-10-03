use pp_storage::{
    Limits, WriterOwner,
    auth::{self, Secret},
    catalog::Credentials,
    checkoff_progress::{Basis, Body, Import, ImportRow, Request},
    read_model::{AcceptedRead, Credential},
};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{Arc, atomic::AtomicBool},
    time::Duration,
};
const WAIT: Duration = Duration::from_secs(5);
fn secret() -> Secret {
    Secret::new("read-fixture-secret".into())
}
fn credential() -> Credentials {
    Credentials::Session(secret())
}
fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let dest = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_tree(&e.path(), &dest)
        } else {
            std::fs::copy(e.path(), dest).unwrap();
        }
    }
}
struct Fixture {
    root: PathBuf,
    owner: Option<WriterOwner>,
}
impl Fixture {
    fn new(sql: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "pp-checkoff-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("print-partner.db"),
            include_bytes!("fixtures/checkoff-progress/node.db"),
        )
        .unwrap();
        copy_tree(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/checkoff-progress/repos"),
            &root.join("repos"),
        );
        if !sql.is_empty() {
            Connection::open(root.join("print-partner.db"))
                .unwrap()
                .execute_batch(sql)
                .unwrap();
        }
        let (owner, ready) = WriterOwner::open(&root, Limits::default()).unwrap();
        assert_eq!(ready.version, 36);
        Self {
            root,
            owner: Some(owner),
        }
    }
    fn owner(&self) -> &WriterOwner {
        self.owner.as_ref().unwrap()
    }
    fn snapshot(&self) -> pp_storage::read_model::Snapshot {
        let r = self
            .owner()
            .accepted_reads()
            .read(
                Credential::Session(secret()),
                &[1],
                &AtomicBool::new(false),
                WAIT,
            )
            .unwrap();
        match r.builds.into_iter().next().unwrap().accepted {
            AcceptedRead::Ready { snapshot } => *snapshot,
            _ => panic!("fixture not ready"),
        }
    }
    fn command(&self, index: usize, completed: bool) -> Request {
        let s = self.snapshot();
        let p = s.parts.iter().find(|p| p.included).unwrap();
        Request::Completion {
            expected: Basis::from(&s),
            token: p.units[index].token.clone(),
            completed,
        }
    }
    fn apply(&self, request: Request) -> pp_storage::checkoff_progress::Response {
        self.owner()
            .checkoff_progress()
            .apply(credential(), request, &AtomicBool::new(false), WAIT)
            .unwrap()
    }
    fn graph(&self) -> BTreeMap<String, Vec<String>> {
        let c = Connection::open_with_flags(
            self.root.join("print-partner.db"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let tables = c
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        tables
            .into_iter()
            .map(|t| {
                let mut q = c
                    .prepare(&format!("SELECT * FROM \"{t}\" ORDER BY rowid"))
                    .unwrap();
                let count = q.column_count();
                let mut rows = q.query([]).unwrap();
                let mut values = Vec::new();
                while let Some(r) = rows.next().unwrap() {
                    values.push(
                        (0..count)
                            .map(|i| format!("{:?}", r.get_ref(i).unwrap()))
                            .collect::<Vec<_>>()
                            .join("|"),
                    );
                }
                (t, values)
            })
            .collect()
    }
    fn auth(&self, r: auth::Request) -> auth::Outcome {
        self.owner()
            .auth(auth::FirstUserTenant::NewUser)
            .submit(r, Arc::new(AtomicBool::new(false)), WAIT)
            .unwrap()
            .recv()
            .unwrap()
            .unwrap()
    }
    fn reopen(&mut self) {
        self.owner.take().unwrap().shutdown().unwrap();
        self.owner = Some(WriterOwner::open(&self.root, Limits::default()).unwrap().0);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(o) = self.owner.take() {
            o.shutdown().unwrap();
        }
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}
#[test]
fn public_prefix_assembly_import_replay_and_reopen_preserve_history() {
    let mut f = Fixture::new("");
    let before = f.graph();
    let s = f.snapshot();
    let p = s.parts.iter().find(|p| p.included).unwrap();
    let excluded = s.parts.iter().find(|p| !p.included).unwrap();
    let response = f.apply(f.command(2, true));
    assert_eq!(
        serde_json::to_value(response).unwrap(),
        json!({"status":200,"body":{"part_id":p.projection_part_id,"printed_count":3,"print_units":[true,true,true,false],"assembled_units":[false,false,false,false],"missing":true}})
    );
    let assembly = |index: usize, assembled| Request::Assembly {
        expected: Basis::from(&s),
        token: p.units[index].token.clone(),
        assembled,
    };
    f.apply(assembly(1, true));
    let g = f.graph();
    f.apply(assembly(3, true));
    assert_eq!(g, f.graph());
    f.apply(f.command(1, false));
    assert!(
        f.snapshot()
            .parts
            .iter()
            .find(|x| x.included)
            .unwrap()
            .units[1..]
            .iter()
            .all(|u| !u.completed && !u.assembled)
    );
    let import = Request::Import {
        request: Import {
            expected: Basis::from(&s),
            rows: vec![
                ImportRow {
                    part_id: p.projection_part_id,
                    printed_count: 4,
                },
                ImportRow {
                    part_id: excluded.projection_part_id,
                    printed_count: 2,
                },
            ],
        },
    };
    assert_eq!(
        f.apply(import.clone()).body,
        Body::Imported { updated_parts: 2 }
    );
    assert_eq!(f.apply(import).body, Body::Imported { updated_parts: 0 });
    for (table, rows) in &before {
        if table != "print_progress" {
            assert_eq!(*rows, f.graph()[table], "{table}");
        }
    }
    let read = serde_json::to_value(f.snapshot()).unwrap();
    f.reopen();
    assert_eq!(read, serde_json::to_value(f.snapshot()).unwrap());
    assert_eq!(f.apply(f.command(0, false)).status, 200);
}
#[test]
fn ordinary_late_sql_failure_rolls_back_entire_graph() {
    let id: Value =
        serde_json::from_str(include_str!("fixtures/checkoff-progress/identity.json")).unwrap();
    let part = id["parts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["included"] == true)
        .unwrap()["projectionPartId"]
        .as_i64()
        .unwrap();
    let f = Fixture::new(&format!(
        "CREATE TRIGGER late_failure BEFORE UPDATE ON print_progress WHEN NEW.part_id={part} AND NEW.unit_index=1 BEGIN SELECT RAISE(ABORT,'ordinary fixture constraint'); END"
    ));
    let before = f.graph();
    assert_eq!(f.apply(f.command(2, true)).status, 500);
    assert_eq!(before, f.graph());
    let s = f.snapshot();
    assert_eq!(
        f.apply(Request::Import {
            request: Import {
                expected: Basis::from(&s),
                rows: vec![ImportRow {
                    part_id: part,
                    printed_count: 3
                }]
            }
        })
        .status,
        500
    );
    assert_eq!(before, f.graph());
}
#[test]
fn every_import_row_is_checked_before_any_write() {
    let f = Fixture::new("");
    let s = f.snapshot();
    let before = f.graph();
    for rows in [
        vec![
            ImportRow {
                part_id: s.parts[0].projection_part_id,
                printed_count: 1,
            },
            ImportRow {
                part_id: s.parts[1].projection_part_id,
                printed_count: 999,
            },
        ],
        vec![
            ImportRow {
                part_id: s.parts[0].projection_part_id,
                printed_count: 1,
            },
            ImportRow {
                part_id: 999999,
                printed_count: 1,
            },
        ],
    ] {
        assert_ne!(
            f.apply(Request::Import {
                request: Import {
                    expected: Basis::from(&s),
                    rows
                }
            })
            .status,
            200
        );
        assert_eq!(before, f.graph());
    }
}
#[test]
fn sessions_keys_revocation_and_tenant_routing_are_transaction_local() {
    let mut f = Fixture::new("");
    let client = f.owner().checkoff_progress();
    let request = f.command(0, true);
    let before = f.graph();
    assert_eq!(
        client
            .apply(
                Credentials::Session(Secret::new("other-fixture-secret".into())),
                request.clone(),
                &AtomicBool::new(false),
                WAIT
            )
            .unwrap()
            .status,
        404
    );
    assert_eq!(before, f.graph());
    let auth::Outcome::KeyCreated { info, key } =
        f.auth(auth::Request::CreateKey { session: secret() })
    else {
        panic!("key not created")
    };
    let raw = key.expose().to_owned();
    assert!(
        client
            .apply(
                Credentials::Key {
                    tenant_id: "other".into(),
                    key: Secret::new(raw.clone())
                },
                request.clone(),
                &AtomicBool::new(false),
                WAIT
            )
            .is_err()
    );
    let before = f.graph();
    assert_eq!(
        client
            .apply(
                Credentials::Key {
                    tenant_id: "default".into(),
                    key: Secret::new(raw.clone())
                },
                request.clone(),
                &AtomicBool::new(false),
                WAIT
            )
            .unwrap()
            .status,
        200
    );
    assert_ne!(before["app_settings"], f.graph()["app_settings"]);
    let auth::Outcome::Keys { keys, .. } = f.auth(auth::Request::ListKeys { session: secret() })
    else {
        panic!("keys unavailable")
    };
    assert!(
        keys.iter()
            .find(|k| k.id == info.id)
            .unwrap()
            .last_used_at
            .is_some()
    );
    f.auth(auth::Request::RevokeKey {
        session: secret(),
        key_id: info.id,
    });
    let before = f.graph();
    assert!(
        client
            .apply(
                Credentials::Key {
                    tenant_id: "default".into(),
                    key: Secret::new(raw.clone())
                },
                request.clone(),
                &AtomicBool::new(false),
                WAIT
            )
            .is_err()
    );
    assert_eq!(before, f.graph());
    f.auth(auth::Request::Logout { token: secret() });
    let before = f.graph();
    assert!(
        client
            .apply(credential(), request.clone(), &AtomicBool::new(false), WAIT)
            .is_err()
    );
    assert_eq!(before, f.graph());
    f.reopen();
    assert!(
        f.owner()
            .checkoff_progress()
            .apply(credential(), request.clone(), &AtomicBool::new(false), WAIT)
            .is_err()
    );
    assert!(
        f.owner()
            .checkoff_progress()
            .apply(
                Credentials::Key {
                    tenant_id: "default".into(),
                    key: Secret::new(raw)
                },
                request,
                &AtomicBool::new(false),
                WAIT
            )
            .is_err()
    );
}
fn strict() -> auth::AuthPolicy {
    auth::AuthPolicy {
        registration: auth::RegistrationPolicy::Open,
        session_tenant: auth::SessionTenantPolicy::SingleAccountDefault,
        first_user: auth::FirstUserTenant::NewUser,
    }
}
#[test]
fn policy_is_immutable_and_multiple_accounts_fail_closed() {
    let f = Fixture::new("");
    let strict_client = f.owner().checkoff_progress_with_policy(strict()).unwrap();
    let neutral = f.owner().checkoff_progress();
    let before = f.graph();
    let request = f.command(0, true);
    assert!(
        strict_client
            .apply(credential(), request.clone(), &AtomicBool::new(false), WAIT)
            .is_err()
    );
    assert_eq!(before, f.graph());
    assert_eq!(
        neutral
            .apply(credential(), request.clone(), &AtomicBool::new(false), WAIT)
            .unwrap()
            .status,
        200
    );
    assert!(
        strict_client
            .apply(credential(), request, &AtomicBool::new(false), WAIT)
            .is_err()
    );
    let f = Fixture::new(
        "PRAGMA foreign_keys=OFF; DELETE FROM sessions WHERE user_id='other'; DELETE FROM users WHERE id='other'; UPDATE users SET id='account-uuid' WHERE id='default'; UPDATE sessions SET user_id='account-uuid' WHERE user_id='default';",
    );
    let request = Request::CompletionCoordinate {
        part_id: 3,
        body: json!({"unit_index":0,"completed":true}),
    };
    assert_eq!(
        f.owner()
            .checkoff_progress()
            .apply(credential(), request.clone(), &AtomicBool::new(false), WAIT)
            .unwrap()
            .status,
        404
    );
    assert_eq!(
        f.owner()
            .checkoff_progress_with_policy(strict())
            .unwrap()
            .apply(credential(), request, &AtomicBool::new(false), WAIT)
            .unwrap()
            .status,
        200
    );
}
#[test]
fn strict_import_and_legacy_coordinate_parsers_are_distinct() {
    let f = Fixture::new("");
    let expected = serde_json::to_value(Basis::from(&f.snapshot())).unwrap();
    let before = f.graph();
    for rows in [
        json!([]),
        json!([{"part_id":3,"printed_count":-1}]),
        json!([{"part_id":3,"printed_count":10001}]),
        json!([{"part_id":3,"printed_count":0,"extra":1}]),
        json!([{"part_id":3,"printed_count":0},{"part_id":3,"printed_count":0}]),
    ] {
        let err = Import::parse(json!({"expected":expected,"rows":rows})).unwrap_err();
        assert_eq!(err.status, 400);
    }
    assert!(
        Import::parse(json!({"expected":expected,"rows":[{"part_id":3.0,"printed_count":0.0}]}))
            .is_ok()
    );
    assert_eq!(before, f.graph());
    let response = f.apply(Request::CompletionCoordinate {
        part_id: 3,
        body: json!({"unit_index":0.0,"completed":true,"ignored":1}),
    });
    assert_eq!(response.status, 200);
    assert_eq!(
        f.owner()
            .checkoff_progress()
            .apply(
                credential(),
                f.command(0, true),
                &AtomicBool::new(true),
                WAIT
            )
            .unwrap()
            .status,
        503
    );
}

#[test]
fn key_audit_rolls_back_with_refusal_and_other_tenant_can_update_own_progress() {
    let f = Fixture::new("");
    let auth::Outcome::KeyCreated { key, .. } =
        f.auth(auth::Request::CreateKey { session: secret() })
    else {
        panic!("key not created")
    };
    let mut request = f.command(0, true);
    if let Request::Completion { expected, .. } = &mut request {
        expected.plan_version += 1;
    }
    let before = f.graph();
    assert_eq!(
        f.owner()
            .checkoff_progress()
            .apply(
                Credentials::Key {
                    tenant_id: "default".into(),
                    key
                },
                request,
                &AtomicBool::new(false),
                WAIT
            )
            .unwrap()
            .status,
        409
    );
    assert_eq!(before, f.graph());
    let batch = f
        .owner()
        .accepted_reads()
        .read(
            Credential::Session(Secret::new("other-fixture-secret".into())),
            &[2],
            &AtomicBool::new(false),
            WAIT,
        )
        .unwrap();
    let AcceptedRead::Ready { snapshot } = &batch.builds[0].accepted else {
        panic!("other tenant not ready")
    };
    let request = Request::Completion {
        expected: Basis::from(snapshot.as_ref()),
        token: snapshot.parts[0].units[0].token.clone(),
        completed: true,
    };
    assert_eq!(
        f.owner()
            .checkoff_progress()
            .apply(
                Credentials::Session(Secret::new("other-fixture-secret".into())),
                request,
                &AtomicBool::new(false),
                WAIT
            )
            .unwrap()
            .status,
        200
    );
    assert!(
        f.snapshot()
            .parts
            .iter()
            .flat_map(|p| &p.units)
            .all(|u| !u.completed)
    );
}

#[test]
fn import_rejects_incomplete_progress_without_repairing_rows() {
    let identity: Value =
        serde_json::from_str(include_str!("fixtures/checkoff-progress/identity.json")).unwrap();
    let part = identity["parts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["included"] == true)
        .unwrap()["projectionPartId"]
        .as_i64()
        .unwrap();
    let f = Fixture::new(&format!(
        "DELETE FROM print_progress WHERE part_id={part} AND unit_index=3"
    ));
    let before = f.graph();
    let expected = Basis::from(&f.snapshot());
    assert_eq!(
        f.apply(Request::Import {
            request: Import {
                expected,
                rows: vec![ImportRow {
                    part_id: part,
                    printed_count: 2
                }]
            }
        })
        .status,
        500
    );
    assert_eq!(before, f.graph());
}

#[test]
fn closed_client_refuses_before_admission() {
    let mut f = Fixture::new("");
    let request = f.command(0, true);
    let client = f.owner().checkoff_progress();
    f.owner.take().unwrap().shutdown().unwrap();
    assert_eq!(
        client
            .apply(credential(), request, &AtomicBool::new(false), WAIT)
            .unwrap()
            .status,
        503
    );
}
