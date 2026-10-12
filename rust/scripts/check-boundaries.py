import json
from pathlib import Path
import shutil
import subprocess

ALLOWED = {"pp-source": set(), "pp-storage": set(), "pp-core": {"pp-gateway", "pp-compat", "pp-storage"}, "pp-gateway": {"pp-compat", "pp-drivers", "pp-net"}, "pp-compat": set(), "pp-server": {"pp-core"}, "pp-contracts": {"pp-api-types"}, "pp-desktop": {"pp-core"}, "pp-domain": set(), "pp-api-types": {"pp-domain"}, "pp-net": set(), "pp-drivers": {"pp-net", "pp-api-types"}, "pp-services": set()}


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


def planted_edges_rejected():
    """Fake graphs only. ALLOWED is not changed to make these pass."""
    cases = (
        ([{"name": "pp-compat", "dependencies": [{"name": "pp-gateway"}]}], [("pp-compat", "pp-gateway")]),
        ([{"name": "pp-contracts", "dependencies": [{"name": "pp-gateway"}]}], [("pp-contracts", "pp-gateway")]),
        ([{"name": "pp-domain", "dependencies": [{"name": "pp-net"}]}], [("pp-domain", "pp-net")]),
    )
    return all(violations(packages) == expected for packages, expected in cases)


# Always evaluate the planted edges. The field used to mirror `--self-test` in argv,
# so a real allow-list pass printed false when that flag was omitted.
rejected = planted_edges_rejected()
if not rejected:
    raise SystemExit("intentional boundary violation was not rejected")
print(json.dumps({"packages": len(metadata["packages"]), "allowed_edges": True, "intentional_violation_rejected": rejected}))
