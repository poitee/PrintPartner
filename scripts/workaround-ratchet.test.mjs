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

test("distinguishes JSX text and attributes from embedded comments", () => {
  const text = `const node = <div data-note="// FIXME: attribute">It's /* HACK: text */ {/* TODO: real */}</div>;`;
  assert.deepEqual(countText(text, "a.tsx"), { todoComments: 1, eslintDisable: 0, rustAllow: 0 });
});

test("returns from nested JSX expressions, fragments, and self-closing tags", () => {
  const text = [
    "const node = (",
    '  <section data-note="',
    "    // TODO: attribute",
    '  ">',
    "    <>",
    "      {ready ? <span>{value /* TODO: nested */}</span> : <Fallback />}",
    "    </>",
    "  </section>",
    ");",
    "// FIXME: after JSX",
  ].join("\n");
  assert.deepEqual(countText(text, "a.tsx"), { todoComments: 2, eslintDisable: 0, rustAllow: 0 });
});

test("counts comments in JSX opening tags but not text or attributes", () => {
  const text = [
    'const block = <p data-note="/* TODO: attribute */" /* TODO: block */>/* FIXME: text */</p>;',
    "const line = <p // HACK: line",
    ">text</p>;",
  ].join("\n");
  assert.deepEqual(countText(text, "a.tsx"), { todoComments: 2, eslintDisable: 0, rustAllow: 0 });
});

test("counts comments in direct and nested template expressions", () => {
  const text = [
    "const literal = `// TODO: literal /* FIXME */`;",
    "const direct = `${",
    "  input // TODO: direct",
    "}`;",
    "const nested = `${{",
    "  value: `inner /* TODO: literal */",
    "    ${input /* FIXME: nested */}",
    "  `,",
    "} /* HACK: outer */}`;",
  ].join("\n");
  assert.deepEqual(countText(text, "a.ts"), { todoComments: 3, eslintDisable: 0, rustAllow: 0 });
});

test("keeps regex braces and TSX generics in their code contexts", () => {
  const text = [
    "const map = <T extends { id: string }>(value: T) => value;",
    "const result = map<Result<{ id: string }>>(value);",
    "const matched = `${",
    "  /\\}|[}]|a{1,2}|https?:\\/\\/TODO/.test(input)",
    "    ? value /* TODO: regex-safe */",
    "    : other",
    "}`;",
    "// FIXME: after template",
  ].join("\n");
  assert.deepEqual(countText(text, "a.tsx"), { todoComments: 2, eslintDisable: 0, rustAllow: 0 });
});

test("keeps definite multiline TSX generic heads in code", () => {
  const text = [
    "const identity = <T,>(",
    "  value: T,",
    ") => value;",
    "// TODO: real",
  ].join("\n");
  assert.deepEqual(countText(text, "a.tsx"), { todoComments: 1, eslintDisable: 0, rustAllow: 0 });
});

test("classifies postfix and binary punctuation before slash tokens", () => {
  const fixtures = {
    nonNullDivision: "const ratio = value! / divisor; /* TODO: real */",
    incrementDivision: "const ratio = value++ / divisor; /* TODO: real */",
    decrementDivision: "const ratio = value-- / divisor; /* TODO: real */",
    plusRegex: "const result = `${1 + /}/.test(value) /* TODO: real */}`;",
    minusRegex: "const result = `${1 - /}/.test(value) /* TODO: real */}`;",
    inequalityRegex: "const result = value != /}/.test(value); /* TODO: real */",
    strictInequalityRegex: "const result = value !== /}/.test(value); /* TODO: real */",
    controlRegex: [
      "const result = `${(() => {",
      "  if (ready) /}/.test(value);",
      "  return 1;",
      "})() /* TODO: real */}`;",
    ].join("\n"),
  };
  const actual = Object.fromEntries(
    Object.entries(fixtures).map(([name, source]) => [name, countText(source, "a.ts")]),
  );
  const expected = { todoComments: 1, eslintDisable: 0, rustAllow: 0 };
  assert.deepEqual(actual, Object.fromEntries(Object.keys(fixtures).map((name) => [name, expected])));
});

