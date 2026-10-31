import json
from pathlib import Path
import subprocess
import sys
import tempfile
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
        for destination in ("heads/main", "refs/heads/main"):
            self.assertBlocked("Execute", {"command": f"git push origin HEAD:{destination}"}, "main only")
        self.assertBlocked("Execute", {"command": 'git -C "/repo with spaces" push origin HEAD:main'}, "main only")
        self.assertBlocked("Execute", {"command": "git -C /repo push --force origin topic"}, "force-push")

    def test_releases_and_hook_bypass_are_blocked(self):
        self.assertBlocked("Execute", {"command": "gh release create v1"}, "authorization")
        self.assertBlocked("Execute", {"command": "git push --tags"}, "authorization")
        self.assertBlocked("Execute", {"command": "git commit --no-verify -m x"}, "hooks")
        self.assertBlocked("Execute", {"command": "git -C /repo push --no-verify origin topic"}, "hooks")

    def test_ordinary_commands_pass(self):
        for command in ("git push -u origin HEAD:chore/topic", "gh pr view 12",
                        "git push origin feature/maintenance", "npm --prefix web ci",
                        "git -C . push origin main-fix",
                        "git log --oneline main"):
            self.assertAllowed("Execute", {"command": command})

    def test_push_rules_stop_at_shell_command_boundaries(self):
        for separator in (" && ", "; ", "\n", " | "):
            for following in ("gh pr create --base main", "echo --force", "echo --tags"):
                self.assertAllowed("Execute", {"command": f"git push -u origin HEAD:topic{separator}{following}"})
            self.assertBlocked("Execute", {"command": f"echo ok{separator}git push origin HEAD:main"}, "main only")
            self.assertBlocked("Execute", {"command": f"git push origin HEAD:main{separator}echo ok"}, "main only")

    def test_command_literals_and_heredoc_data_are_allowed(self):
        for command in ("rg -- '--no-verify' .factory",
                        "printf '%s\\n' 'gh pr merge 12 --squash'",
                        "git log --grep 'gh pr merge'",
                        "gh pr list --search '--no-verify'",
                        "git log --grep --no-verify",
                        "git log --format='%h %s'",
                        'git commit --message="Fix guard"',
                        "git commit -m \"$(cat <<'EOF'\nFix user's settings (part\nEOF\n)\"",
                        "printf '%s\\n' /tmp/a\\ b",
                        "git commit -m 'note; git push --force'",
                        "git log # git push origin main",
                        "python3 - <<'PY'\nprint('git push --force')\nPY\n",
                        "python3 - <<'PY'\nprint(\"unmatched shell quote: '\")\nPY\n"):
            self.assertAllowed("Execute", {"command": command})
        self.assertBlocked("Execute", {"command": "python3 - <<'PY'\nprint('ok')\nPY\ngit push origin main"}, "main only")

    def test_quoted_push_arguments_and_safe_force_option(self):
        self.assertBlocked("Execute", {"command": 'git push origin "HEAD:main"'}, "main only")
        self.assertBlocked("Execute", {"command": "git push '--force' origin topic"}, "force-push")
        self.assertAllowed("Execute", {"command": "git push --force-if-includes origin HEAD:topic"})
        for command in ("git push -fu origin topic", "git push -uvf origin topic", "git push -fuv origin topic"):
            self.assertBlocked("Execute", {"command": command}, "force-push")
        self.assertBlocked("Execute", {"command": "echo $(git push origin main)"}, "main only")
        self.assertBlocked("Execute", {"command": 'output="$(# 1) Push the branch\ngit push origin main\n)"'}, "main only")
        self.assertAllowed("Execute", {"command": "echo \"$(# user's note\ngit log -1\n)\""})
        for command in ("git push -h", "git push --help"):
            self.assertAllowed("Execute", {"command": command})
        self.assertBlocked("Execute", {"command": "git push origin 'main"}, "Cannot parse")

    def test_argument_vectors_classify_git_and_gh(self):
        for command in ('git commit -m "Document --no-verify behavior"',
                        "git commit -m -n", "git merge -n topic", "git commit -mnote",
                        "gh api graphql -f query='{ viewer { login } }'"):
            self.assertAllowed("Execute", {"command": command})
        for command, reason in (("git commit -n -m Change", "hooks"), ("git commit -anm x", "hooks"),
                                ("GIT_TERMINAL_PROMPT=0 git push --force origin topic", "force-push"),
                                ("env GIT_TRACE=1 git push origin main", "main only"),
                                ("/usr/bin/git push origin main", "main only"),
                                ("git -c color.ui=false push --force origin topic", "force-push"),
                                ("git -c color.ui=false push origin HEAD:main", "main only"),
                                ("git --git-dir=.git push origin main", "main only"),
                                ("gh -R o/r pr merge 12", "maintainer"),
                                ("gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'",
                                 "maintainer")):
            self.assertBlocked("Execute", {"command": command}, reason)

    def test_heredoc_quoting_and_here_strings_keep_later_commands(self):
        for command in ("cat <<EOF\nE\\\nOF\ngit push origin main\n",
                        "cat <<\\EOF\nhello\nEOF\ngit push origin main",
                        "cat <<E'O'F\nhello\nEOF\ngit push origin main",
                        'cat <<< "hello"\ngit push origin main'):
            self.assertBlocked("Execute", {"command": command}, "main only")

    def test_shell_syntax_around_commands(self):
        for command in ("if git push origin main; then echo ok; fi", "! git push origin main",
                        "{ git push origin main; }", "2>/dev/null git push origin main",
                        'output="$(git push origin main)"', "echo `git push origin main`",
                        "cat <<'EOF'\nline \\\nEOF\ngit push origin main",
                        "env -u GIT_TRACE git push origin main", "/usr/bin/time -f %E git push origin main",
                        "sudo -u dev git push origin main", "timeout 60 git push origin main",
                        "timeout -k 5 60 git push origin main", "nice -n 5 git push origin main"):
            self.assertBlocked("Execute", {"command": command}, "main only")
        self.assertAllowed("Execute", {"command": "git push origin topic >main 2>&1"})
        self.assertBlocked("Execute", {"command": "env -S 'git push origin main'"}, "Cannot classify")

    def test_push_modes_and_refspecs(self):
        for command in ("git push --dry-run origin HEAD:main", "git push -n --force origin topic",
                        "git push main HEAD:topic", "git push --repo=origin HEAD:topic",
                        "git push --force-if-includes -u origin HEAD:topic"):
            self.assertAllowed("Execute", {"command": command})
        for command, reason in (("git push --mirror origin", "force-push"), ("git push --all origin", "push options"),
                                ("git push --force-w origin topic", "push options"),
                                ("git push origin", "destination branch"), ("git push", "destination branch"),
                                ("git push origin 'refs/heads/*:refs/heads/*'", "destination branch"),
                                ("git push origin :", "destination branch"),
                                ("git push origin topic:", "destination branch"),
                                ("git push origin :main", "main only"), ("git push --repo origin main", "main only"),
                                ("git push origin refs/tags/v1.0.0", "authorization"),
                                ("git push origin tag v1.0.0", "authorization"),
                                ("git rebase -m --no-verify main", "hooks"),
                                ("git commit --no-veri -m change", "hooks"), ("git rebase --no-veri main", "hooks"),
                                ("git commit --no-v -m change", "hooks")):
            self.assertBlocked("Execute", {"command": command}, reason)

    def test_head_push_destination_uses_checked_out_branch(self):
        with tempfile.TemporaryDirectory() as folder:
            subprocess.run(["git", "init", "-q", "-b", "main", folder], check=True)
            payload = {"tool_name": "Execute", "cwd": folder, "tool_input": {"command": "git push origin HEAD"}}
            for branch, code in (("main", 2), ("topic", 0)):
                subprocess.run(["git", "-C", folder, "symbolic-ref", "HEAD", f"refs/heads/{branch}"], check=True)
                result = subprocess.run([sys.executable, "-B", str(GUARD)], input=json.dumps(payload),
                                        capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, code, result.stderr)
            payload["tool_input"]["command"] = f"cd / && git -C {folder} push -u origin HEAD"
            result = subprocess.run([sys.executable, "-B", str(GUARD)], input=json.dumps(payload),
                                    capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            for command, reason in (("git -c remote.origin.push=refs/heads/topic:refs/heads/main push origin topic",
                                     "destination branch"),
                                    ("git -c push.followTags=true push origin HEAD:topic", "follow-tags"),
                                    ("GIT_CONFIG_COUNT=1 git push origin HEAD:topic", "follow-tags")):
                payload["tool_input"]["command"] = command
                result = subprocess.run([sys.executable, "-B", str(GUARD)], input=json.dumps(payload),
                                        capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, 2, command)
                self.assertIn(reason, result.stderr)
            subprocess.run(["git", "-C", folder, "config", "push.followTags", "true"], check=True)
            for command, code in (("git push origin HEAD:topic", 2), ("git push --no-follow-tags origin HEAD:topic", 0),
                                  ("git -c push.followTags=false push origin HEAD:topic", 0)):
                payload["tool_input"]["command"] = command
                result = subprocess.run([sys.executable, "-B", str(GUARD)], input=json.dumps(payload),
                                        capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, code, command + result.stderr)
            subprocess.run(["git", "-C", folder, "config", "--unset", "push.followTags"], check=True)
            for command in ("git branch --show-current && git push -u origin HEAD",
                            "git symbolic-ref --short HEAD && git push origin HEAD",
                            "git worktree list && git push origin HEAD"):
                payload["tool_input"]["command"] = command
                result = subprocess.run([sys.executable, "-B", str(GUARD)], input=json.dumps(payload),
                                        capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, 0, command + result.stderr)
            for command in ("git switch main && git push origin HEAD", "gh pr checkout 12 && git push origin @",
                            "env -C /tmp git push origin HEAD", "env --chdir=/tmp git push origin HEAD",
                            "(cd /tmp); git push origin HEAD", "GIT_DIR=/tmp/x/.git git push origin HEAD",
                            "env GIT_DIR=/tmp/x/.git git push origin HEAD",
                            "export GIT_WORK_TREE=/tmp/x; git push origin HEAD", "git branch -m main && git push origin HEAD",
                            "git symbolic-ref HEAD refs/heads/main && git push origin HEAD",
                            "echo $(git checkout main) && git push origin HEAD"):
                payload["tool_input"]["command"] = command
                result = subprocess.run([sys.executable, "-B", str(GUARD)], input=json.dumps(payload),
                                        capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, 2, command)
                self.assertIn("destination branch", result.stderr)

    def test_shell_expansions_in_push_destinations_are_refused(self):
        for command in ('branch=main; git push origin "HEAD:$branch"', "git push origin HEAD:$branch",
                        "git push origin HEAD:${branch}", 'git push origin "HEAD:$(echo main)"',
                        "git push origin HEAD:`echo main`", "git push origin HEAD:{main,topic}",
                        "git push origin 'HEAD:ma?n'"):
            self.assertBlocked("Execute", {"command": command}, "destination branch")
        for command in ('git push "$remote_and_branch"', 'git push "$remote" HEAD:topic'):
            self.assertBlocked("Execute", {"command": command}, "shell expansion")
        self.assertBlocked("Execute", {"command": 'git commit "$flags" -m x'}, "Cannot classify")
        for command in ('sub=push; git "$sub" --force origin topic', "flag=no-verify; git commit --$flag -m change",
                        'git -c x=1 "$sub" origin topic', 'gh "$group" merge 12', 'gh pr "$action" 12',
                        'gh api "$endpoint" -X PUT', "gh api repos/o/r/pulls --$opt x",
                        'gh api graphql -f "$key=mutation { mergePullRequest(input: {}) { clientMutationId } }"'):
            self.assertBlocked("Execute", {"command": command}, "shell expansion")
        self.assertBlocked("Execute", {"command": 'gh api graphql -f query="mutation { $field }"'}, "Cannot classify")
        for command in ("git push origin 'HEAD:topic'", 'git commit -m "$(git rev-parse HEAD)"',
                        "git push origin '$literal'"):
            self.assertAllowed("Execute", {"command": command})

    def test_gh_options_and_endpoints(self):
        for command in ("gh pr merge --help", "gh release create --help",
                        "gh api repos/o/r/issues/1/comments -f body='Document /pulls/12/merge'",                        "gh api graphql -f query='query($q: String!) { search(query: $q, type: ISSUE, first: 1) "
                        "{ issueCount } }' -f q=mergePullRequest"):
            self.assertAllowed("Execute", {"command": command})
        for command in ("gh --repo=o/r pr merge 12", "gh -Ro/r pr merge 12",
                        "gh api -X PUT 'repos/o/r/pulls/12/merge?merge_method=squash'"):
            self.assertBlocked("Execute", {"command": command}, "maintainer")
        self.assertBlocked("Execute", {"command": "gh --repo=o/r release create v1"}, "authorization")
        for command in ("gh release edit v1.2.3 --draft=false", "gh release delete v1", "gh release upload v1 a.zip"):
            self.assertBlocked("Execute", {"command": command}, "authorization")
        for command in ("gh release view v1", "gh release list", "gh release edit --help", "gh release --help"):
            self.assertAllowed("Execute", {"command": command})

    def test_effective_options_and_hidden_inputs(self):
        for command, reason in (("git push --dry-run --no-dry-run --force origin topic", "force-push"),
                                ("gh pr merge 12 --squash --subject --help", "maintainer"),
                                ("gh api graphql -X POST --input -", "Cannot classify"),
                                ("cd /tmp/elsewhere && gh api graphql -F query=@merge.graphql", "Cannot classify"),
                                ("cd $DIR && gh api graphql -F query=@merge.graphql", "Cannot classify"),
                                ("cat <<EOF\n$(git push origin main)\nEOF", "main only"),
                                ("git -c core.hooksPath=/dev/null commit -m change", "hooks"),
                                ("git config core.hooksPath /dev/null", "hooks"),
                                ("git config set core.hooksPath /dev/null", "hooks"),
                                ("git config core.hooksPath get", "hooks"),
                                ("git config set core.hooksPath list", "hooks")):
            self.assertBlocked("Execute", {"command": command}, reason)
        self.assertAllowed("Execute", {"command": "git commit --no-edit --amend"})
        for command in ("cat <<'EOF'\n$(git push origin main)\nEOF",
                        "echo \"$(printf '%s' \"a\\\"b\")\"", "git config --get core.hooksPath",
                        "git config --get core.hooksPath '^/tmp'", "git config get core.hooksPath",
                        "git config --list"):
            self.assertAllowed("Execute", {"command": command})

    def test_graphql_query_files_are_read(self):
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "merge.graphql").write_text("mutation { mergePullRequest(input: {}) { clientMutationId } }")
            Path(folder, "reply.graphql").write_text("mutation { addPullRequestReviewThreadReply(input: {}) { comment { url } } }")
            payload = {"tool_name": "Execute", "cwd": folder,
                       "tool_input": {"command": "gh api graphql -F query=@merge.graphql"}}
            result = subprocess.run([sys.executable, "-B", str(GUARD)], input=json.dumps(payload),
                                    capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 2, result.stderr)
            payload["tool_input"]["command"] = "gh api graphql -F query=@reply.graphql"
            result = subprocess.run([sys.executable, "-B", str(GUARD)], input=json.dumps(payload),
                                    capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            Path(folder, "sub").mkdir()
            Path(folder, "sub", "body.json").write_text(
                '{"query": "fragment R on MergePullRequestPayload { clientMutationId } '
                'mutation { mergePullRequest(input: {}) { ...R } }"}')
            # The shell reads the merge mutation from the outer directory; sub holds a harmless file.
            Path(folder, "sub", "merge.graphql").write_text("query { viewer { login } }")
            for command in ("(cd sub); gh api graphql -F query=@merge.graphql",
                            "cd sub | cat; gh api graphql -F query=@merge.graphql",
                            "env -C sub gh api graphql -F query=@reply.graphql",
                            "true || cd sub; gh api graphql -F query=@merge.graphql",
                            "if false; then cd sub; fi; gh api graphql -F query=@merge.graphql"):
                payload["tool_input"]["command"] = command
                result = subprocess.run([sys.executable, "-B", str(GUARD)], input=json.dumps(payload),
                                        capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, 2, command)
                self.assertIn("Cannot classify", result.stderr)
            payload["tool_input"]["command"] = "cd sub && gh api graphql --input body.json"
            result = subprocess.run([sys.executable, "-B", str(GUARD)], input=json.dumps(payload),
                                    capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn("maintainer", result.stderr)

    def test_gh_api_variants(self):
        with tempfile.TemporaryDirectory() as folder:
            body = json.dumps({"query": "mutation { mergePullRequest\n(input: {}) { clientMutationId } }"})
            Path(folder, "body.json").write_text(body)
            payload = {"tool_name": "Execute", "cwd": folder,
                       "tool_input": {"command": "gh api graphql --input body.json"}}
            result = subprocess.run([sys.executable, "-B", str(GUARD)], input=json.dumps(payload),
                                    capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 2, result.stderr)
        mutation = "query=mutation { mergePullRequest # note\n(input: {}) { clientMutationId } }"
        for endpoint in ("graphql", "/graphql", "https://api.github.com/graphql"):
            self.assertBlocked("Execute", {"command": f"gh api {endpoint} -f '{mutation}'"}, "maintainer")
        for command in ("gh pr -R o/r merge 12 --squash", "gh pr --repo=o/r merge 12",
                        "gh api repos/o/r/releases -f tag_name=v1.2.3",
                        "gh api repos/o/r/merges -f base=main -f head=topic",
                        "gh api -X PATCH repos/o/r/git/refs/heads/topic -F force=true -f sha=abc",
                        "gh api repos/o/r/pulls/12/reviews -f event=APPROVE",
                        "gh api repos/o/r/pulls/12/reviews/5/events -f event=REQUEST_CHANGES",
                        "gh api repos/o/r/pulls/12/reviews -f event=COMMENT -f event=APPROVE",
                        "gh api -X POST repos/o/r/git/refs --input ref.json",
                        "gh api -X DELETE repos/o/r/contents/a.md -f message=remove -f sha=abc",
                        "gh api -X PUT repos/o/r/contents/a.md -f branch=topic -f message=x -f content=eA==",
                        "gh api graphql -f 'query=mutation { mergePullRequest,(input: {}) { clientMutationId } }'",
                        "gh api graphql -f 'query=mutation { ...F } fragment F on Mutation { x }'",
                        "gh api graphql -f $'query=mutation { # note\\r mergePullRequest(input: {}) { clientMutationId } }'",
                        "gh api graphql -f 'query=mutation { addComment(input: {body: \"\"\"a \\\"\"\" }} \"\"\"}) "
                        "{ clientMutationId } mergePullRequest(input: {}) { clientMutationId } }'",
                        "gh api -iX PUT repos/o/r/pulls/12/merge", "gh api -iXPUT repos/o/r/pulls/12/merge",
                        "gh api graphql -f 'query=mutation($input: MergePullRequestInput! = {pullRequestId: \"P\"}) "
                        "{ mergePullRequest(input: $input) { clientMutationId } }'",
                        "gh api graphql -f 'query=query($mutation: ID) { viewer { login } } "
                        "mutation { mergePullRequest(input: {}) { clientMutationId } }'",
                        "gh api graphql -f 'query=mutation { a: addComment(input: {}) { clientMutationId } "
                        "b: mergePullRequest(input: {}) { clientMutationId } }'"):
            self.assertBlocked("Execute", {"command": command}, "maintainer")
        self.assertBlocked("Execute", {"command": "gh api -iz repos/o/r/pulls"}, "Cannot classify")
        for command in ("gh api repos/o/r/releases", "gh api -X GET repos/o/r/pulls -f state=open",
                        "gh api -i repos/o/r/pulls", "gh api -iXGET repos/o/r/pulls",
                        "gh api repos/o/r/pulls/12/comments/34/replies -f body=ok",
                        "gh api -X PATCH repos/o/r/issues/comments/34 -f body=edited",
                        "gh api repos/o/r/pulls/12/reviews -f event=COMMENT -f body=Review",
                        "gh api repos/o/r/pulls/12/reviews -f body=Draft -f 'comments[][path]=a.py'",
                        "gh api repos/o/r/pulls/12/reviews/5/events -f event=comment",
                        "gh api graphql -f 'query=query { viewer { login } } # mergePullRequest('",
                        "gh api graphql -f 'query=query mutation { viewer { login } }'",
                        "gh api graphql -f 'query=mutation($id: ID!) { r: resolveReviewThread(input: {threadId: $id}) "
                        "{ thread { isResolved } } }' -F id=X"):
            self.assertAllowed("Execute", {"command": command})
    def test_generated_paths_are_normalized(self):
        for path in ("/repo/rust/./bundle-manifest.json", "/repo/rust//bundle-manifest.json"):
            self.assertBlocked("Edit", {"file_path": path}, "generated")
            self.assertBlocked("ApplyPatch", {"input": f"*** Update File: {path}\n"}, "generated")

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
