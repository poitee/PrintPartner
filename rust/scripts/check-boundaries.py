import argparse
import json
from pathlib import Path
import subprocess
import sys


ALLOWED = {
    "pp-api": {"pp-contracts", "pp-storage"},
    "pp-source": set(),
    "pp-core": {"pp-api", "pp-gateway", "pp-compat", "pp-storage", "pp-source"},
    "pp-storage": {"pp-contracts"},
    "pp-gateway": {"pp-compat"},
    "pp-compat": set(),
    "pp-server": {"pp-core"},
    "pp-contracts": set(),
    "pp-desktop": {"pp-core"},
}


class MetadataCommandError(Exception):
    def __init__(self, returncode):
        self.returncode = returncode


def violations(packages):
    return sorted(
        (package["name"], dependency["name"])
        for package in packages
        if package["name"] in ALLOWED
        for dependency in package.get("dependencies", [])
        if dependency["name"].startswith("pp-")
        and dependency["name"] not in ALLOWED[package["name"]]
    )


def read_command(command):
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise MetadataCommandError(result.returncode)
    return json.loads(result.stdout)


def read_metadata(args, manifest):
    if args.metadata_file:
        return json.loads(Path(args.metadata_file).read_text())
    return read_command(
        [
            args.cargo,
            "metadata",
            "--manifest-path",
            str(manifest),
            "--locked",
            "--format-version",
            "1",
            "--no-deps",
        ]
    )


def package(name, dependencies):
    return {"name": name, "dependencies": dependencies}


def dependency(name, kind=None, rename=None):
    return {"name": name, "kind": kind, "rename": rename}


def self_test():
    positive = [
        package("pp-api", [dependency("pp-contracts")]),
        package("pp-core", [dependency("pp-api", "build", "http-adapter")]),
    ]
    if violations(positive):
        raise AssertionError("legitimate dependency rejected")
    negative = [
        package("pp-api", [dependency("pp-core")]),
        package("pp-api", [dependency("pp-source", "dev")]),
        package("pp-api", [dependency("pp-gateway", "build")]),
        package("pp-contracts", [dependency("pp-gateway")]),
    ]
    expected = [
        ("pp-api", "pp-core"),
        ("pp-api", "pp-source"),
        ("pp-api", "pp-gateway"),
        ("pp-contracts", "pp-gateway"),
    ]
    if violations(negative) != sorted(expected):
        raise AssertionError("forbidden dependency accepted")
    renamed = [package("pp-api", [dependency("pp-core", "dev", "core-alias")])]
    if violations(renamed) != [("pp-api", "pp-core")]:
        raise AssertionError("renamed forbidden dependency accepted")
    try:
        read_command([sys.executable, "-c", "raise SystemExit(7)"])
    except MetadataCommandError as error:
        if error.returncode != 7:
            raise AssertionError("metadata failure status lost") from error
    else:
        raise AssertionError("metadata command failure treated as absence")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--metadata-file")
    parser.add_argument("--cargo", default=str(Path.home() / ".cargo/bin/cargo"))
    args = parser.parse_args()
    manifest = Path(__file__).resolve().parents[1] / "Cargo.toml"
    try:
        metadata = read_metadata(args, manifest)
    except MetadataCommandError as error:
        print(json.dumps({"metadata_status": "error", "exit_code": error.returncode}))
        return 2
    except (OSError, json.JSONDecodeError) as error:
        print(json.dumps({"metadata_status": "error", "detail": type(error).__name__}))
        return 2
    rejected = violations(metadata["packages"])
    if rejected:
        print(json.dumps({"allowed_edges": False, "violations": rejected}))
        return 1
    if args.self_test:
        self_test()
    print(
        json.dumps(
            {
                "packages": len(metadata["packages"]),
                "allowed_edges": True,
                "self_test": args.self_test,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
