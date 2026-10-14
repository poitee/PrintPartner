"""Exercise the workflow's actual shell selector without allocating runners."""
import itertools
import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[1]
POLICY = ROOT / '.github/workflows/ci-runner-plan.yml'


class RunnerPolicyTests(unittest.TestCase):
    def test_runner_choices_and_skip_flags(self):
        script = textwrap.dedent(POLICY.read_text().split('        run: |\n', 1)[1])
        values = ['', 'off', 'on', 'ON', 'On']
        events = ['push', 'schedule', 'workflow_dispatch', 'pull_request', 'pull_request_target']
        for hosted, linux, macos, event, fork, label in itertools.product(
                values, values, values, events, [False, True], [False, True]):
            with self.subTest(hosted=hosted, linux=linux, macos=macos,
                              event=event, fork=fork, label=label):
                with tempfile.NamedTemporaryFile() as output:
                    env = {**os.environ, 'HOSTED_CI': hosted, 'FLEET_LINUX_RUNNERS': linux,
                           'MAC_MINI_RUNNER': macos, 'EVENT_NAME': event,
                           'HEAD_REPO': 'fork/repo' if fork else 'poitee/PrintPartner',
                           'REPOSITORY': 'poitee/PrintPartner', 'HOSTED_LABEL': str(label).lower(),
                           'GITHUB_OUTPUT': output.name}
                    subprocess.run(['bash', '-c', script], env=env, check=True)
                    actual = dict(line.split('=', 1) for line in Path(output.name).read_text().splitlines())
                is_fork = fork and event in ['pull_request', 'pull_request_target']
                use_hosted = (hosted == 'on' and not is_fork) or label
                self.assertEqual(actual['hosted'], str(use_hosted).lower())
                self.assertEqual(actual['linux'], str(use_hosted or (linux == 'on' and not is_fork)).lower())
                self.assertEqual(actual['macos'], str(use_hosted or (macos == 'on' and not is_fork)).lower())
                self.assertEqual(actual['intel'], str(use_hosted).lower())
                self.assertEqual(json.loads(actual['linux-runner']), ['ubuntu-latest'] if use_hosted
                                 else ['self-hosted', 'linux', 'fleet'])
                self.assertEqual(json.loads(actual['macos-runner']), ['macos-26'] if use_hosted
                                 else ['self-hosted', 'macOS', 'ARM64', 'mac-mini'])

    def test_fork_bootstrap_uses_only_label(self):
        text = POLICY.read_text()
        condition = next(line for line in text.splitlines() if line.startswith('    if:'))
        self.assertNotIn('HOSTED_CI', condition)
        self.assertIn("contains(github.event.pull_request.labels.*.name, 'ci:hosted')", condition)
        runner = next(line for line in text.splitlines() if line.startswith('    runs-on:'))
        self.assertIn('github.event.pull_request.head.repo.full_name != github.repository', runner)


if __name__ == '__main__':
    unittest.main()
