import json
from pathlib import Path
import shutil
import subprocess
import sys

ALLOWED = {"pp-core": {"pp-gateway", "pp-compat"}, "pp-gateway": {"pp-compat"}, "pp-compat": set(), "pp-server": {"pp-core"}}


def violations(packages):
    return [(package["name"], dependency["name"]) for package in packages
            if package["name"] in ALLOWED for dependency in package["dependencies"]
            if dependency["name"].startswith("pp-") and dependency["name"] not in ALLOWED[package["name"]]]


manifest = Path(__file__).resolve().parents[1] / "Cargo.toml"
cargo = shutil.which("cargo") or str(Path.home() / ".cargo/bin/cargo")
metadata = json.loads(subprocess.check_output([cargo, "metadata", "--manifest-path", str(manifest), "--locked", "--format-version", "1", "--no-deps"]))
assert not violations(metadata["packages"]), violations(metadata["packages"])
if "--self-test" in sys.argv:
    invalid = [{"name": "pp-compat", "dependencies": [{"name": "pp-gateway"}]}]
    assert violations(invalid) == [("pp-compat", "pp-gateway")]
print(json.dumps({"packages": len(metadata["packages"]), "allowed_edges": True, "intentional_violation_rejected": "--self-test" in sys.argv}))
