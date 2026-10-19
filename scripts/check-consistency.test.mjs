import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkRepo, citedTests, declaredTests } from "./check-consistency.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("./check-consistency.mjs", import.meta.url));
const json = (value) => JSON.stringify(value, null, 2);
const TEMPLATE = (file) => readFileSync(join(repoRoot, "scripts/plugin-template", file), "utf8");
/** Gives alpha the shared SchemaFor files as exact copies of the template. */
const withSchema = (files) => {
  files["plugins/alpha/hooks/schema.ts"] = TEMPLATE("hooks/schema.ts.tmpl");
  files["plugins/alpha/tests/schema-types.ts"] = TEMPLATE("tests/schema-types.ts.tmpl");
};

/** A minimal repository with one plugin, "alpha", that passes every check. Tests change one file at a time. */
function baseFiles() {
  return {
    ".claude-plugin/marketplace.json": json({
      name: "market",
      plugins: [{ name: "alpha", source: "./plugins/alpha", description: "Alpha does things." }],
    }),
    "plugins/alpha/.claude-plugin/plugin.json": json({ name: "alpha", version: "1.2.3", description: "Alpha does things." }),
    "plugins/alpha/hooks/hooks.json": "{}",
    "plugins/alpha/tsconfig.json": json({ extends: "./.claude-plugin/types/tsconfig.json", compilerOptions: { noEmit: true } }),
    "plugins/alpha/README.md": "# alpha\n",
    "plugins/alpha/AGENTS.md": [
      "# alpha",
      "- Pinned: `tests/alpha.test.ts` (`the first one`, `it keeps the user's tab` and `third`).",
      "- Also `tests/alpha.test.ts`: `a quoted \"name\"`; the `plain code` span is not a citation.",
      "- Either file: `tests/{alpha,beta}.test.ts` (`only in beta`).",
      "",
    ].join("\n"),
    "plugins/alpha/tests/alpha.test.ts": [
      "test('the first one', () => {})",
      "test('it keeps the user\\'s tab', () => {})",
      "it(`third`, () => {})",
      'test("a quoted \\"name\\"", () => {})',
      "",
    ].join("\n"),
    "plugins/alpha/tests/beta.test.ts": "test.skip('only in beta', () => {})\n",
    "plugins/alpha/skills/s/SKILL.md": "---\nname: s\ndescription: A skill.\n---\nBody\n",
    "AGENTS.md": "# AGENTS.md\n\n- Alpha things: `plugins/alpha/AGENTS.md`.\n",
    "README.md": [
      "| Plugin | What it does |",
      "| --- | --- |",
      "| [alpha](plugins/alpha/README.md) | Short summary. |",
      "",
      "```",
      "/plugin install alpha@market",
      "```",
      "",
    ].join("\n"),
  };
}

