from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from manifests.scripts.validate import (
    check_embedded_copy_drift,
    sync_embedded_copies,
    validate_manifest,
)


REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).parent / "fixtures"
SCHEMAS = REPO_ROOT / "manifests" / "schema"


class ManifestValidatorTests(unittest.TestCase):
    def test_accepts_valid_v1_and_v2_documents(self) -> None:
        for name in ("valid-v1.yaml", "valid-v2.yaml"):
            with self.subTest(name=name):
                self.assertEqual(validate_manifest(FIXTURES / name, SCHEMAS), [])

    def test_rejects_documents_against_their_versioned_schema(self) -> None:
        for name in ("invalid-v1.yaml", "invalid-v2.yaml"):
            with self.subTest(name=name):
                errors = validate_manifest(FIXTURES / name, SCHEMAS)
                self.assertTrue(errors, f"{name} unexpectedly passed validation")
                self.assertTrue(
                    any("schema validation failed" in error for error in errors),
                    errors,
                )

    def test_rejects_unsupported_manifest_versions(self) -> None:
        errors = validate_manifest(FIXTURES / "unsupported-v3.yaml", SCHEMAS)
        self.assertTrue(any("unsupported manifest version 3" in error for error in errors), errors)

    def test_rejects_missing_string_and_boolean_versions(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            cases = {
                "missing.yaml": "format: print-partner-manifest\n",
                "string.yaml": "format: print-partner-manifest\nversion: '2'\n",
                "boolean.yaml": "format: print-partner-manifest\nversion: true\n",
            }
            for name, document in cases.items():
                with self.subTest(name=name):
                    path = root / name
                    path.write_text(document)
                    errors = validate_manifest(path, SCHEMAS)
                    self.assertTrue(
                        any("manifest version must be an integer" in error for error in errors),
                        errors,
                    )

    def test_rejects_malformed_json_schema(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / "manifest.yaml"
            schema_dir = root / "schema"
            schema_dir.mkdir()
            manifest.write_text("format: print-partner-manifest\nversion: 1\n")
            (schema_dir / "print-partner-manifest-v1.json").write_text(
                '{"type": "not-a-json-schema-type"}'
            )

            errors = validate_manifest(manifest, schema_dir)

            self.assertTrue(any("schema is invalid" in error for error in errors), errors)

    def test_detects_and_clears_embedded_copy_drift(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            canonical_manifest = (
                root / "manifests" / "community" / "example" / "manifest.yaml"
            )
            canonical_registry = root / "manifests" / "registry" / "index.yaml"
            embedded_dir = root / "web" / "apps" / "server" / "src" / "data" / "manifests"
            embedded_manifest = embedded_dir / "example.yaml"
            embedded_registry = embedded_dir / "registry-index.yaml"

            for path in (canonical_manifest, canonical_registry, embedded_manifest, embedded_registry):
                path.parent.mkdir(parents=True, exist_ok=True)
            canonical_manifest.write_text("format: print-partner-manifest\nversion: 1\n")
            canonical_registry.write_text(
                "entries:\n"
                "  - slug: example\n"
                "    manifest_file: example/manifest.yaml\n"
            )
            embedded_manifest.write_text("format: print-partner-manifest\nversion: 2\n")
            embedded_registry.write_text("entries: []\n")

            errors = check_embedded_copy_drift(root)
            self.assertTrue(any("example.yaml" in error for error in errors), errors)

            embedded_manifest.write_bytes(canonical_manifest.read_bytes())
            embedded_registry.write_bytes(canonical_registry.read_bytes())
            self.assertEqual(check_embedded_copy_drift(root), [])

    def test_repository_embedded_copies_match_canonical_sources(self) -> None:
        self.assertEqual(check_embedded_copy_drift(REPO_ROOT), [])

    def test_detects_orphaned_embedded_copy(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            registry = root / "manifests" / "registry" / "index.yaml"
            embedded_dir = root / "web" / "apps" / "server" / "src" / "data" / "manifests"
            registry.parent.mkdir(parents=True)
            embedded_dir.mkdir(parents=True)
            registry.write_text("entries: []\n")
            (embedded_dir / "registry-index.yaml").write_bytes(registry.read_bytes())
            orphan = embedded_dir / "orphan.yaml"
            orphan.write_text("format: print-partner-manifest\nversion: 1\n")

            errors = check_embedded_copy_drift(root)

            self.assertTrue(
                any("orphan.yaml" in error and "no canonical registry entry" in error for error in errors),
                errors,
            )

    def test_sync_regenerates_embedded_copies_from_canonical_sources(self) -> None:
        with TemporaryDirectory() as directory:
            root = Path(directory)
            canonical = root / "manifests" / "community" / "example" / "manifest.yaml"
            registry = root / "manifests" / "registry" / "index.yaml"
            canonical.parent.mkdir(parents=True)
            registry.parent.mkdir(parents=True)
            canonical.write_text("format: print-partner-manifest\nversion: 1\n")
            registry.write_text(
                "entries:\n"
                "  - slug: example\n"
                "    manifest_file: example/manifest.yaml\n"
            )

            self.assertEqual(sync_embedded_copies(root), [])
            self.assertEqual(check_embedded_copy_drift(root), [])


if __name__ == "__main__":
    unittest.main()
