import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkRepo, citedTests, declaredTests } from "./check-consistency.mjs";

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
    ".claude/rules/alpha.md": '---\npaths:\n  - "plugins/alpha/**"\n---\n\n@../../plugins/alpha/AGENTS.md\n',
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
    change: edit(".claude/rules/alpha.md", () => "@../../plugins/beta/AGENTS.md\n"),
    expected: ["alpha: .claude/rules/alpha.md does not import @../../plugins/alpha/AGENTS.md"],
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
    expected: ['.claude/rules/ghost.md: no marketplace.json entry for plugin "ghost"'],
  },
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
