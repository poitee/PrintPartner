use super::{
    AdmissionLimits, CaptureId, CaptureManifestBindingV1, CapturedInputV2, CapturedPayloadV1, File,
    Input, Operation, Sha256Digest, Target, capture_manifest_digest, serialized_digest,
    validate_admission_limits,
};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
struct CaptureManifestWire<'a> {
    manifest_version: u32,
    capture_id: &'a CaptureId,
    operation_key: &'a str,
    actor: &'a str,
    target: &'a Target,
    target_digest: &'a Sha256Digest,
    input: &'a CapturedPayloadV1,
    admission_limits: AdmissionLimits,
    policy_digest: &'a Sha256Digest,
    requested_files: &'a [File],
    requested_digest: &'a Sha256Digest,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CaptureManifestV1 {
    manifest_version: u32,
    capture_id: CaptureId,
    operation_key: String,
    actor: String,
    target: Target,
    target_digest: Sha256Digest,
    input: CapturedPayloadV1,
    admission_limits: AdmissionLimits,
    policy_digest: Sha256Digest,
    requested_files: Vec<File>,
    requested_digest: Sha256Digest,
}

pub struct CaptureManifestInventory {
    paths: Vec<String>,
    max_input_bytes: u64,
}

impl CaptureManifestInventory {
    pub fn paths(&self) -> &[String] {
        &self.paths
    }

    pub fn max_input_bytes(&self) -> u64 {
        self.max_input_bytes
    }
}

pub fn inspect_capture_manifest(bytes: &[u8]) -> Result<CaptureManifestInventory> {
    let manifest: CaptureManifestV1 =
        serde_json::from_slice(bytes).map_err(|_| anyhow::anyhow!("Invalid capture manifest"))?;
    ensure!(manifest.manifest_version == 1, "Invalid capture manifest");
    validate_admission_limits(manifest.admission_limits, None)?;
    super::files(
        &manifest.requested_files,
        manifest.admission_limits.max_input_bytes,
    )?;
    let paths = manifest
        .requested_files
        .into_iter()
        .map(|file| file.path)
        .collect();
    Ok(CaptureManifestInventory {
        paths,
        max_input_bytes: manifest.admission_limits.max_input_bytes,
    })
}

pub(super) struct CaptureManifestIdentity {
    pub capture_id: CaptureId,
    pub operation_key: String,
    pub actor: String,
}

pub(super) fn capture_manifest_identity(bytes: &[u8]) -> Result<CaptureManifestIdentity> {
    let manifest: CaptureManifestV1 =
        serde_json::from_slice(bytes).map_err(|_| anyhow::anyhow!("Invalid capture manifest"))?;
    Ok(CaptureManifestIdentity {
        capture_id: manifest.capture_id,
        operation_key: manifest.operation_key,
        actor: manifest.actor,
    })
}

pub(super) struct BoundCaptureManifest {
    input: CapturedInputV2,
    bytes: Vec<u8>,
}

impl BoundCaptureManifest {
    #[cfg(test)]
    pub(super) fn input(&self) -> &CapturedInputV2 {
        &self.input
    }

    #[cfg(test)]
    pub(super) fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub(super) fn into_parts(self) -> (CapturedInputV2, Vec<u8>) {
        (self.input, self.bytes)
    }
}

pub(super) fn bind_capture_manifest(
    capture_id: CaptureId,
    payload: CapturedPayloadV1,
    actor: &str,
    operation_key: &str,
    target: &Target,
    limits: AdmissionLimits,
    requested_files: &[File],
) -> Result<BoundCaptureManifest> {
    let input = CapturedInputV2::bind(
        capture_id,
        payload,
        actor,
        operation_key,
        target,
        limits,
        requested_files,
    )?;
    let requested_digest = serialized_digest(&requested_files)?;
    let bytes = serde_json::to_vec(&CaptureManifestWire {
        manifest_version: 1,
        capture_id: &input.capture_id,
        operation_key,
        actor,
        target,
        target_digest: &input.target_digest,
        input: &input.payload,
        admission_limits: limits,
        policy_digest: &input.policy_digest,
        requested_files,
        requested_digest: &requested_digest,
    })?;
    Ok(BoundCaptureManifest { input, bytes })
}

