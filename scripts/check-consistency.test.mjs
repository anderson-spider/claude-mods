import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkRepo, citedTests, declaredTests } from "./check-consistency.mjs";

const RULE_FRONT = '---\npaths:\n  - "plugins/alpha/**"\n---\n\n';
const IMPORT = "@../../plugins/alpha/AGENTS.md";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("./check-consistency.mjs", import.meta.url));
const json = (value) => JSON.stringify(value, null, 2);
const COMMAND = (file) => `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${file}"`;

/** A minimal repository with one plugin, "alpha", that passes every check. Tests change one file at a time. */
function baseFiles() {
  return {
    ".claude-plugin/marketplace.json": json({
      name: "market",
      plugins: [{ name: "alpha", source: "./plugins/alpha", description: "Alpha does things." }],
    }),
    "plugins/alpha/.claude-plugin/plugin.json": json({ name: "alpha", version: "1.2.3", description: "Alpha does things." }),
    "plugins/alpha/hooks/hooks.json": "{}",
    "plugins/alpha/tsconfig.json": json({ extends: "./.claude-plugin/types/tsconfig.json" }),
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
    ".claude/rules/alpha.md": `${RULE_FRONT}${IMPORT}\n`,
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
    ".claude/settings.json": json({
      hooks: {
        PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: COMMAND("guard.mjs") }] }],
        PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: COMMAND("after.mjs"), timeout: 120 }] }],
        SessionStart: [{ hooks: [{ type: "command", command: COMMAND("start.mjs") }] }],
      },
    }),
    ".claude/hooks/guard.mjs": "// PreToolUse (Edit|Write): blocks something.\n",
    ".claude/hooks/after.mjs": "// PostToolUse (Edit|Write): checks something.\n",
    ".claude/hooks/start.mjs": "// SessionStart: prepares something.\n",
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
const settings = (change) =>
  edit(".claude/settings.json", (text) => {
    const parsed = JSON.parse(text);
    change(parsed);
    return json(parsed);
  });
const marketplace = (change) => edit(".claude-plugin/marketplace.json", (text) => json(change(JSON.parse(text))));

test("the repository passes every check", () => {
  const { errors, count } = checkRepo(repoRoot);
  assert.deepEqual(errors, []);
  assert.ok(count > 0);
});

