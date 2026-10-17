import json
from pathlib import Path
import shutil
import subprocess

ALLOWED = {"pp-api": {"pp-storage"}, "pp-source": set(), "pp-storage": {"pp-domain", "pp-contracts"}, "pp-core": {"pp-gateway", "pp-compat", "pp-storage", "pp-source", "pp-net"}, "pp-gateway": {"pp-compat", "pp-drivers", "pp-net"}, "pp-compat": set(), "pp-server": {"pp-core"}, "pp-contracts": {"pp-api-types"}, "pp-desktop": {"pp-core"}, "pp-domain": set(), "pp-api-types": {"pp-domain"}, "pp-net": set(), "pp-drivers": {"pp-net", "pp-api-types"}, "pp-services": set()}
GATED = {"pp-core": {"pp-source", "pp-net"}, "pp-storage": {"pp-domain", "pp-contracts"}}


def rebuild_edge_is_gated(package, dependency):
    if not dependency.get("optional", False):
        return False
    features = package.get("features", {})
    reachable, pending = set(), ["default"]
    while pending:
        member = pending.pop()
        if member not in reachable:
            reachable.add(member)
            pending.extend(features.get(member, []))
    name = dependency["name"]
    activation = {name, f"dep:{name}"}
    return "desktop_rebuild" not in reachable and f"dep:{name}" in features.get("desktop_rebuild", []) and all(
        feature == "desktop_rebuild" or not any(
            member in activation or member.startswith(f"{name}/")
            for member in members
        )
        for feature, members in features.items()
    )


def violations(packages):
    return [(package["name"], dependency["name"]) for package in packages
            for dependency in package["dependencies"]
            if dependency["name"].startswith("pp-") and (
                dependency["name"] not in ALLOWED[package["name"]]
                or (dependency["name"] in GATED.get(package["name"], set())
                    and not rebuild_edge_is_gated(package, dependency))
            )]


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
    source = {"name": "pp-core", "dependencies": [{"name": "pp-source", "optional": True}],
              "features": {"default": [], "desktop_rebuild": ["dep:pp-source", "pp-source/desktop_rebuild"]}}
    ungated = {**source, "dependencies": [{"name": "pp-source", "optional": False}]}
    default_on = {**source, "features": {**source["features"], "default": ["dep:pp-source"]}}
    alternate = {**source, "features": {**source["features"], "other": ["pp-source/other"]}}
    transitive = {**source, "features": {**source["features"], "default": ["desktop_rebuild"]}}
    cases += (([transitive], [("pp-core", "pp-source")]), ([alternate], [("pp-core", "pp-source")]), ([source], []), ([ungated], [("pp-core", "pp-source")]),
              ([default_on], [("pp-core", "pp-source")]))
    storage = {"name": "pp-storage", "dependencies": [{"name": "pp-contracts", "optional": True}],
               "features": {"default": [], "desktop_rebuild": ["dep:pp-contracts", "pp-contracts/desktop_rebuild"]}}
    cases += (([storage], []),
              ([{**storage, "dependencies": [{"name": "pp-contracts", "optional": False}]}], [("pp-storage", "pp-contracts")]),
              ([{**storage, "features": {**storage["features"], "default": ["desktop_rebuild"]}}], [("pp-storage", "pp-contracts")]))
    domain = {"name": "pp-storage", "dependencies": [{"name": "pp-domain", "optional": True}],
              "features": {"default": [], "desktop_rebuild": ["dep:pp-domain", "pp-domain/desktop_rebuild"]}}
    cases += (([domain], []),
              ([{**domain, "dependencies": [{"name": "pp-domain", "optional": False}]}], [("pp-storage", "pp-domain")]),
              ([{**domain, "features": {**domain["features"], "default": ["desktop_rebuild"]}}], [("pp-storage", "pp-domain")]))
    return all(violations(packages) == expected for packages, expected in cases)


# Always evaluate the planted edges. The field used to mirror `--self-test` in argv,
# so a real allow-list pass printed false when that flag was omitted.
rejected = planted_edges_rejected()
if not rejected:
    raise SystemExit("intentional boundary violation was not rejected")
print(json.dumps({"packages": len(metadata["packages"]), "allowed_edges": True, "intentional_violation_rejected": rejected}))
