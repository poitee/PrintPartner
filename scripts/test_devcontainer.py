import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import tomllib
import unittest


ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / ".devcontainer"


class DevcontainerTests(unittest.TestCase):
    def test_build_context_contains_only_environment_definition(self):
        config = json.loads((DIRECTORY / "devcontainer.json").read_text())
        self.assertEqual(config["build"], {"dockerfile": "Dockerfile", "context": "."})
        dockerfile = (DIRECTORY / "Dockerfile").read_text()
        copies = [line for line in dockerfile.splitlines() if line.startswith("COPY ")]
        self.assertEqual(len(copies), 2)
        self.assertTrue(all(line.startswith("COPY --from=") for line in copies))

    def test_non_root_without_host_services_or_automatic_forwarding(self):
        config = json.loads((DIRECTORY / "devcontainer.json").read_text())
        self.assertEqual(config["remoteUser"], "developer")
        self.assertEqual(config["userEnvProbe"], "none")
        self.assertTrue(config["updateRemoteUserUID"])
        self.assertEqual(config["forwardPorts"], [])
        self.assertEqual(config["otherPortsAttributes"], {"onAutoForward": "ignore"})
        for key in ("privileged", "capAdd", "runArgs", "mounts", "features"):
            self.assertNotIn(key, config)
        self.assertNotIn("docker.sock", json.dumps(config))
        self.assertIn("USER developer\n", (DIRECTORY / "Dockerfile").read_text())

    def test_image_digests_and_toolchains_match_repository(self):
        dockerfile = (DIRECTORY / "Dockerfile").read_text()
        images = re.findall(r"^FROM (\S+)", dockerfile, re.M)
        self.assertEqual(len(images), 3)
        for image in images:
            self.assertRegex(image, r"^[a-z]+:\d+\.\d+\.\d+-bookworm@sha256:[0-9a-f]{64}$")
        channel = tomllib.loads((ROOT / "rust-toolchain.toml").read_text())["toolchain"]["channel"]
        self.assertTrue(images[2].startswith(f"rust:{channel}-bookworm@"))
        local_ci = (ROOT / "scripts/local-ci.py").read_text()
        for version in ("24.21.0", "22.23.3"):
            self.assertIn(f"v{version}", local_ci)
            self.assertTrue(any(image.startswith(f"node:{version}-bookworm@") for image in images))
        config = json.loads((DIRECTORY / "devcontainer.json").read_text())
        self.assertNotIn("containerEnv", config)
        self.assertIn('PP_SCHEMA_PARITY_NODE="/opt/node22/bin/node"', dockerfile)
        self.assertIn('PLAYWRIGHT_CHROMIUM_EXECUTABLE="/usr/bin/chromium"', dockerfile)
        self.assertIn('INSTA_UPDATE="no"', dockerfile)
        self.assertIn('PATH="/opt/node24/bin:${PATH}"', dockerfile)

    def test_scripts_parse_and_post_create_is_explicit(self):
        config = json.loads((DIRECTORY / "devcontainer.json").read_text())
        self.assertEqual(config["postCreateCommand"], "bash .devcontainer/post-create.sh")
        for name in ("preflight.sh", "post-create.sh", "smoke.sh"):
            result = subprocess.run(["bash", "-n", str(DIRECTORY / name)],
                                    capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
        for name in ("post-create.sh", "smoke.sh"):
            script = (DIRECTORY / name).read_text()
            self.assertIn("bash .devcontainer/preflight.sh", script)
            self.assertNotIn("--version", script.split("bash .devcontainer/preflight.sh")[0])
        setup = (DIRECTORY / "post-create.sh").read_text()
        self.assertIn("npm --prefix web run predev", setup)
        self.assertNotIn("run build -w", setup)
        smoke = (DIRECTORY / "smoke.sh").read_text()
        self.assertIn("scripts/local-ci.py --only web-assets --fail-on-skip", smoke)
        self.assertNotIn("build-desktop-manifest.py", smoke)
        self.assertIn("-p pp-domain --lib", smoke)
        self.assertIn("--features desktop_rebuild", smoke)
        self.assertIn("vitest run src/lib/supportLinks.test.ts", smoke)
        self.assertNotIn("--passWithNoTests", smoke)
        self.assertIn("vitest run src/services/gcode-object-parser.test.ts", smoke)
        self.assertIn("-m unittest test_sidecar.py test_shutdown.py", smoke)
        self.assertIn("cargo_tests -p pp-server --bin pp-server", smoke)
        self.assertIn("cargo_tests -p pp-server --test cli", smoke)
        self.assertIn("cargo_tests -p pp-desktop --lib browser::tests", smoke)
        self.assertIn("[1-9][0-9]* passed;", smoke)

    def test_sidecar_versions_match_product_image(self):
        dockerfile = (DIRECTORY / "Dockerfile").read_text()
        product = (ROOT / "slicer-sidecar/Dockerfile").read_text()
        for dependency in ("flask", "waitress"):
            version = re.search(rf"{dependency}==([0-9.]+)", product)[1]
            self.assertIn(f"{dependency}=={version}", dockerfile)

    def test_wrong_node_fails_before_installing_dependencies(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            node = directory / "node"
            node.write_text("#!/bin/sh\nprintf '%s\\n' v0.0.0\n")
            node.chmod(0o755)
            npm = directory / "npm"
            npm.write_text('#!/bin/sh\n: > "$PP_TEST_NPM_MARKER"\n')
            npm.chmod(0o755)
            marker = directory / "npm-ran"
            env = dict(os.environ, PATH=f"{directory}:{os.environ['PATH']}",
                       PP_TEST_NPM_MARKER=str(marker))
            result = subprocess.run(["bash", str(DIRECTORY / "post-create.sh")],
                                    cwd=directory, env=env, capture_output=True,
                                    text=True, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
