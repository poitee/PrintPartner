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

function assertShellCounts(source, expected) {
  const inputs = [
    ["a.sh", source],
    ["a.yml", `steps:\n  - run: |\n${source.split("\n").map((line) => `      ${line}`).join("\n")}`],
    ["a.yaml", `steps:\n  - run: >-\n${source.split("\n").map((line) => `      ${line}`).join("\n")}`],
  ];
  for (const [path, text] of inputs) {
    let counts;
    assert.doesNotThrow(() => { counts = countText(text, path); }, path);
    assert.deepEqual(counts, { todoComments: expected, eslintDisable: 0, rustAllow: 0 }, path);
  }
}

test("Gate: counts backtick substitution spanning lines inside double quotes", () => {
  assertShellCounts(['value="`', "# TODO: executable", '`"'].join("\n"), 1);
});

test("Gate: counts a case arm inside a quoted command substitution", () => {
  assertShellCounts(['value="$(case x in', "x) # TODO: case arm", "printf x ;;", 'esac)"'].join("\n"), 1);
});

test("Gate: counts command substitution comments inside arithmetic", () => {
  assertShellCounts(["value=$(( $(", "# TODO: executable", "printf 1", ") + 2 ))"].join("\n"), 1);
});

test("Gate: counts Rust allow attributes with whitespace after markers", () => {
  const source = [
    "# [allow(dead_code)]",
    "#  [allow(unused)]",
    "#![allow(unused)]",
    "# ! [allow(unused)]",
    "#\n[allow(unused)]",
    "#\n!\n[allow(unused)]",
    '// # [allow(ignored)]',
    'const TEXT: &str = "# ! [allow(ignored)]";',
  ].join("\n");
  let counts;
  assert.doesNotThrow(() => { counts = countText(source, "a.rs"); });
  assert.deepEqual(counts, { todoComments: 0, eslintDisable: 0, rustAllow: 6 });
});

test("Gate: accepts Greptile P1 case-pattern input at old line 383", () => {
  assertShellCounts(`value="$(case x in x) printf '"' ;; esac)"`, 0);
});

test("Gate: accepts Greptile P1 quoted-parenthesis input at old line 348", () => {
  assertShellCounts('echo $(( $(printf "1" "(") + 1 ))', 0);
});

test("Gate: counts Greptile P1 outer heredoc/substitution input at old line 462", () => {
  assertShellCounts(['cat <<EOF "$(printf x', "# TODO: executable", ')"', "# FIXME: literal body", "EOF"].join("\n"), 2);
});

test("conservatively counts shell strings, heredocs, and unfinished constructs", () => {
  const fixtures = [
    ['echo "text\n# TODO: literal\n"\n# TODO: real', 2],
    ["echo 'text\n# TODO: literal\n'\n# TODO: real", 2],
    ["cat <<END.txt\n# TODO: body\nEND.txt\n# TODO: real", 2],
    ["cat 3<<A 4<<B\nTODO in A\nA\nFIXME in B\nB\n# TODO: real", 3],
    [String.raw`echo \$'foo\' # TODO: real`, 1],
    ["cat <<EOF \\\n/dev/stdin # TODO: command\n# TODO: body\nEOF\n# TODO: real", 3],
    ["cat <<EOF\n# TODO: unfinished", 1],
    ['echo "\n# TODO: unfinished', 1],
    ["echo $'it\\'s TODO: literal'", 1],
    ['cat <<< "# TODO: literal"\n# TODO: real', 2],
    ["cat <<EO\\\nF\nTODO: literal body\nEOF", 1],
  ];
  for (const [source, expected] of fixtures) assertShellCounts(source, expected);
});

test("counts every marker key once per physical shell line", () => {
  assert.deepEqual(countText('echo "TODO FIXME eslint-disable eslint-disable # [allow(x)]"', "a.sh"), {
    todoComments: 1, eslintDisable: 1, rustAllow: 1,
  });
});

test("scans YAML run scalars and blocks while excluding unrelated metadata", () => {
  const source = [
    "name: TODO metadata",
    "defaults:",
    "  run:",
    "    working-directory: TODO-directory",
    "steps:",
    '  - run: echo "TODO literal eslint-disable"',
    "    name: FIXME metadata",
    "  - run: |+",
    "      echo 'TODO literal'",
    "      cat <<EOF",
    "      FIXME body",
    "      EOF",
    "    env:",
    "      NOTE: HACK metadata",
    "  - run: >-",
    "      echo HACK",
    "  - 'run': echo TODO",
    "  - run: 'echo",
    "      TODO multiline scalar'",
  ].join("\n");
  for (const path of ["a.yml", "a.yaml"]) {
    let counts;
    assert.doesNotThrow(() => { counts = countText(source, path); });
    assert.deepEqual(counts, { todoComments: 6, eslintDisable: 1, rustAllow: 0 });
  }
});