test("the fixture repository passes every check", (t) => {
  assert.deepEqual(problems(t), []);
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
    change: edit("plugins/alpha/tsconfig.json", () => json({ extends: "../../tsconfig.base.json" })),
    expected: ['alpha: tsconfig.json must extend "./.claude-plugin/types/tsconfig.json"'],
  },
  { name: "tsconfig that is not JSON", change: edit("plugins/alpha/tsconfig.json", () => "{"), expected: ["alpha: tsconfig.json is not valid JSON"] },
  { name: "plugin AGENTS.md missing", change: edit("plugins/alpha/AGENTS.md", () => undefined), expected: ["alpha: AGENTS.md is missing"] },
  { name: "plugin README.md missing", change: edit("plugins/alpha/README.md", () => undefined), expected: ["alpha: README.md is missing"] },
  {
    name: "plugin-root CLAUDE.md",
    change: (files) => (files["plugins/alpha/CLAUDE.md"] = "@AGENTS.md\n"),
    expected: ["alpha: CLAUDE.md in the plugin root draws a validation warning; keep guidance in AGENTS.md"],
  },
  { name: "rule file missing", change: edit(".claude/rules/alpha.md", () => undefined), expected: ["alpha: .claude/rules/alpha.md is missing"] },
  {
    name: "rule that imports another file",
    change: edit(".claude/rules/alpha.md", () => `${RULE_FRONT}@../../plugins/beta/AGENTS.md\n`),
    expected: ["alpha: .claude/rules/alpha.md does not import @../../plugins/alpha/AGENTS.md"],
  },
  {
    name: "rule that only mentions the import inside a sentence",
    change: edit(".claude/rules/alpha.md", () => `${RULE_FRONT}Read ${IMPORT} first.\n`),
    expected: ["alpha: .claude/rules/alpha.md does not import @../../plugins/alpha/AGENTS.md"],
  },
  {
    name: "rule whose import has a prefix",
    change: edit(".claude/rules/alpha.md", () => `${RULE_FRONT}- ${IMPORT}\n`),
    expected: ["alpha: .claude/rules/alpha.md does not import @../../plugins/alpha/AGENTS.md"],
  },
  {
    name: "rule whose import names a longer path",
    change: edit(".claude/rules/alpha.md", () => `${RULE_FRONT}${IMPORT}.old\n`),
    expected: ["alpha: .claude/rules/alpha.md does not import @../../plugins/alpha/AGENTS.md"],
  },
  {
    name: "rule copied from another plugin: its paths frontmatter lists that plugin",
    change: edit(".claude/rules/alpha.md", (text) => text.replace("plugins/alpha/**", "plugins/crew/**")),
    expected: ['alpha: .claude/rules/alpha.md paths frontmatter does not list "plugins/alpha/**"'],
  },
  {
    name: "rule without paths frontmatter",
    change: edit(".claude/rules/alpha.md", () => `${IMPORT}\n`),
    expected: ['alpha: .claude/rules/alpha.md paths frontmatter does not list "plugins/alpha/**"'],
  },
  {
    name: "rule whose paths glob stops at the plugin folder",
    change: edit(".claude/rules/alpha.md", (text) => text.replace("plugins/alpha/**", "plugins/alpha")),
    expected: ['alpha: .claude/rules/alpha.md paths frontmatter does not list "plugins/alpha/**"'],
  },
  {
    name: "rule whose plugin glob sits in the body, not the frontmatter",
    change: edit(".claude/rules/alpha.md", () => `---\npaths:\n  - "other/**"\n---\n\n- "plugins/alpha/**"\n${IMPORT}\n`),
    expected: ['alpha: .claude/rules/alpha.md paths frontmatter does not list "plugins/alpha/**"'],
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
    name: "rule file without a plugin",
    change: (files) => {
      files[".claude/rules/ghost.md"] = "@../../plugins/ghost/AGENTS.md\n";
    },
    expected: [
      '.claude/rules/ghost.md: no marketplace.json entry for plugin "ghost" (a rule that is not a plugin\'s goes in a subdirectory of .claude/rules/)',
    ],
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

// The hook wiring rule: a script runs only under the event and matcher its header declares, with its own command.
for (const { name, change, expected } of [
  {
    name: "a hook moved to another event",
    change: settings((s) => {
      s.hooks.PostToolUse.push(...s.hooks.PreToolUse);
      delete s.hooks.PreToolUse;
    }),
    expected: "guard.mjs: not wired under PreToolUse (Edit|Write)",
  },
  {
    name: "a hook under the wrong matcher",
    change: settings((s) => {
      s.hooks.PreToolUse[0].matcher = "Bash";
    }),
    expected: "guard.mjs: not wired under PreToolUse (Edit|Write)",
  },
  {
    name: "a hook without the matcher its header declares",
    change: settings((s) => {
      delete s.hooks.PreToolUse[0].matcher;
    }),
    expected: "guard.mjs: not wired under PreToolUse (Edit|Write)",
  },
  {
    name: "a hook command replaced by echo",
    change: settings((s) => {
      s.hooks.PreToolUse[0].hooks[0].command = "echo " + COMMAND("guard.mjs");
    }),
    expected: "guard.mjs: not wired under PreToolUse (Edit|Write)",
  },
  {
    name: "a hook command that runs another script",
    change: settings((s) => {
      s.hooks.PostToolUse[0].hooks[0].command = COMMAND("guard.mjs");
    }),
    expected: "after.mjs: not wired under PostToolUse (Edit|Write)",
  },
  {
    name: "a hook entry that is not a command",
    change: settings((s) => {
      s.hooks.SessionStart[0].hooks[0].type = "prompt";
    }),
    expected: "start.mjs: not wired under SessionStart in",
  },
  {
    name: "a hook script that is not referenced",
    change: (files) => {
      files[".claude/hooks/new.mjs"] = "// PreToolUse (Edit|Write): new.\n";
    },
    expected: "new.mjs: not wired under PreToolUse (Edit|Write)",
  },
  {
    name: "a hook script without a header",
    change: edit(".claude/hooks/guard.mjs", () => "import 'node:fs'\n"),
    expected: "guard.mjs: first line must declare its event and matcher",
  },
  {
    name: "disableAllHooks",
    change: settings((s) => {
      s.disableAllHooks = true;
    }),
    expected: "settings.json: disableAllHooks turns every project hook off",
  },
  {
    name: "settings.json missing",
    change: edit(".claude/settings.json", () => undefined),
    expected: "guard.mjs: not wired under PreToolUse (Edit|Write)",
  },
]) {
  test(`hook wiring fails: ${name}`, (t) => {
    const found = problems(t, change);
    assert.ok(found.some((line) => line.includes(expected)), `expected "${expected}" in:\n${found.join("\n") || "(no problems)"}`);
  });
}

test("hook wiring accepts the matcher alternatives in any order and a hook beside others", (t) => {
  const found = problems(
    t,
    settings((s) => {
      s.hooks.PreToolUse[0].matcher = "Write|Edit";
      s.hooks.PreToolUse[0].hooks.unshift({ type: "command", command: "echo other" });
    }),
  );
  assert.deepEqual(found, []);
});

test("hook tests next to the scripts are not hook scripts", (t) => {
  assert.deepEqual(
    problems(t, (files) => {
      files[".claude/hooks/guard.test.mjs"] = "import 'node:test'\n";
    }),
    [],
  );
});

test("a rule in a subdirectory of .claude/rules is not an orphan plugin rule", (t) => {
  assert.deepEqual(
    problems(t, (files) => {
      files[".claude/rules/docs/style.md"] = "Write plainly.\n";
    }),
    [],
  );
});

test("a helper/test file counts as a test file reference, alone or in braces", (t) => {
  const { cites, referenced } = citedTests("Pinned by `helper/test/config.test.mjs` (`one`) and `helper/test/{a,b}.test.mjs`: `two`; `tests/c.test.ts`.");
  assert.deepEqual(cites, [
    { files: ["helper/test/config.test.mjs"], name: "one" },
    { files: ["helper/test/a.test.mjs", "helper/test/b.test.mjs"], name: "two" },
  ]);
  assert.deepEqual([...referenced].sort(), ["helper/test/a.test.mjs", "helper/test/b.test.mjs", "helper/test/config.test.mjs", "tests/c.test.ts"]);
  assert.deepEqual(citedTests("`helper/test/contract.mjs` and `other/test/x.test.mjs` are not test files.").referenced.size, 0);
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

// A hook with no matcher runs for every tool, which is what `*` says too; a header or a group may use either.
for (const { name, change, expected } of [
  {
    name: "a hook without a matcher wired under the match-all matcher",
    change: settings((s) => {
      s.hooks.SessionStart[0].matcher = "*";
    }),
    expected: [],
  },
  {
    name: "a header that declares the match-all matcher wired without one",
    change: edit(".claude/hooks/start.mjs", () => "// SessionStart (*): prepares something.\n"),
    expected: [],
  },
  {
    name: "a matcher with empty alternatives",
    change: settings((s) => {
      s.hooks.PreToolUse[0].matcher = "Edit||Write|";
    }),
    expected: [],
  },
  {
    name: "a specific matcher wired under the match-all matcher",
    change: settings((s) => {
      s.hooks.PreToolUse[0].matcher = "*";
    }),
    expected: ["guard.mjs: not wired under PreToolUse (Edit|Write)"],
  },
  {
    name: "a hook without a matcher wired under a specific one",
    change: settings((s) => {
      s.hooks.SessionStart[0].matcher = "startup";
    }),
    expected: ["start.mjs: not wired under SessionStart in"],
  },
  {
    name: "a matcher with an extra alternative",
    change: settings((s) => {
      s.hooks.PreToolUse[0].matcher = "Edit|Write|Bash";
    }),
    expected: ["guard.mjs: not wired under PreToolUse (Edit|Write)"],
  },
]) {
  test(`hook matcher: ${name}`, (t) => {
    const found = problems(t, change);
    assert.equal(found.length, expected.length, found.join("\n") || "(no problems)");
    expected.forEach((line, i) => assert.ok(found[i].includes(line), `expected "${line}" in "${found[i]}"`));
  });
}

const CI_YML = (pin) => `jobs:\n  plugins:\n    env:\n      # note\n      CLAUDE_CLI_PIN: ${pin}\n      OTHER: 1\n`;
const WITH_PIN = (ci, readmeSuffix = "The repository is checked with v2.1.296 (`claude --version`).") => (files) => {
  files[".github/workflows/ci.yml"] = ci;
  files["README.md"] += `\n${readmeSuffix}\n`;
};

test("the CI CLI pin passes when the README says the repository is checked with that version", (t) => {
  assert.deepEqual(problems(t, WITH_PIN(CI_YML("2.1.296"))), []);
  assert.deepEqual(problems(t, WITH_PIN(CI_YML('"2.1.296"'))), []);
});

for (const { name, change, expected } of [
  {
    name: "a pin that differs from the README",
    change: WITH_PIN(CI_YML("2.1.300")),
    expected: ['.github/workflows/ci.yml: CLAUDE_CLI_PIN is 2.1.300, but README.md says the repository is checked with v2.1.296'],
  },
  {
    name: "a pin when the README states no version",
    change: WITH_PIN(CI_YML("2.1.296"), "Nothing about versions."),
    expected: ['.github/workflows/ci.yml: CLAUDE_CLI_PIN is 2.1.296, but README.md says the repository is checked with no version ("checked with vX.Y.Z")'],
  },
  {
    name: "a workflow without the pin line",
    change: WITH_PIN("jobs: {}\n"),
    expected: [".github/workflows/ci.yml: no CLAUDE_CLI_PIN: <version> line"],
  },
  {
    name: "a pin under another variable name",
    change: WITH_PIN(CI_YML("2.1.296").replace("CLAUDE_CLI_PIN", "CLAUDE_CODE_VERSION")),
    expected: [".github/workflows/ci.yml: no CLAUDE_CLI_PIN: <version> line"],
  },
  {
    name: "a rule whose plugin glob sits under another frontmatter key",
    change: edit(".claude/rules/alpha.md", () => `---\nglobs:\n  - "plugins/alpha/**"\npaths:\n  - "other/**"\n---\n\n${IMPORT}\n`),
    expected: ['alpha: .claude/rules/alpha.md paths frontmatter does not list "plugins/alpha/**"'],
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

test("a rule can list its plugin glob in the one-line forms or among others", (t) => {
  for (const front of ['paths: "plugins/alpha/**"', 'paths: ["x/**", "plugins/alpha/**"]', 'paths:\n  - "x/**"\n  - plugins/alpha/**\nother: 1']) {
    assert.deepEqual(problems(t, edit(".claude/rules/alpha.md", () => `---\n${front}\n---\n\n${IMPORT}\n`)), [], front);
  }
});

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
