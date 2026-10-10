import json
from pathlib import Path
import shutil
import subprocess
import sys

ALLOWED = {"pp-source": set(), "pp-storage": set(), "pp-core": {"pp-gateway", "pp-compat", "pp-storage"}, "pp-gateway": {"pp-compat", "pp-net"}, "pp-compat": set(), "pp-server": {"pp-core"}, "pp-contracts": {"pp-api-types"}, "pp-desktop": {"pp-core"}, "pp-domain": set(), "pp-api-types": {"pp-domain"}, "pp-net": set(), "pp-drivers": set(), "pp-services": set()}


def violations(packages):
    return [(package["name"], dependency["name"]) for package in packages
            for dependency in package["dependencies"]
            if dependency["name"].startswith("pp-") and dependency["name"] not in ALLOWED[package["name"]]]


manifest = Path(__file__).resolve().parents[1] / "Cargo.toml"
cargo = shutil.which("cargo")
if cargo is None:
    raise SystemExit("cargo not found in PATH")
metadata = json.loads(subprocess.check_output([cargo, "metadata", "--manifest-path", str(manifest), "--locked", "--format-version", "1", "--no-deps"]))
package_names = {package["name"] for package in metadata["packages"]}
assert package_names == set(ALLOWED), {
    "unlisted_packages": sorted(package_names - set(ALLOWED)),
    "missing_packages": sorted(set(ALLOWED) - package_names),
}
assert not violations(metadata["packages"]), violations(metadata["packages"])
if "--self-test" in sys.argv:
    invalid = [{"name": "pp-compat", "dependencies": [{"name": "pp-gateway"}]}]
    assert violations(invalid) == [("pp-compat", "pp-gateway")]
    assert violations([{ "name": "pp-contracts", "dependencies": [{ "name": "pp-gateway" }] }]) == [("pp-contracts", "pp-gateway")]
    assert violations([{ "name": "pp-domain", "dependencies": [{ "name": "pp-net" }] }]) == [("pp-domain", "pp-net")]
print(json.dumps({"packages": len(metadata["packages"]), "allowed_edges": True, "intentional_violation_rejected": "--self-test" in sys.argv}))
