import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
GUARD = ROOT / ".factory/hooks/guard.py"


def run(tool, data):
    payload = json.dumps({"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": data})
    return subprocess.run([sys.executable, "-B", str(GUARD)], input=payload,
                          capture_output=True, text=True, check=False)


class GuardHookTests(unittest.TestCase):
    def assertBlocked(self, tool, data, reason):
        result = run(tool, data)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn(reason, result.stderr)

    def assertAllowed(self, tool, data):
        result = run(tool, data)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_hook_config_runs_guard_for_mutating_tools(self):
        config = json.loads((ROOT / ".factory/hooks.json").read_text())
        (group,) = config["PreToolUse"]
        self.assertEqual(set(group["matcher"].split("|")), {"Execute", "Create", "Edit", "ApplyPatch"})
        self.assertIn(".factory/hooks/guard.py", group["hooks"][0]["command"])

    def test_merges_are_blocked(self):
        self.assertBlocked("Execute", {"command": "gh pr merge 12 --squash"}, "maintainer")
        for options in ("-X PUT", "-XPUT", "--method PUT", "--method=PUT"):
            self.assertBlocked("Execute", {"command": f"gh api {options} repos/o/r/pulls/12/merge"}, "maintainer")
            self.assertBlocked("Execute", {"command": f"gh api repos/o/r/pulls/12/merge {options}"}, "maintainer")

    def test_merge_status_reads_are_allowed(self):
        for options in ("", "-X GET", "--method GET", "--method=GET"):
            self.assertAllowed("Execute", {"command": f"gh api {options} repos/o/r/pulls/12/merge"})

    def test_shell_continuations_are_normalized(self):
        for newline in ("\n", "\r\n"):
            self.assertBlocked("Execute", {"command": f"git push \\{newline} --force origin topic"}, "force-push")
            self.assertBlocked("Execute", {"command": f"git push \\{newline} origin HEAD:main"}, "main only")
            self.assertAllowed("Execute", {"command": f"git push \\{newline} origin topic"})

    def test_force_pushes_and_main_pushes_are_blocked(self):
        for command in ("git push --force origin topic", "git push -f origin topic",
                        "git push origin +topic", "git push --force-with-lease"):
            self.assertBlocked("Execute", {"command": command}, "force-push")
        self.assertBlocked("Execute", {"command": "git push origin HEAD:main"}, "main only")
        self.assertBlocked("Execute", {"command": "git push origin main"}, "main only")
        self.assertBlocked("Execute", {"command": 'git -C "/repo with spaces" push origin HEAD:main'}, "main only")
        self.assertBlocked("Execute", {"command": "git -C /repo push --force origin topic"}, "force-push")

    def test_releases_and_hook_bypass_are_blocked(self):
        self.assertBlocked("Execute", {"command": "gh release create v1"}, "authorization")
        self.assertBlocked("Execute", {"command": "git push --tags"}, "authorization")
        self.assertBlocked("Execute", {"command": "git commit --no-verify -m x"}, "hooks")

    def test_ordinary_commands_pass(self):
        for command in ("git push -u origin HEAD:chore/topic", "gh pr view 12",
                        "git push origin feature/maintenance", "npm --prefix web ci",
                        "git -C /repo push origin main-fix",
                        "git log --oneline main"):
            self.assertAllowed("Execute", {"command": command})

    def test_protected_files_are_blocked_for_each_edit_tool(self):
        self.assertBlocked("Create", {"file_path": "/repo/.env"}, "environment files")
        self.assertBlocked("Edit", {"file_path": "/repo/web/.env.local"}, "environment files")
        self.assertBlocked("Edit", {"file_path": "/repo/rust/bundle-manifest.json"}, "generated")
        self.assertBlocked("Create", {"file_path": "/repo/.git/config"}, "Git metadata")
        patch = "*** Begin Patch\n*** Update File: /repo/.env.production\n*** End Patch\n"
        self.assertBlocked("ApplyPatch", {"input": patch}, "environment files")
        self.assertBlocked("ApplyPatch", patch, "environment files")

    def test_patch_move_destinations_are_checked(self):
        for destination, reason in ((".env", "environment files"),
                                    (".git/config", "Git metadata"),
                                    ("rust/bundle-manifest.json", "generated")):
            patch = f"*** Update File: /repo/.env.example\n*** Move to: /repo/{destination}\n"
            self.assertBlocked("ApplyPatch", {"input": patch}, reason)
        self.assertAllowed("ApplyPatch", {"input": "*** Update File: /repo/a.py\n*** Move to: /repo/b.py\n"})

    def test_templates_and_ordinary_files_pass(self):
        self.assertAllowed("Create", {"file_path": "/repo/.env.example"})
        self.assertAllowed("Edit", {"file_path": "/repo/web/.env.local.example"})
        self.assertAllowed("Edit", {"file_path": "/repo/docs/development/missions.md"})
        patch = "*** Begin Patch\n*** Add File: /repo/src/lib.rs\n*** End Patch\n"
        self.assertAllowed("ApplyPatch", {"input": patch})

    def test_unreadable_input_fails_closed(self):
        for payload in ("not json", "[]", "null", '{"tool_name":"Execute","tool_input":[]}'):
            result = subprocess.run([sys.executable, "-B", str(GUARD)], input=payload,
                                    capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 2, payload)


if __name__ == "__main__":
    unittest.main()
