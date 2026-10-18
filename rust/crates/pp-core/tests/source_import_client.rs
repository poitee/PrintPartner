#![cfg(feature = "desktop_rebuild")]
//! The synchronous supplied-import client over disposable storage and input
//! directories.
use pp_core::uploads::SourceImports;
use pp_storage::{
    Limits, WriterOwner,
    auth::{AuthPolicy, FirstUserTenant, RegistrationPolicy, SessionTenantPolicy},
    catalog::CreateSource,
    jobs::Credential,
    uploads::{Admission, File, Input, State, Target},
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};

const QUOTA: u64 = 16 * 1024 * 1024 * 1024;

struct Fixture {
    root: PathBuf,
    owner: Option<WriterOwner>,
    imports: SourceImports,
}

impl Fixture {
    fn open() -> Self {
        let root = std::env::temp_dir().join(format!(
            "pp-source-import-client-{}",
            hex::encode(rand::random::<[u8; 8]>())
        ));
        std::fs::create_dir_all(root.join("supplied")).unwrap();
        let (owner, _) = WriterOwner::open(&root.join("data"), Limits::default()).unwrap();
        let policy = AuthPolicy {
            registration: RegistrationPolicy::Open,
            session_tenant: SessionTenantPolicy::AccountTenant,
            first_user: FirstUserTenant::NewUser,
        };
        let imports = SourceImports::new(&owner, policy, QUOTA).unwrap();
        Self {
            root,
            owner: Some(owner),
            imports,
        }
    }

    fn supplied(&self) -> PathBuf {
        self.root.join("supplied")
    }

    fn write(&self, path: &str, bytes: &[u8]) {
        let path = self.supplied().join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    fn credential(&self) -> Credential {
        Credential::PhysicalOwner(self.owner.as_ref().unwrap().job_physical_owner())
    }

    fn admit(&self, request: Admission) -> anyhow::Result<pp_storage::uploads::Operation> {
        self.imports.admit(
            self.credential(),
            request,
            &self.supplied(),
            &AtomicBool::new(false),
        )
    }

    /// Every entry under the repos and supplied directories with its bytes.
    fn files(&self) -> BTreeMap<String, Vec<u8>> {
        fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                let relative = path.strip_prefix(root).unwrap().display().to_string();
                if path.is_dir() {
                    out.insert(format!("{relative}/"), vec![]);
                    walk(root, &path, out);
                } else {
                    out.insert(relative, std::fs::read(&path).unwrap());
                }
            }
        }
        let mut files = BTreeMap::new();
        for dir in ["data/repos", "supplied"] {
            walk(&self.root, &self.root.join(dir), &mut files);
        }
        files
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.owner.take();
        std::fs::remove_dir_all(&self.root).unwrap();
    }
}

fn request(key: &str, input: Input) -> Admission {
    Admission {
        key: key.into(),
        target: Target::Create {
            metadata: Box::new(CreateSource {
                name: key.into(),
                source_kind: Some("local".into()),
                source_type: Some("local".into()),
                ..Default::default()
            }),
        },
        input,
        reserved_bytes: 32 * 1024 * 1024,
        max_input_bytes: 1024,
        max_prepared_bytes: 1024 * 1024,
    }
}

fn input(path: &str, bytes: &[u8]) -> File {
    File {
        path: path.into(),
        size: bytes.len() as u64,
        sha256: hex::encode(Sha256::digest(bytes)),
        kind: "input".into(),
    }
}

#[test]
fn source_import_client_admits_once() {
    let fixture = Fixture::open();
    fixture.write("part.stl", b"solid a");
    fixture.write("docs/readme.txt", b"hi");
    fixture.write(".hidden", b"skipped");
    let directory = SourceImports::directory_input(&fixture.supplied()).unwrap();
    assert_eq!(
        directory,
        Input::Files {
            paths: vec!["docs/readme.txt".into(), "part.stl".into()]
        }
    );
    let before = fixture.files();

    let operation = fixture.admit(request("first", directory.clone())).unwrap();
    assert_eq!(
        (operation.key.as_str(), &operation.state, &operation.input),
        ("first", &State::Admitted, &directory)
    );
    assert_eq!(
        operation.requested_files,
        [
            input("docs/readme.txt", b"hi"),
            input("part.stl", b"solid a")
        ]
    );
    assert_eq!(
        (operation.owned.as_ref(), operation.artifact.as_ref()),
        (None, None)
    );

    let replay = fixture.admit(request("first", directory)).unwrap();
    assert_eq!(replay, operation);
    let read = fixture
        .imports
        .get(fixture.credential(), "first".into())
        .unwrap();
    assert_eq!(read, operation);
    assert_eq!(fixture.files(), before);
}

fn os_error(supplied: &Path) -> Option<i32> {
    let error = SourceImports::directory_input(supplied).unwrap_err();
    match error.downcast_ref::<pp_source::Error>() {
        Some(pp_source::Error::Io(error)) => error.raw_os_error(),
        _ => panic!("unexpected refusal: {error}"),
    }
}

#[test]
fn source_import_client_refuses_invalid_directory_input() {
    let fixture = Fixture::open();
    fixture.write("part.stl", b"solid a");
    let link = fixture.supplied().join("link.stl");
    std::os::unix::fs::symlink(fixture.supplied().join("part.stl"), &link).unwrap();
    assert_eq!(os_error(&fixture.supplied()), Some(libc::ELOOP));
    assert_eq!(os_error(&fixture.root.join("missing")), Some(libc::ENOENT));
    std::fs::remove_file(link).unwrap();
    let before = fixture.files();

    let refusals = [
        (
            Input::Files {
                paths: vec!["absent.stl".into()],
            },
            1024,
            "io: No such file or directory (os error 2)",
        ),
        (
            Input::Files {
                paths: vec!["../part.stl".into()],
            },
            1024,
            "unsafe-path",
        ),
        (
            Input::Zip {
                path: "absent.zip".into(),
            },
            1024,
            "io: No such file or directory (os error 2)",
        ),
        (
            Input::Files {
                paths: vec!["part.stl".into()],
            },
            3,
            "limit",
        ),
        (
            Input::Files {
                paths: vec!["part.stl".into()],
            },
            256 * 1024 * 1024 + 1,
            "Invalid import input limit",
        ),
    ];
    for (input, max_input_bytes, expected) in refusals {
        let mut refused = request("refused", input);
        refused.max_input_bytes = max_input_bytes;
        let error = fixture.admit(refused).unwrap_err().to_string();
        assert_eq!(error, expected);
    }
    assert!(
        fixture
            .imports
            .get(fixture.credential(), "refused".into())
            .is_err()
    );
    assert_eq!(fixture.files(), before);

    let admitted = fixture
        .admit(request(
            "refused",
            SourceImports::directory_input(&fixture.supplied()).unwrap(),
        ))
        .unwrap();
    assert_eq!(admitted.requested_files, [input("part.stl", b"solid a")]);
}