for (const header of ["|", "|-", "|+", ">", ">-", ">+", "|2", "|2-", "|2+", "|-2", "|+2", ">2", ">2-", ">2+", ">-2", ">+2"]) {
  test(`extracts only YAML run content for block scalar ${header}`, () => {
    for (const prefix of ["run:", "- run:", "  - run:"]) {
      const indent = prefix.indexOf("run");
      const source = [
        `${prefix} ${header} # TODO key line`,
        `${" ".repeat(indent + 2)}echo TODO`,
        "",
        `${" ".repeat(indent + 2)}echo FIXME`,
        `${" ".repeat(indent)}# HACK after block`,
        `${" ".repeat(indent)}description: |`,
        `${" ".repeat(indent + 2)}run: echo TODO not executed`,
      ].join("\n");
      for (const path of ["workflow.yml", "workflow.yaml"]) {
        assert.deepEqual(countText(source, path), { todoComments: 3, eslintDisable: 0, rustAllow: 0 }, prefix);
      }
    }
  });
}

test("extracts YAML run plain scalars starting on the next line", () => {
  for (const source of ["run:\n  echo TODO", "- run:\n    echo TODO", "run: # FIXME metadata\n  echo TODO"]) {
    assert.equal(countText(source, "workflow.yml").todoComments, source.startsWith("run: #") ? 2 : 1);
  }
});

test("extracts single-line YAML run commands with trailing comments and without adjacent keys", () => {
  const source = 'steps:\n  - run: echo "TODO" # FIXME metadata\n    name: HACK metadata\n    env:\n      NOTE: TODO metadata';
  assert.deepEqual(countText(source, "workflow.yml"), { todoComments: 1, eslintDisable: 0, rustAllow: 0 });
});

test("counts YAML comments on the whole physical inline run line", () => {
  for (const source of ["run: echo x # TODO a", "- run: echo x # TODO a", 'run: "echo x" # TODO a', "command: &command echo x\nrun: *command # TODO a"]) {
    assert.deepEqual(countText(source, "workflow.yml"), { todoComments: 1, eslintDisable: 0, rustAllow: 0 });
  }
});

test("counts trailing comments on next-line YAML run values", () => {
  for (const path of ["workflow.yml", "workflow.yaml"]) {
    assert.deepEqual(countText("run:\n  echo ok # TODO", path), {
      todoComments: 1, eslintDisable: 0, rustAllow: 0,
    });
  }
});

test("counts trailing comments on the alias node's own line", () => {
  for (const run of ["run: *command # TODO", "run:\n  *command # TODO"]) {
    assert.deepEqual(countText(`command: &command echo ok\n${run}`, "workflow.yml"), {
      todoComments: 1, eslintDisable: 0, rustAllow: 0,
    });
  }
});

test("counts each physical run line through the value end with comments", () => {
  const source = ["run: # TODO key", '  "echo ok', "  # FIXME middle", '  ok" # HACK end', "# TODO outside", "name: TODO outside"].join("\n");
  assert.deepEqual(countText(source, "workflow.yml"), { todoComments: 3, eslintDisable: 0, rustAllow: 0 });
});

test("excludes non-run fields in flow mappings without dropping comments or aliases", () => {
  for (const source of ["{ name: TODO, run: echo ok }", "{ run: echo ok, name: TODO }"]) {
    assert.equal(countText(source, "workflow.yml").todoComments, 0);
  }
  assert.equal(countText("{ name: FIXME, run: echo TODO } # HACK", "workflow.yml").todoComments, 1);
  assert.equal(countText("{ command: &command echo TODO, name: FIXME, run: *command }", "workflow.yml").todoComments, 1);
});

test("ignores run-like text inside other YAML scalar values", () => {
  for (const source of [
    "description: |\n  run: echo TODO",
    "description: >-\n  run: echo TODO",
    "description: |2-\n  run: echo TODO",
    'description: "text\n  run: echo TODO"',
    "# run: echo TODO\nother: FIXME",
    "defaults:\n  run:\n    working-directory: TODO-folder",
  ]) {
    assert.deepEqual(countText(source, "workflow.yaml"), { todoComments: 0, eslintDisable: 0, rustAllow: 0 });
  }
});

test("counts aliased YAML run scalars and multiple documents", () => {
  const source = "command: &command |\n  echo TODO\nsteps:\n  - run: *command\n---\nrun: echo FIXME";
  assert.equal(countText(source, "workflow.yml").todoComments, 2);
});

test("counts malformed YAML conservatively without throwing", () => {
  assert.doesNotThrow(() => {
    assert.equal(countText("run: [echo TODO", "workflow.yml").todoComments, 1);
  });
});

test("restricts Rust allow counts to emitted lint attributes", () => {
  const source = [
    "#[some_proc_macro(option(allow(foo)))]",
    "#[cfg_attr(allow(condition), some_proc_macro(allow(foo)))]",
    "#[cfg_attr(unix, allow(dead_code), allow(unused_variables))]",
    "#[cfg_attr(unix, cfg_attr(feature = \"x\", allow(unused)), allow(dead_code))]",
  ].join("\n");
  assert.equal(countText(source, "a.rs").rustAllow, 4);
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
    2,
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
  assert.equal(isSourcePath(".github/workflows/web-ci.yml"), true);
  assert.equal(isSourcePath("workflow.yaml"), true);
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