/** Writes the files into a temp directory, applies nothing else, and returns its path. */
function writeTree(t, files) {
  const root = mkdtempSync(join(tmpdir(), "check-consistency-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/** Edits the base files with `change(files)` and returns the problems checkRepo reports. */
function problems(t, change = () => {}) {
  const files = baseFiles();
  change(files);
  for (const [path, content] of Object.entries(files)) if (content === undefined) delete files[path];
  return checkRepo(writeTree(t, files)).errors;
}

const edit = (path, change) => (files) => {
  files[path] = change(files[path]);
};
const marketplace = (change) => edit(".claude-plugin/marketplace.json", (text) => json(change(JSON.parse(text))));

test("the repository passes every check", () => {
  const { errors, count } = checkRepo(repoRoot);
  assert.deepEqual(errors, []);
  assert.ok(count > 0);
});

test("the fixture repository passes every check", (t) => {
  assert.deepEqual(problems(t), []);
});

test("a plugin whose SchemaFor files are exact copies of the template passes", (t) => {
  assert.deepEqual(problems(t, withSchema), []);
});

test("the command prints one line per problem and exits 1, or prints ok", (t) => {
  const bad = baseFiles();
  delete bad["plugins/alpha/README.md"];
  bad["README.md"] = "";
  const failing = spawnSync(process.execPath, [script], { cwd: writeTree(t, bad), encoding: "utf8" });
  assert.equal(failing.status, 1);
  assert.equal(failing.stdout, "");
  assert.deepEqual(failing.stderr.trimEnd().split("\n"), [
    "alpha: README.md is missing",
    "alpha: root README.md has no table row whose first cell links plugins/alpha",
    'alpha: root README.md has no "/plugin install alpha@market" line',
  ]);

  const passing = spawnSync(process.execPath, [script], { cwd: writeTree(t, baseFiles()), encoding: "utf8" });
  assert.equal(passing.status, 0);
  assert.equal(passing.stdout, "ok: 1 plugins\n");
  assert.equal(passing.stderr, "");
});

// Each case breaks one rule of the new-plugin checklist and names the line that reports it.
for (const { name, change, expected } of [
  { name: "tsconfig missing", change: edit("plugins/alpha/tsconfig.json", () => undefined), expected: ["alpha: tsconfig.json is missing"] },
  {
    name: "tsconfig that does not extend the generated typings",
    change: edit("plugins/alpha/tsconfig.json", () => json({ extends: "../../tsconfig.base.json", compilerOptions: { noEmit: true } })),
    expected: ['alpha: tsconfig.json must extend "./.claude-plugin/types/tsconfig.json"'],
  },
  {
    name: "tsconfig that lets tsc emit JavaScript",
    change: edit("plugins/alpha/tsconfig.json", () => json({ extends: "./.claude-plugin/types/tsconfig.json" })),
    expected: ['alpha: tsconfig.json must set "compilerOptions": { "noEmit": true }'],
  },
  { name: "tsconfig that is not JSON", change: edit("plugins/alpha/tsconfig.json", () => "{"), expected: ["alpha: tsconfig.json is not valid JSON"] },
  { name: "plugin AGENTS.md missing", change: edit("plugins/alpha/AGENTS.md", () => undefined), expected: ["alpha: AGENTS.md is missing"] },
  { name: "plugin README.md missing", change: edit("plugins/alpha/README.md", () => undefined), expected: ["alpha: README.md is missing"] },
  {
    name: "plugin-root CLAUDE.md",
    change: (files) => (files["plugins/alpha/CLAUDE.md"] = "@AGENTS.md\n"),
    expected: ["alpha: CLAUDE.md in the plugin root draws a validation warning; keep guidance in AGENTS.md"],
  },
  {
    name: "root AGENTS.md without the plugin",
    change: edit("AGENTS.md", () => "# AGENTS.md\n\n- Alpha things: plugins/alpha/AGENTS.md without backticks.\n"),
    expected: ["alpha: root AGENTS.md does not cite `plugins/alpha/AGENTS.md`"],
  },
  {
    name: "root README row that links another plugin",
    change: edit("README.md", (text) => text.replace("[alpha](plugins/alpha/README.md)", "[alpha](plugins/other)")),
    expected: ["alpha: root README.md has no table row whose first cell links plugins/alpha"],
  },
  {
    name: "root README without the install line",
    change: edit("README.md", (text) => text.replace("/plugin install alpha@market", "/plugin install alpha")),
    expected: ['alpha: root README.md has no "/plugin install alpha@market" line'],
  },
  {
    name: "plugin directory without a marketplace entry",
    change: (files) => {
      files["plugins/ghost/.claude-plugin/plugin.json"] = "{}";
    },
    expected: ["plugins/ghost: no marketplace.json entry"],
  },
  {
    name: "plugin directory that holds only the generated typings",
    change: (files) => {
      files["plugins/ghost/.claude-plugin/types/tsconfig.json"] = "{}";
    },
    expected: ["plugins/ghost: no marketplace.json entry (only the generated .claude-plugin/types/ is left; delete the directory)"],
  },
  {
    name: "plugin directory with a manifest beside the generated typings",
    change: (files) => {
      files["plugins/ghost/.claude-plugin/types/tsconfig.json"] = "{}";
      files["plugins/ghost/.claude-plugin/plugin.json"] = "{}";
    },
    expected: ["plugins/ghost: no marketplace.json entry"],
  },
  {
    name: "plugin directory with source beside the generated typings",
    change: (files) => {
      files["plugins/ghost/.claude-plugin/types/tsconfig.json"] = "{}";
      files["plugins/ghost/hooks/register.tsx"] = "export {}\n";
    },
    expected: ["plugins/ghost: no marketplace.json entry"],
  },
  {
    name: "plugin.json name that is not the directory name",
    change: edit("plugins/alpha/.claude-plugin/plugin.json", (text) => text.replace('"name": "alpha"', '"name": "omega"')),
    expected: ['alpha: plugin.json name is "omega"'],
  },
  ...["1.2", "v1.2.3", "1.2.3.4", "1.2.3-rc.1", "1.2.x", ""].map((version) => ({
    name: `plugin.json version "${version}"`,
    change: edit("plugins/alpha/.claude-plugin/plugin.json", (text) => text.replace("1.2.3", version)),
    expected: [`alpha: invalid version "${version}"`],
  })),
  {
    name: "plugin.json without a version",
    change: edit("plugins/alpha/.claude-plugin/plugin.json", () => json({ name: "alpha", description: "Alpha does things." })),
    expected: ['alpha: invalid version "undefined"'],
  },
  {
    name: "plugin.json and marketplace entry that both lack a description",
    change: (files) => {
      files["plugins/alpha/.claude-plugin/plugin.json"] = json({ name: "alpha", version: "1.2.3" });
      files[".claude-plugin/marketplace.json"] = json({ name: "market", plugins: [{ name: "alpha", source: "./plugins/alpha" }] });
    },
    expected: ["alpha: plugin.json has no description"],
  },
  {
    name: "plugin.json and marketplace entry with a blank description",
    change: (files) => {
      files["plugins/alpha/.claude-plugin/plugin.json"] = json({ name: "alpha", version: "1.2.3", description: "  " });
      files[".claude-plugin/marketplace.json"] = json({ name: "market", plugins: [{ name: "alpha", source: "./plugins/alpha", description: "  " }] });
    },
    expected: ["alpha: plugin.json has no description"],
  },
  {
    name: "hooks.json missing",
    change: edit("plugins/alpha/hooks/hooks.json", () => undefined),
    expected: ["alpha: hooks/hooks.json is missing"],
  },
  {
    name: "hooks.json that is not JSON",
    change: edit("plugins/alpha/hooks/hooks.json", () => "{"),
    expected: ["alpha: hooks/hooks.json is not valid JSON"],
  },
  ...[
    ["a cell with text after the link", "| [alpha](plugins/alpha/README.md) and more | Short summary. |"],
    ["a row that does not start at the line start", "see | [alpha](plugins/alpha/README.md) | Short summary. |"],
    ["a link without the closing cell bar", "| [alpha](plugins/alpha/README.md) Short summary."],
    ["a plugin whose name only starts like it", "| [alpha](plugins/alpha-two/README.md) | Short summary. |"],
    ["the plugin name in a longer link text", "| [alpha-two](plugins/alpha/README.md) | Short summary. |"],
  ].map(([name, row]) => ({
    name: `root README row with ${name}`,
    change: edit("README.md", (text) => text.replace("| [alpha](plugins/alpha/README.md) | Short summary. |", row)),
    expected: ["alpha: root README.md has no table row whose first cell links plugins/alpha"],
  })),
  {
    name: "marketplace entry without a plugin directory",
    change: marketplace((m) => ({ ...m, plugins: [...m.plugins, { name: "gone", source: "./plugins/gone", description: "x" }] })),
    expected: ["gone: ./plugins/gone is missing"],
  },
  {
    name: "marketplace source that is not plugins/<name>",
    change: marketplace((m) => ({ ...m, plugins: [{ ...m.plugins[0], source: "./plugins/alpha/" }] })),
    expected: ['alpha: marketplace source is "./plugins/alpha/", expected "./plugins/alpha"'],
  },
  {
    name: "marketplace description that differs from plugin.json",
    change: marketplace((m) => ({ ...m, plugins: [{ ...m.plugins[0], description: "Alpha did things." }] })),
    expected: ["alpha: marketplace.json description differs from plugin.json (copy the plugin.json text)"],
  },
  {
    name: "plugin.json description changed alone",
    change: edit("plugins/alpha/.claude-plugin/plugin.json", (text) => text.replace("does things", "does more")),
    expected: ["alpha: marketplace.json description differs from plugin.json (copy the plugin.json text)"],
  },
  {
    name: "a skill whose frontmatter names another directory",
    change: edit("plugins/alpha/skills/s/SKILL.md", (text) => text.replace("name: s", "name: t")),
    expected: ['alpha: ./plugins/alpha/skills/s/SKILL.md is missing or its frontmatter does not name "s"'],
  },
  {
    name: "a skill with a further frontmatter field after its description",
    change: edit("plugins/alpha/skills/s/SKILL.md", (text) => text.replace(/(description: .+\n)/, "$1disable-model-invocation: true\n")),
    expected: [],
  },
  {
    name: "a cited test that was renamed",
    change: edit("plugins/alpha/tests/alpha.test.ts", (text) => text.replace("the first one", "the first one, renamed")),
    expected: ['alpha: AGENTS.md cites test "the first one", which tests/alpha.test.ts does not declare'],
  },
  {
    name: "a cited test that moved to another file",
    change: (files) => {
      files["plugins/alpha/tests/alpha.test.ts"] = files["plugins/alpha/tests/alpha.test.ts"].replace("it(`third`, () => {})\n", "");
      files["plugins/alpha/tests/beta.test.ts"] += "it('third', () => {})\n";
    },
    expected: ['alpha: AGENTS.md cites test "third", which tests/alpha.test.ts does not declare'],
  },
  {
    name: "a cited test file that does not exist",
    change: edit("plugins/alpha/AGENTS.md", (text) => text + "- See `tests/missing.test.ts` (`a name`).\n"),
    expected: ["alpha: AGENTS.md cites tests/missing.test.ts, which does not exist"],
  },
  {
    name: "a hooks/schema.ts that differs from the template",
    change: (files) => {
      withSchema(files);
      files["plugins/alpha/hooks/schema.ts"] = files["plugins/alpha/hooks/schema.ts"].replace("enum: AllOf<V>", "enum: readonly V[]");
    },
    expected: ["alpha: hooks/schema.ts differs from scripts/plugin-template/hooks/schema.ts.tmpl (copy the template)"],
  },
  {
    name: "type tests that differ from the template",
    change: (files) => {
      withSchema(files);
      files["plugins/alpha/tests/schema-types.ts"] += "\n";
    },
    expected: ["alpha: tests/schema-types.ts differs from scripts/plugin-template/tests/schema-types.ts.tmpl (copy the template)"],
  },
  {
    name: "a hooks/schema.ts without its type tests",
    change: (files) => {
      withSchema(files);
      delete files["plugins/alpha/tests/schema-types.ts"];
    },
    expected: ["alpha: tests/schema-types.ts is missing (copy scripts/plugin-template/tests/schema-types.ts.tmpl)"],
  },
]) {
  test(`fails: ${name}`, (t) => {
    const found = problems(t, change);
    assert.deepEqual(found, expected);
  });
}

test("a citation counts only after a test file reference and only in the two shapes", () => {
  const { cites, referenced } = citedTests(
    [
      "Code `not a citation` and `tests/a.test.ts` (`one`, `two` and `three`) then `after the list`.",
      "Colon: `tests/b.test.ts`: `four` but not `five`.",
      "Plain `tests/c.test.ts` mention, `six` follows without a shape.",
      "Braces: `tests/{d,e}.test.mjs` (`seven`).",
    ].join("\n"),
  );
  assert.deepEqual(cites, [
    { files: ["tests/a.test.ts"], name: "one" },
    { files: ["tests/a.test.ts"], name: "two" },
    { files: ["tests/a.test.ts"], name: "three" },
    { files: ["tests/b.test.ts"], name: "four" },
    { files: ["tests/d.test.mjs", "tests/e.test.mjs"], name: "seven" },
  ]);
  assert.deepEqual([...referenced].sort(), ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts", "tests/d.test.mjs", "tests/e.test.mjs"]);
});

test("declared test names resolve string escapes and ignore calls that are not declarations", () => {
  const names = declaredTests(
    [
      "test('it keeps the user\\'s tab', () => {})",
      'test("say \\"hi\\"", () => {})',
      "test(`a template`, () => {})",
      "describe.only('a group', () => {})",
      "test(\n  'name on the next line',\n  () => {},\n)",
      "test('tab\\there \\u00e9 \\x41', () => {})",
      "contest('not a test', () => {})",
    ].join("\n"),
  );
  assert.deepEqual(
    [...names].sort(),
    ["a group", "a template", "it keeps the user's tab", "name on the next line", 'say "hi"', "tab\there é A"].sort(),
  );
});

/** Turns alpha into a plugin that ships skills only: no hooks module and no typings. */
const skillsOnly = (files) => {
  delete files["plugins/alpha/hooks/hooks.json"];
  delete files["plugins/alpha/tsconfig.json"];
};

test("a plugin with neither hooks nor tsconfig.json passes when it ships a skill", (t) => {
  assert.deepEqual(problems(t, skillsOnly), []);
});

test("a plugin with neither hooks nor tsconfig.json and no skill is reported", (t) => {
  assert.deepEqual(
    problems(t, (files) => {
      skillsOnly(files);
      delete files["plugins/alpha/skills/s/SKILL.md"];
    }),
    ["alpha: has no hooks/hooks.json and no skill under skills/"],
  );
});

test("a helper/test file counts as a test file reference, alone or in braces", (t) => {
  const { cites, referenced } = citedTests("Pinned by `helper/test/config.test.mjs` (`one`) and `helper/test/{a,b}.test.mjs`: `two`; `tests/c.test.ts`.");
  assert.deepEqual(cites, [
    { files: ["helper/test/config.test.mjs"], name: "one" },
    { files: ["helper/test/a.test.mjs", "helper/test/b.test.mjs"], name: "two" },
  ]);
  assert.deepEqual([...referenced].sort(), ["helper/test/a.test.mjs", "helper/test/b.test.mjs", "helper/test/config.test.mjs", "tests/c.test.ts"]);
  assert.deepEqual(citedTests("`other/test/x.test.mjs` and `src/host.ts` are not test files.").referenced.size, 0);
});

test("a support file under tests/ or helper/test/ is referenced but never an anchor or a name", () => {
  const { cites, referenced } = citedTests(
    "Fake in `tests/host.ts`, contract in `helper/test/contract.mjs`, `tests/sub/x.mts` and `tests/a.test.ts` (`one`, `tests/host.ts` and `two`); `tests/a.test.ts`: `tests/host.ts`; `tests/host.ts`: `not a name`; `tests/../x.ts`.",
  );
  assert.deepEqual(cites, [{ files: ["tests/a.test.ts"], name: "one" }]);
  assert.deepEqual([...referenced].sort(), ["helper/test/contract.mjs", "tests/a.test.ts", "tests/host.ts", "tests/sub/x.mts"]);
});

for (const { name, change, expected } of [
  {
    name: "a cited support file that does not exist",
    change: edit("plugins/alpha/AGENTS.md", (text) => text + "- Fake: `tests/host.ts`.\n"),
    expected: ["alpha: AGENTS.md cites tests/host.ts, which does not exist"],
  },
  {
    name: "a cited helper/test support file that does not exist",
    change: edit("plugins/alpha/AGENTS.md", (text) => text + "- Contract: `helper/test/contract.mjs`.\n"),
    expected: ["alpha: AGENTS.md cites helper/test/contract.mjs, which does not exist"],
  },
]) {
  test(`fails: ${name}`, (t) => {
    assert.deepEqual(problems(t, change), expected);
  });
}

test("a cited support file that exists passes, and so does one beside a citation list", (t) => {
  assert.deepEqual(
    problems(t, (files) => {
      files["plugins/alpha/AGENTS.md"] += "- Fake: `tests/host.ts`; contract `helper/test/contract.mjs`; `tests/alpha.test.ts` (`third` and `tests/host.ts`).\n";
      files["plugins/alpha/tests/host.ts"] = "export {}\n";
      files["plugins/alpha/helper/test/contract.mjs"] = "export {}\n";
    }),
    [],
  );
});

for (const { name, change, expected } of [
  {
    name: "a helper/test file that does not exist",
    change: edit("plugins/alpha/AGENTS.md", (text) => text + "- Helper: `helper/test/config.test.mjs` (`a name`).\n"),
    expected: ["alpha: AGENTS.md cites helper/test/config.test.mjs, which does not exist"],
  },
  {
    name: "a helper/test name that the file does not declare",
    change: (files) => {
      files["plugins/alpha/AGENTS.md"] += "- Helper: `helper/test/config.test.mjs`: `old name`.\n";
      files["plugins/alpha/helper/test/config.test.mjs"] = "test('new name', () => {})\n";
    },
    expected: ['alpha: AGENTS.md cites test "old name", which helper/test/config.test.mjs does not declare'],
  },
]) {
  test(`fails: ${name}`, (t) => {
    assert.deepEqual(problems(t, change), expected);
  });
}

test("a helper/test name that the file declares passes", (t) => {
  assert.deepEqual(
    problems(t, (files) => {
      files["plugins/alpha/AGENTS.md"] += "- Helper: `helper/test/config.test.mjs`: `new name`.\n";
      files["plugins/alpha/helper/test/config.test.mjs"] = "test('new name', () => {})\n";
    }),
    [],
  );
});

// Shapes outside the grammar are not citations: they must not be read as one, whatever sits between the spans.
for (const [name, markdown] of [
  ["a space before the colon", "`tests/a.test.ts` : `x`"],
  ["words after the colon", "`tests/a.test.ts`: see `x`"],
  ["words before the parenthesis", "`tests/a.test.ts` words (`x`)"],
  ["words inside the parenthesis", "`tests/a.test.ts` (see `x`)"],
  ["a comma instead of the parenthesis", "`tests/a.test.ts`, `x`"],
  ["a period after the reference", "`tests/a.test.ts`. `x`"],
  ["a dash instead of the colon", "`tests/a.test.ts` - `x`"],
  ["a bracket instead of the parenthesis", "`tests/a.test.ts` [`x`]"],
  ["a reference with a trailing slash", "`tests/a.test.ts/`: `x`"],
  ["a reference outside tests", "`src/a.test.ts`: `x`"],
]) {
  test(`citation grammar ignores ${name}`, () => {
    assert.deepEqual(citedTests(markdown).cites, []);
  });
}

test("citation grammar accepts the colon and the parenthesis with the spacing the docs use", () => {
  const files = ["tests/a.test.ts"];
  assert.deepEqual(citedTests("`tests/a.test.ts`: `x`").cites, [{ files, name: "x" }]);
  assert.deepEqual(citedTests("`tests/a.test.ts`:   `x`").cites, [{ files, name: "x" }]);
  assert.deepEqual(citedTests("`tests/a.test.ts`:\n`x`").cites, [{ files, name: "x" }]);
  assert.deepEqual(citedTests("`tests/a.test.ts` (`x`)").cites, [{ files, name: "x" }]);
  assert.deepEqual(citedTests("`tests/a.test.ts`(`x`)").cites, [{ files, name: "x" }]);
  assert.deepEqual(citedTests("`tests/a.test.ts` ( `x`)").cites, [{ files, name: "x" }]);
});

test("a citation list continues across a comma, 'and', ', and' or a semicolon, and stops at any other word", () => {
  const names = (markdown) => citedTests(markdown).cites.map((cite) => cite.name);
  assert.deepEqual(names("`tests/a.test.ts` (`a`, `b`)"), ["a", "b"]);
  assert.deepEqual(names("`tests/a.test.ts` (`a` and `b`)"), ["a", "b"]);
  assert.deepEqual(names("`tests/a.test.ts` (`a`, and `b`)"), ["a", "b"]);
  assert.deepEqual(names("`tests/a.test.ts` (`a`; `b`)"), ["a", "b"]);
  assert.deepEqual(names("`tests/a.test.ts` (`a`,`b`)"), ["a", "b"]);
  assert.deepEqual(names("`tests/a.test.ts` (`a` or `b`)"), ["a"]);
  assert.deepEqual(names("`tests/a.test.ts` (`a`. `b`)"), ["a"]);
  assert.deepEqual(names("`tests/a.test.ts` (`a` and also `b`)"), ["a"]);
  assert.deepEqual(names("`tests/a.test.ts` (`a`) `b`"), ["a"]);
});

test("declared test names drop an escaped line break, LF or CRLF, and keep the text around it", () => {
  assert.deepEqual([...declaredTests("test('one \\\ntwo', () => {})")], ["one two"]);
  assert.deepEqual([...declaredTests("test('one \\\r\ntwo', () => {})")], ["one two"]);
  assert.deepEqual([...declaredTests("test('a\\nb', () => {})")], ["a\nb"]);
  assert.deepEqual([...declaredTests("test('a \\q b', () => {})")], ["a q b"]);
});

const PACKAGE = (pin) => JSON.stringify({ private: true, devDependencies: { "@anthropic-ai/claude-code": pin, typescript: "7.0.2" } });
const WITH_PIN = (pin, readmeSuffix = "The repository is checked with v2.1.296 (`claude --version`).") => (files) => {
  if (pin !== undefined) files["package.json"] = PACKAGE(pin);
  files["README.md"] += `\n${readmeSuffix}\n`;
};

test("the package.json CLI pin passes when the README says the repository is checked with that version", (t) => {
  assert.deepEqual(problems(t, WITH_PIN("2.1.296")), []);
});

test("a repository with no CLI pin and no README version skips the check", (t) => {
  assert.deepEqual(problems(t), []);
  assert.deepEqual(problems(t, (files) => { files["package.json"] = JSON.stringify({ private: true }); }), []);
});

for (const { name, change, expected } of [
  {
    name: "a pin that differs from the README",
    change: WITH_PIN("2.1.300"),
    expected: ['package.json: "@anthropic-ai/claude-code" is 2.1.300, but README.md says the repository is checked with v2.1.296'],
  },
  {
    name: "a pin when the README states no version",
    change: WITH_PIN("2.1.296", "Nothing about versions."),
    expected: ['package.json: "@anthropic-ai/claude-code" is 2.1.296, but README.md says the repository is checked with no version ("checked with vX.Y.Z")'],
  },
  {
    name: "a README version with no package.json",
    change: WITH_PIN(undefined),
    expected: ['package.json: no devDependencies "@anthropic-ai/claude-code" version'],
  },
  {
    name: "a range instead of an exact pin",
    change: WITH_PIN("^2.1.296"),
    expected: ['package.json: "@anthropic-ai/claude-code" is ^2.1.296; pin an exact version'],
  },
  {
    name: "a plugin directory whose .claude-plugin is a file",
    change: (files) => {
      files["plugins/ghost/.claude-plugin"] = "not a directory";
    },
    expected: ["plugins/ghost: no marketplace.json entry"],
  },
]) {
  test(`fails: ${name}`, (t) => {
    assert.deepEqual(problems(t, change), expected);
  });
}


test("a .DS_Store beside the generated typings keeps the delete-the-directory hint", (t) => {
  assert.deepEqual(
    problems(t, (files) => {
      files["plugins/ghost/.DS_Store"] = "x";
      files["plugins/ghost/.claude-plugin/.DS_Store"] = "x";
      files["plugins/ghost/.claude-plugin/types/tsconfig.json"] = "{}";
    }),
    ["plugins/ghost: no marketplace.json entry (only the generated .claude-plugin/types/ is left; delete the directory)"],
  );
});

test("the bootstrap plugin list matches the marketplace, in any order", (t) => {
  assert.deepEqual(problems(t, (files) => { files["scripts/bootstrap.sh"] = '#!/bin/sh\nALL="alpha"\n'; }), []);
});

for (const { name, script, expected } of [
  { name: "a bootstrap list missing a plugin", script: 'ALL=""', expected: 'scripts/bootstrap.sh: ALL lists "", but marketplace.json has "alpha"' },
  { name: "a bootstrap list with an unknown plugin", script: 'ALL="alpha ghost"', expected: 'scripts/bootstrap.sh: ALL lists "alpha ghost", but marketplace.json has "alpha"' },
  { name: "a bootstrap script without its list", script: "PLUGINS=alpha", expected: 'scripts/bootstrap.sh: no ALL="<plugins>" line' },
]) {
  test(`fails: ${name}`, (t) => {
    assert.deepEqual(problems(t, (files) => { files["scripts/bootstrap.sh"] = `#!/bin/sh\n${script}\n`; }), [expected]);
  });
}

/** Moves alpha out of the marketplace into unlisted.json, with its README row and install line gone. */
const unlistAlpha = (files) => {
  files[".claude-plugin/marketplace.json"] = json({ name: "market", plugins: [] });
  files[".claude-plugin/unlisted.json"] = json(["alpha"]);
  files["README.md"] = "# market\n";
};

test("an unlisted plugin passes without a marketplace entry, README row or install line, and is counted apart", (t) => {
  const files = baseFiles();
  unlistAlpha(files);
  const root = writeTree(t, files);
  const { errors, count, unlisted } = checkRepo(root);
  assert.deepEqual(errors, []);
  assert.equal(count, 0);
  assert.equal(unlisted, 1);
  const run = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
  assert.equal(run.stdout, "ok: 0 plugins, 1 unlisted\n");
});

for (const { name, change, expected } of [
  {
    name: "an unlisted plugin is still checked like a listed one",
    change: (files) => {
      unlistAlpha(files);
      delete files["plugins/alpha/AGENTS.md"];
    },
    expected: ["alpha: AGENTS.md is missing"],
  },
  {
    name: "an unlisted plugin with a README row and install line",
    change: (files) => {
      const readme = files["README.md"];
      unlistAlpha(files);
      files["README.md"] = readme;
    },
    expected: [
      "alpha: is unlisted, but the root README.md table still has its row",
      'alpha: is unlisted, but the root README.md still has "/plugin install alpha@market"',
    ],
  },
  {
    name: "a plugin both in the marketplace and unlisted",
    change: (files) => {
      files[".claude-plugin/unlisted.json"] = json(["alpha"]);
    },
    expected: [".claude-plugin/unlisted.json: alpha is also in marketplace.json; keep it in one of them"],
  },
  {
    name: "an unlisted name with no plugin directory",
    change: (files) => {
      files[".claude-plugin/unlisted.json"] = json(["ghost"]);
    },
    expected: ["ghost: ./plugins/ghost is missing"],
  },
  {
    name: "an unlisted.json that is not an array of names",
    change: (files) => {
      files[".claude-plugin/unlisted.json"] = json({ plugins: ["alpha"] });
    },
    expected: [".claude-plugin/unlisted.json must be an array of plugin names"],
  },
  {
    name: "an unlisted.json that is not JSON",
    change: (files) => {
      files[".claude-plugin/unlisted.json"] = "[alpha";
    },
    expected: [".claude-plugin/unlisted.json is not valid JSON"],
  },
]) {
  test(`unlisted: ${name}`, (t) => {
    assert.deepEqual(problems(t, change), expected);
  });
}

test("bootstrap.sh lists only the marketplace plugins, not the unlisted ones", (t) => {
  assert.deepEqual(
    problems(t, (files) => {
      unlistAlpha(files);
      files["scripts/bootstrap.sh"] = 'ALL="alpha"\n';
    }),
    ['scripts/bootstrap.sh: ALL lists "alpha", but marketplace.json has ""'],
  );
});

// The chatgpt README names the default model by hand; the schema text builds it from DEFAULT_CHOICE.
const CHATGPT_DEFAULT = (readme, source = "export const DEFAULT_CHOICE = { model: 'GPT-6', effort: 'medium' } satisfies Choice\n") => (files) => {
  files["plugins/chatgpt/hooks/conversation.ts"] = source;
  files["plugins/chatgpt/README.md"] = readme;
};
const defaultProblems = (t, change) => problems(t, change).filter((line) => line.includes("DEFAULT_CHOICE"));

test("the chatgpt README passes when it names DEFAULT_CHOICE's model at its effort, capitalized", (t) => {
  assert.deepEqual(defaultProblems(t, CHATGPT_DEFAULT("Without a model, a new chat uses GPT-6 at Medium effort.\n")), []);
});

test("a repository without the chatgpt plugin skips the DEFAULT_CHOICE check", (t) => {
  assert.deepEqual(defaultProblems(t), []);
});

for (const { name, change, expected } of [
  {
    name: "a README that names another default",
    change: CHATGPT_DEFAULT("Without a model, a new chat uses GPT-5 at High effort.\n"),
    expected: 'plugins/chatgpt/README.md: does not say "GPT-6 at Medium effort", the default that DEFAULT_CHOICE in hooks/conversation.ts picks',
  },
  {
    name: "a DEFAULT_CHOICE the check cannot read",
    change: CHATGPT_DEFAULT("GPT-6 at Medium effort\n", "export const DEFAULT_CHOICE = pick()\n"),
    expected: "plugins/chatgpt/hooks/conversation.ts: no DEFAULT_CHOICE = { model: '…', effort: '…' } literal to check the README against",
  },
]) {
  test(`chatgpt default: ${name}`, (t) => {
    assert.deepEqual(defaultProblems(t, change), [expected]);
  });
}