pub(super) fn resolve_capture_manifest(
    bytes: &[u8],
    operation: &Operation,
    actual_inventory: &[File],
) -> Result<()> {
    let manifest: CaptureManifestV1 =
        serde_json::from_slice(bytes).map_err(|_| anyhow::anyhow!("Invalid capture manifest"))?;
    let Input::Captured(captured) = &operation.input else {
        anyhow::bail!("Capture manifest mismatch");
    };
    let limits = AdmissionLimits {
        reserved_bytes: operation.reserved_bytes,
        max_input_bytes: operation.max_input_bytes,
        max_prepared_bytes: operation.max_prepared_bytes,
    };
    captured
        .validate(
            &operation.actor,
            &operation.key,
            None,
            limits,
            &operation.requested_files,
        )
        .map_err(|_| anyhow::anyhow!("Capture manifest mismatch"))?;
    ensure!(
        operation.input_version == 2
            && manifest.manifest_version == 1
            && manifest.capture_id == captured.capture_id
            && manifest.operation_key == operation.key
            && manifest.actor == operation.actor
            && manifest.input == captured.payload
            && manifest.admission_limits == limits
            && manifest.policy_digest == captured.policy_digest
            && manifest.requested_files == operation.requested_files
            && manifest.requested_files == actual_inventory,
        "Capture manifest mismatch"
    );

    let requested_digest = serialized_digest(&manifest.requested_files)?;
    let operation_requested_digest = Sha256Digest::new(operation.requested_digest.clone())?;
    let target_digest = serialized_digest(&("pp-source-import-target-v1", &manifest.target))?;
    ensure!(
        requested_digest == manifest.requested_digest
            && requested_digest == operation_requested_digest
            && target_digest == manifest.target_digest
            && target_digest == captured.target_digest,
        "Capture manifest mismatch"
    );

    if let Target::Existing { source_id } = manifest.target {
        ensure!(
            source_id == operation.source_id,
            "Capture manifest mismatch"
        );
    }

    let manifest_digest = capture_manifest_digest(CaptureManifestBindingV1 {
        manifest_version: 1,
        capture_id: &manifest.capture_id,
        operation_key: &manifest.operation_key,
        actor: &manifest.actor,
        target_digest: &manifest.target_digest,
        input: &manifest.input,
        admission_limits: manifest.admission_limits,
        policy_digest: &manifest.policy_digest,
        requested_files: &manifest.requested_files,
        requested_digest: &manifest.requested_digest,
    })?;
    ensure!(
        manifest_digest == captured.manifest_digest,
        "Capture manifest mismatch"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        catalog::CreateSource,
        uploads::{Basis, State},
    };
    use serde_json::{Map, Value};
    use sha2::{Digest, Sha256};

    fn files() -> Vec<File> {
        vec![File {
            path: "nested/part.stl".into(),
            size: 4,
            sha256: hex::encode(Sha256::digest(b"mesh")),
            kind: "input".into(),
        }]
    }

    fn limits() -> AdmissionLimits {
        AdmissionLimits {
            reserved_bytes: 3_506_438_144,
            max_input_bytes: 268_435_456,
            max_prepared_bytes: 1_073_741_824,
        }
    }

    fn requested_digest(files: &[File]) -> String {
        hex::encode(Sha256::digest(serde_json::to_vec(files).unwrap()))
    }

    fn operation(source_id: i64, input: Input, files: Vec<File>) -> Operation {
        Operation {
            tenant: "tenant".into(),
            actor: "actor".into(),
            key: "operation-key".into(),
            intent_digest: "0".repeat(64),
            source_id,
            job_id: "job".into(),
            input_version: 2,
            input,
            requested_digest: requested_digest(&files),
            requested_files: files,
            state: State::Admitted,
            basis: Basis {
                current_source_revision_id: None,
                url: String::new(),
                branch: "main".into(),
                tag: None,
                source_kind: "local".into(),
                source_type: "files".into(),
                local_path: None,
                last_commit_sha: None,
                legacy_manifest_cutover: false,
            },
            default_rules: false,
            original_rules: None,
            reserved_bytes: limits().reserved_bytes,
            max_input_bytes: limits().max_input_bytes,
            max_prepared_bytes: limits().max_prepared_bytes,
            owned: None,
            artifact: None,
            receipt: None,
            cleanup_settled: false,
            authority_revision: None,
            observation_cursor: None,
        }
    }

    fn create_target() -> Target {
        let mut metadata = Map::new();
        metadata.insert("complete".into(), Value::Bool(true));
        Target::Create {
            metadata: Box::new(CreateSource {
                name: "Created Source".into(),
                url: Some("https://example.invalid/source".into()),
                branch: Some("main".into()),
                tag: Some("v1".into()),
                source_kind: Some("local".into()),
                source_type: Some("files".into()),
                role: Some("canonical".into()),
                metadata: Some(metadata),
            }),
        }
    }

    fn bound(target: &Target) -> BoundCaptureManifest {
        bind_capture_manifest(
            CaptureId::new("ab".repeat(32)).unwrap(),
            CapturedPayloadV1::files(vec!["nested/part.stl".into()]),
            "actor",
            "operation-key",
            target,
            limits(),
            &files(),
        )
        .unwrap()
    }

    #[test]
    fn capture_manifest_existing_and_create_round_trip() {
        for (source_id, target) in [
            (42, Target::Existing { source_id: 42 }),
            (84, create_target()),
        ] {
            let bound = bound(&target);
            let keys: Vec<_> = serde_json::from_slice::<Value>(bound.bytes())
                .unwrap()
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect();
            assert_eq!(
                keys,
                [
                    "manifest_version",
                    "capture_id",
                    "operation_key",
                    "actor",
                    "target",
                    "target_digest",
                    "input",
                    "admission_limits",
                    "policy_digest",
                    "requested_files",
                    "requested_digest",
                ]
            );
            let bytes = bound.bytes().to_vec();
            let operation = operation(source_id, Input::Captured(bound.into_parts().0), files());
            resolve_capture_manifest(&bytes, &operation, &files()).unwrap();
        }
    }

    #[test]
    fn capture_manifest_exact_wire_and_five_canonical_pins() {
        let bound = bound(&Target::Existing { source_id: 42 });
        assert_eq!(bound.bytes().len(), 1_189);
        assert_eq!(
            hex::encode(Sha256::digest(bound.bytes())),
            "c1334b38c64c7675bd7f3a5bfd43f5266e56b3403ddf92fa3dffeb9b60557d7b"
        );
        let manifest: Value = serde_json::from_slice(bound.bytes()).unwrap();
        assert_eq!(
            manifest["policy_digest"],
            "7163d9f0439e36702b872b901c23a8f40f37683c30ce246faff1cbd666d5129a"
        );
        assert_eq!(
            manifest["target_digest"],
            "310a7ea4124e669f44853aa559a0a2d6250e544f41bba0654b4d0270789b971d"
        );
        assert_eq!(
            manifest["requested_digest"],
            "bcf97d12eed53a1cbbf2ec33fa590ed13b323309514b60153fec2b8b66fc87fd"
        );
        let captured = serde_json::to_value(Input::Captured(bound.input().clone())).unwrap();
        assert_eq!(
            captured["manifest_digest"],
            "96767dbe5aac21941f379a423db0a9a4df85a793d4390b4d3427dc0795178558"
        );
    }

    #[test]
    fn capture_manifest_closed_field_refusal() {
        let bound = bound(&Target::Existing { source_id: 42 });
        let operation = operation(42, Input::Captured(bound.input().clone()), files());
        let value: Value = serde_json::from_slice(bound.bytes()).unwrap();
        let mut unknown = value.clone();
        unknown
            .as_object_mut()
            .unwrap()
            .insert("future".into(), Value::Bool(true));
        assert!(
            resolve_capture_manifest(&serde_json::to_vec(&unknown).unwrap(), &operation, &files())
                .is_err()
        );
        let mut missing = value.clone();
        missing.as_object_mut().unwrap().remove("actor");
        assert!(
            resolve_capture_manifest(&serde_json::to_vec(&missing).unwrap(), &operation, &files())
                .is_err()
        );
        let mut future = value.clone();
        future["manifest_version"] = Value::from(2);
        assert!(
            resolve_capture_manifest(&serde_json::to_vec(&future).unwrap(), &operation, &files())
                .is_err()
        );
        let mut mismatch = value;
        mismatch["actor"] = Value::String("different".into());
        assert!(
            resolve_capture_manifest(
                &serde_json::to_vec(&mismatch).unwrap(),
                &operation,
                &files()
            )
            .is_err()
        );
        assert!(resolve_capture_manifest(bound.bytes(), &operation, &[]).is_err());
    }

    #[test]
    fn capture_manifest_inventory_refuses_limits_outside_admission_policy() {
        let bound = bound(&Target::Existing { source_id: 42 });
        let mut manifest: Value = serde_json::from_slice(bound.bytes()).unwrap();
        manifest["admission_limits"]["max_input_bytes"] = Value::from(268_435_457u64);
        manifest["admission_limits"]["reserved_bytes"] = Value::from(3_506_438_145u64);
        manifest["requested_files"][0]["size"] = Value::from(268_435_457u64);
        assert!(inspect_capture_manifest(&serde_json::to_vec(&manifest).unwrap()).is_err());
    }

    #[test]
    fn capture_manifest_binding_refuses_all_eleven_claim_fields() {
        let bound = bound(&Target::Existing { source_id: 42 });
        let bytes = bound.bytes().to_vec();
        let operation = operation(42, Input::Captured(bound.into_parts().0), files());
        for (pointer, replacement) in [
            ("/capture_id", Value::String("cd".repeat(32))),
            ("/operation_key", Value::String("different".into())),
            ("/actor", Value::String("different".into())),
            ("/target/source_id", Value::from(43)),
            ("/target_digest", Value::String("0".repeat(64))),
            ("/admission_limits/reserved_bytes", Value::from(1)),
            ("/input/paths/0", Value::String("other.stl".into())),
            ("/policy_digest", Value::String("0".repeat(64))),
            ("/requested_files/0/size", Value::from(5)),
            ("/requested_digest", Value::String("0".repeat(64))),
        ] {
            let mut manifest: Value = serde_json::from_slice(&bytes).unwrap();
            *manifest.pointer_mut(pointer).unwrap() = replacement;
            assert!(
                resolve_capture_manifest(
                    &serde_json::to_vec(&manifest).unwrap(),
                    &operation,
                    &files()
                )
                .is_err(),
                "accepted mismatch at {pointer}"
            );
        }
        let mut wrong_operation: Value = serde_json::to_value(&operation).unwrap();
        wrong_operation["input"]["manifest_digest"] = Value::String("0".repeat(64));
        let wrong_operation: Operation = serde_json::from_value(wrong_operation).unwrap();
        assert!(resolve_capture_manifest(&bytes, &wrong_operation, &files()).is_err());
    }
}