test("parses final reviewer JavaScript and TypeScript cases", () => {
  const fixtures = {
    memberNamedIf: {
      path: "a.ts",
      source: "const ratio = obj.if(value) / divisor; /* TODO: real */",
    },
    elseRegex: {
      path: "a.ts",
      source: [
        "const result = `${(() => {",
        "  if (ready) /x/.test(value);",
        "  else /}/.test(value);",
        "  return 1;",
        "})() /* TODO: real */}`;",
      ].join("\n"),
    },
    multipleTypeParameters: {
      path: "a.tsx",
      source: [
        "const pair = <T, U>(",
        "  left: T, right: U,",
        ") => [left, right];",
        "// TODO: real",
      ].join("\n"),
    },
    constrainedTypeParameter: {
      path: "a.tsx",
      source: [
        "const identity = <T extends unknown>(",
        "  value: T,",
        ") => value;",
        "// TODO: real",
      ].join("\n"),
    },
    jsxApostropheBeforeArrow: {
      path: "a.tsx",
      source: "const node = <p>(Don't panic)</p>; const later = () => 1; // TODO: real",
    },
    jsxApostrophe: {
      path: "a.tsx",
      source: "const node = <p>Don't panic</p>; // TODO: real",
    },
    unicodeDivision: {
      path: "a.ts",
      source: "const café = value; const ratio = café / divisor; /* TODO: real */",
    },
  };
  const actual = Object.fromEntries(
    Object.entries(fixtures).map(([name, { path, source }]) => [name, countText(source, path).todoComments]),
  );
  assert.deepEqual(actual, Object.fromEntries(Object.keys(fixtures).map((name) => [name, 1])));
});

test("counts parser comments once per key per physical line", () => {
  assert.deepEqual(countText("/* TODO */ /* FIXME */ // eslint-disable TODO", "a.ts"), {
    todoComments: 1,
    eslintDisable: 1,
    rustAllow: 0,
  });
  assert.deepEqual(
    countText("/* TODO one\r\nFIXME two\rHACK three\u2028TODO four\u2029eslint-disable five */", "a.ts"),
    {
      todoComments: 4,
      eslintDisable: 1,
      rustAllow: 0,
    },
  );
});

test("uses parser comment semantics for supported JavaScript extensions", () => {
  const source = "const value = `${1 /* TODO: real */}`;";
  for (const extension of ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]) {
    assert.equal(countText(source, `a.${extension}`).todoComments, 1, extension);
  }
});

test("reports malformed JavaScript with its path and parser cause", () => {
  assert.throws(
    () => countText("const =", "web/broken.ts"),
    (error) => {
      assert.match(error.message, /web\/broken\.ts/);
      assert.ok(error.cause instanceof Error);
      return true;
    },
  );
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

test("keeps Rust character literals separate from strings and lifetimes", () => {
  const fixtures = {
    quote: ["let quote = '\"'; // TODO: real", "#[allow(dead_code)]"].join("\n"),
    escapedQuote: ["let quote = '\\\"'; // TODO: real", "#![allow(dead_code)]"].join("\n"),
    controls: [
      "fn borrow<'a>(value: &'a str) -> &'a str { value } // TODO: real",
      "'outer: loop { break 'outer; }",
      "let apostrophe = '\\'';",
      "let slash = '\\\\';",
      "let hex = '\\x22';",
      "let unicode_escape = '\\u{1F600}';",
      "let unicode = 'é';",
      "#[allow(dead_code)]",
    ].join("\n"),
  };
  const actual = Object.fromEntries(
    Object.entries(fixtures).map(([name, source]) => [name, countText(source, "a.rs")]),
  );
  const expected = { todoComments: 1, eslintDisable: 0, rustAllow: 1 };
  assert.deepEqual(actual, { quote: expected, escapedQuote: expected, controls: expected });
});

test("ignores markers inside multiline shell quotes and heredocs", () => {
  const multilineDouble = ['echo "text', "# TODO shown to users", '"', "# TODO: real"].join("\n");
  assert.deepEqual(countText(multilineDouble, "a.sh"), { todoComments: 1, eslintDisable: 0, rustAllow: 0 });

  const multilineSingle = ["echo 'text", "# TODO shown to users", "'", "# TODO: real"].join("\n");
  assert.deepEqual(countText(multilineSingle, "a.sh"), { todoComments: 1, eslintDisable: 0, rustAllow: 0 });

  const heredoc = ["cat <<EOF", "# TODO in heredoc", "EOF", "# TODO: real"].join("\n");
  assert.deepEqual(countText(heredoc, "a.sh"), { todoComments: 1, eslintDisable: 0, rustAllow: 0 });

  assert.equal(
    countText(["cat <<'EOF'", "FIXME inside", "EOF"].join("\n"), "a.sh").todoComments,
    0,
  );
  assert.equal(
    countText(["cat <<'EOF'", "FIXME inside", "EOF", "# TODO: real"].join("\n"), "a.sh").todoComments,
    1,
  );
});

test("counts workaround markers inside nested Rust block comments", () => {
  const nested = "/* outer /* inner */ TODO hidden */";
  assert.deepEqual(countText(nested, "a.rs"), { todoComments: 1, eslintDisable: 0, rustAllow: 0 });
});

test("counts spaced, multiline, and cfg_attr Rust allow attributes", () => {
  const source = [
    "#[allow (dead_code)]",
    "#[",
    "allow(clippy::all)",
    "]",
    "#![cfg_attr(unix, allow(unused))]",
    'const IGNORED = "#[allow(dead_code)]";',
  ].join("\n");
  assert.deepEqual(countText(source, "a.rs"), { todoComments: 0, eslintDisable: 0, rustAllow: 3 });
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
