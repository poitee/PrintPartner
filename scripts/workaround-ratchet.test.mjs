import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compare, countText, isSourcePath, main } from "./workaround-ratchet.mjs";

test("counts comment markers, eslint-disable, and Rust allow attributes", () => {
  const counts = countText(
    [
      "// TODO: remove",
      "# FIXME later",
      " * HACK around upstream",
      "const label = 'TODO list';",
      "// eslint-disable-next-line no-console",
      "#[allow(dead_code)]",
      "#![allow(clippy::all)]",
    ].join("\n"),
  );
  assert.deepEqual(counts, { todoComments: 3, eslintDisable: 1, rustAllow: 2 });
});

test("ignores workaround marker spellings in ordinary quoted text", () => {
  const counts = countText(
    [
      "const single = '// TODO: shown to users';",
      'const double = "/* FIXME */ eslint-disable";',
      "const template = `# HACK: example`;",
    ].join("\n"),
    "a.ts",
  );
  assert.deepEqual(counts, { todoComments: 0, eslintDisable: 0, rustAllow: 0 });
});

test("counts Rust allow attributes but ignores allow spellings in strings and comments", () => {
  const counts = countText(
    [
      'const OUTER: &str = "#[allow(dead_code)]";',
      'const INNER: &str = "#![allow(clippy::all)]";',
      "// #[allow(unused)]",
      "/* #![allow(non_snake_case)] */",
      "#[allow(dead_code)]",
      "#![allow(clippy::all)]",
    ].join("\n"),
    "a.rs",
  );
  assert.deepEqual(counts, { todoComments: 0, eslintDisable: 0, rustAllow: 2 });
});

test("ignores marker spellings in Rust raw strings", () => {
  const counts = countText(
    [
      'const TEXT: &str = r###"// TODO #[allow(dead_code)]"###;',
      'const BYTES: &[u8] = br"#![allow(unused)]";',
    ].join("\n"),
    "a.rs",
  );
  assert.deepEqual(counts, { todoComments: 0, eslintDisable: 0, rustAllow: 0 });
});

test("uses path-specific comment and quote syntax", () => {
  assert.equal(countText(["value = '# TODO'", "# TODO: real"].join("\n"), "a.py").todoComments, 1);
  assert.equal(
    countText(["echo '# TODO'", "echo $#", "echo ${name#prefix}", "# TODO: real"].join("\n"), "a.sh").todoComments,
    1,
  );
  assert.equal(
    countText(['content: "/* TODO */";', "// TODO", "/* TODO: real */"].join("\n"), "a.css").todoComments,
    1,
  );
  assert.equal(
    countText(['<p>TODO</p>', '<div title="<!-- TODO -->">', "<!-- TODO: real -->"].join("\n"), "a.html").todoComments,
    1,
  );
});

test("counts real marker comments without counting code after a block close", () => {
  assert.deepEqual(
    countText("fn borrow<'a>(value: &'a str) -> &'a str { value } // TODO: simplify", "a.rs"),
    {
      todoComments: 1,
      eslintDisable: 0,
      rustAllow: 0,
    },
  );
  assert.deepEqual(
    countText(["// eslint-disable-next-line no-console", "/* closed */ const TODO = 1;"].join("\n"), "a.ts"),
    {
      todoComments: 0,
      eslintDisable: 1,
      rustAllow: 0,
    },
  );
});

test("only scans source extensions and skips the ratchet itself", () => {
  assert.equal(isSourcePath("rust/crates/pp-core/src/lib.rs"), true);
  assert.equal(isSourcePath("web/apps/web/src/App.tsx"), true);
  assert.equal(isSourcePath("docs/ARCHITECTURE.md"), false);
  assert.equal(isSourcePath("scripts/workaround-ratchet.mjs"), false);
});

test("fails on increases and allows decreases", () => {
  const baseline = { todoComments: 2, eslintDisable: 1, rustAllow: 0 };
  assert.deepEqual(compare({ todoComments: 2, eslintDisable: 1, rustAllow: 0 }, baseline).increased, []);
  assert.equal(compare({ todoComments: 1, eslintDisable: 0, rustAllow: 0 }, baseline).decreased.length, 2);
  assert.deepEqual(compare({ todoComments: 2, eslintDisable: 1, rustAllow: 1 }, baseline).increased, [
    { key: "rustAllow", current: 1, allowed: 0 },
  ]);
  assert.throws(() => compare({ todoComments: 0, eslintDisable: 0, rustAllow: 0 }, { todoComments: 0 }));
});

test("main checks tracked files against the baseline", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ratchet-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "a.rs"), "#[allow(unused)]\nfn a() {}\n");
  writeFileSync(join(root, "untracked.ts"), "// TODO ignored because untracked\n");
  execFileSync("git", ["add", "a.rs"], { cwd: root });
  const baselinePath = join(root, "baseline.json");
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});

  assert.equal(main(["--update"], root, baselinePath), 0);
  assert.deepEqual(JSON.parse(readFileSync(baselinePath, "utf8")), {
    todoComments: 0,
    eslintDisable: 0,
    rustAllow: 1,
  });
  assert.equal(main([], root, baselinePath), 0);

  writeFileSync(join(root, "a.rs"), "#[allow(unused)]\n#[allow(dead_code)]\nfn a() {}\n");
  assert.equal(main([], root, baselinePath), 1);
});

test("counts bare markers on lines inside multi-line block comments", () => {
  const ts = ["/*", "  TODO: remove workaround", "  plain line", "*/", "TODO_LIST.push(1);"].join("\n");
  assert.equal(countText(ts, "web/a.ts").todoComments, 1);
  assert.equal(countText(["/**", " * docs", "FIXME no star prefix", " */"].join("\n"), "a.rs").todoComments, 1);
  assert.equal(countText(["<!--", "HACK: inline", "-->"].join("\n"), "index.html").todoComments, 1);
  assert.equal(countText(["/* note */", "const TODO = 1;"].join("\n"), "a.ts").todoComments, 0);
  assert.equal(countText(['const glob = "src/**/*.ts";', "const TODO = 1;"].join("\n"), "a.ts").todoComments, 0);
  assert.equal(countText(["fn f<'a>(s: &'a str) {} // ok", "let TODO = 1;"].join("\n"), "a.rs").todoComments, 0);
  assert.equal(countText(["x = '/*'", "TODO = 1"].join("\n"), "a.py").todoComments, 0);
});

test("--update refuses to raise an existing baseline and still lowers it", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ratchet-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "a.rs"), "#[allow(unused)]\nfn a() {}\n");
  execFileSync("git", ["add", "a.rs"], { cwd: root });
  const baselinePath = join(root, "baseline.json");
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  const baseline = () => JSON.parse(readFileSync(baselinePath, "utf8"));

  assert.equal(main(["--update"], root, baselinePath), 0);
  assert.equal(baseline().rustAllow, 1);

  writeFileSync(join(root, "a.rs"), "#[allow(unused)]\n#[allow(dead_code)]\nfn a() {}\n");
  assert.equal(main(["--update"], root, baselinePath), 1);
  assert.equal(baseline().rustAllow, 1, "a refused update leaves the baseline unchanged");

  writeFileSync(join(root, "a.rs"), "fn a() {}\n");
  assert.equal(main(["--update"], root, baselinePath), 0);
  assert.equal(baseline().rustAllow, 0);
});
