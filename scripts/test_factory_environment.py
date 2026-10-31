"""Offline checks for the cloud setup; the disposable Linux run is separate."""

from pathlib import Path
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
SETUP = ROOT / "scripts/factory-environment/setup.sh"


class EnvironmentSetupTests(unittest.TestCase):
    def test_script_parses(self):
        result = subprocess.run(["bash", "-n", str(SETUP)], capture_output=True,
                                text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_runtime_and_parity_versions_match_ci(self):
        setup = SETUP.read_text()
        ci = (ROOT / "scripts/local-ci.py").read_text()
        for variable in ("NODE_RUNTIME", "NODE_PARITY"):
            version = re.search(rf"^{variable}=([0-9.]+)$", setup, re.M)[1]
            self.assertIn(f"v{version}", ci)
        self.assertIn('"$CARGO_HOME/bin/rustup" toolchain install', setup)
        self.assertNotIn("toolchain install stable", setup)
        self.assertIn('rustup" default "$(', setup)

    def test_downloads_have_architecture_specific_checksums(self):
        setup = SETUP.read_text()
        hashes = re.findall(r"(?:rustup|runtime|parity)_sha=([0-9a-f]+)", setup)
        self.assertEqual(len(hashes), 6)
        self.assertEqual(len(set(hashes)), 6)
        self.assertTrue(all(len(value) == 64 for value in hashes))
        self.assertIn("sha256sum -c --quiet -", setup)

    def test_sidecar_pins_match_product_image(self):
        setup = SETUP.read_text()
        product = (ROOT / "slicer-sidecar/Dockerfile").read_text()
        for dependency in ("flask", "waitress"):
            pin = re.search(rf"{dependency}==[0-9.]+", product)[0]
            self.assertIn(pin, setup)

    def test_setup_builds_packages_without_starting_services(self):
        setup = SETUP.read_text()
        self.assertIn("npm --prefix web ci", setup)
        self.assertIn("npm --prefix web run predev", setup)
        self.assertNotRegex(setup, r"systemctl|docker run|run dev(?:\s|$)")


if __name__ == "__main__":
    unittest.main()
