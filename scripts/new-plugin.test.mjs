import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkRepo } from "./check-consistency.mjs";
import { invalidName, scaffoldPlugin } from "./new-plugin.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("./new-plugin.mjs", import.meta.url));
const json = (value) => JSON.stringify(value, null, 2);

/** A minimal repository in the shape of the real root files, with one plugin ("mid") already registered. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "new-plugin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    ".claude-plugin/marketplace.json": json({
      name: "market",
      owner: { name: "me" },
      plugins: [{ name: "mid", source: "./plugins/mid", description: "Mid does things." }],
    }),
    "plugins/mid/.claude-plugin/plugin.json": json({ name: "mid", version: "1.0.0", description: "Mid does things." }),
    "plugins/mid/hooks/hooks.json": "{}",
    "plugins/mid/tsconfig.json": json({ extends: "./.claude-plugin/types/tsconfig.json", compilerOptions: { noEmit: true } }),
    "plugins/mid/README.md": "# mid\n",
    "plugins/mid/AGENTS.md": "# mid\n",
    ".claude/rules/mid.md": '---\npaths:\n  - "plugins/mid/**"\n---\n\nRead `plugins/mid/AGENTS.md` before changing files under `plugins/mid/`.\n',
    "AGENTS.md": [
      "## Where to look",
      "",
      "- Plugin work: read `plugins/<name>/AGENTS.md`; `.claude/rules/<name>.md` points at it.",
      "- Mid things: `plugins/mid/AGENTS.md`.",
      "- Release checks: `/release-plugin <plugin>`.",
      "",
    ].join("\n"),
    "README.md": [
      "| Plugin | What it does |",
      "| --- | --- |",
      "| [mid](plugins/mid/README.md) | Mid does things. |",
      "",
      "```",
      "/plugin install mid@market",
      "```",
      "",
    ].join("\n"),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const listing = (root, dir = root) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listing(root, join(dir, entry.name)) : [`${join(dir, entry.name).slice(root.length)}\t${readFileSync(join(dir, entry.name), "utf8")}`],
  ).sort();

test("a scaffolded plugin passes every consistency check, before, between and after the existing ones", (t) => {
  const root = fixture(t);
  assert.deepEqual(checkRepo(root).errors, []);

  for (const name of ["aardvark", "zeta", "my-new-tool"]) {
    const { created, edited } = scaffoldPlugin(root, name, `The ${name} plugin.`);
    assert.deepEqual(edited, [".claude-plugin/marketplace.json", "AGENTS.md", "README.md"]);
    assert.ok(created.includes(`plugins/${name}/.claude-plugin/plugin.json`));
    assert.ok(created.includes(`.claude/rules/${name}.md`));
    assert.deepEqual(checkRepo(root).errors, []);
  }
  assert.equal(checkRepo(root).count, 4);
});

test("the entries land in sorted places with the format of the existing ones", (t) => {
  const root = fixture(t);
  scaffoldPlugin(root, "aardvark", "First | one.");
  scaffoldPlugin(root, "zeta", "Last one.");
  const marketplace = JSON.parse(readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"));

  assert.deepEqual(marketplace.plugins.map((entry) => entry.name), ["aardvark", "mid", "zeta"]);
  assert.deepEqual(marketplace.plugins[0], { name: "aardvark", source: "./plugins/aardvark", description: "First | one." });
  assert.equal(readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"), `${json(marketplace)}\n`);
  assert.equal(
    readFileSync(join(root, "AGENTS.md"), "utf8"),
    [
      "## Where to look",
      "",
      "- Plugin work: read `plugins/<name>/AGENTS.md`; `.claude/rules/<name>.md` points at it.",
      "- aardvark: `plugins/aardvark/AGENTS.md`.",
      "- Mid things: `plugins/mid/AGENTS.md`.",
      "- zeta: `plugins/zeta/AGENTS.md`.",
      "- Release checks: `/release-plugin <plugin>`.",
      "",
    ].join("\n"),
  );
  assert.equal(
    readFileSync(join(root, "README.md"), "utf8"),
    [
      "| Plugin | What it does |",
      "| --- | --- |",
      "| [aardvark](plugins/aardvark/README.md) | First \\| one. |",
      "| [mid](plugins/mid/README.md) | Mid does things. |",
      "| [zeta](plugins/zeta/README.md) | Last one. |",
      "",
      "```",
      "/plugin install aardvark@market",
      "/plugin install mid@market",
      "/plugin install zeta@market",
      "```",
      "",
    ].join("\n"),
  );
  assert.equal(
    readFileSync(join(root, ".claude/rules/zeta.md"), "utf8"),
    '---\npaths:\n  - "plugins/zeta/**"\n---\n\nRead `plugins/zeta/AGENTS.md` before changing files under `plugins/zeta/`.\n',
  );
});

test("the plugin files carry the name, its tool id and the description, with no placeholder left", (t) => {
  const root = fixture(t);
  scaffoldPlugin(root, "my-tool", "Does my thing.");
  const dir = join(root, "plugins/my-tool");
  const plugin = JSON.parse(readFileSync(join(dir, ".claude-plugin/plugin.json"), "utf8"));

  assert.deepEqual(plugin, { name: "my-tool", version: "0.1.0", description: "Does my thing.", author: { name: "anderson-spider" }, license: "MIT" });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "hooks/hooks.json"), "utf8")), { modules: ["./register.tsx"] });
  assert.equal(JSON.parse(readFileSync(join(dir, "tsconfig.json"), "utf8")).extends, "./.claude-plugin/types/tsconfig.json");
  const register = readFileSync(join(dir, "hooks/register.tsx"), "utf8");
  assert.ok(register.includes("name: 'my_tool_echo'"));
  assert.ok(register.includes("{ tool: 'mcp__my-tool__my_tool_echo' }"));
  assert.ok(register.includes("satisfies SchemaFor<McpToolInputs['mcp__my-tool__my_tool_echo']>"));
  assert.ok(readFileSync(join(dir, "types/index.d.ts"), "utf8").includes("'mcp__my-tool__my_tool_echo': {"));
  assert.ok(readFileSync(join(dir, "README.md"), "utf8").includes("Does my thing."));
  for (const file of ["hooks/schema.ts", "hooks/echo.ts", "tests/host.ts", "tests/echo.test.ts", "tests/register.test.ts", "AGENTS.md"]) {
    assert.ok(existsSync(join(dir, file)), file);
  }
  const everything = listing(dir).join("\n");
  assert.ok(!everything.includes("{{"), "a placeholder was left");
  assert.ok(!existsSync(join(dir, "hooks/hooks.json.tmpl")));
});

test("without a description the manifest, marketplace and README row agree on a placeholder", (t) => {
  const root = fixture(t);
  scaffoldPlugin(root, "plain");
  assert.equal(JSON.parse(readFileSync(join(root, "plugins/plain/.claude-plugin/plugin.json"), "utf8")).description, "Describe what plain does.");
  assert.deepEqual(checkRepo(root).errors, []);
});

for (const [name, expected] of [
  ["", /a plugin name is required/],
  [undefined, /a plugin name is required/],
  ["Upper", /not a valid plugin name/],
  ["1abc", /not a valid plugin name/],
  ["a_b", /not a valid plugin name/],
  ["a--b", /not a valid plugin name/],
  ["-a", /not a valid plugin name/],
  ["a-", /not a valid plugin name/],
  ["a b", /not a valid plugin name/],
  ["../x", /not a valid plugin name/],
  ["a".repeat(27), /longer than 26 characters, so its tool name/],
]) {
  test(`refuses the invalid name ${JSON.stringify(name)} and writes nothing`, (t) => {
    const root = fixture(t);
    const before = listing(root);
    assert.throws(() => scaffoldPlugin(root, name), expected);
    assert.deepEqual(listing(root), before);
    assert.match(invalidName(name), expected);
  });
}

test("the longest name keeps its sample tool name within 64 characters", (t) => {
  const root = fixture(t);
  const name = "ab-".repeat(8) + "ab";
  assert.equal(name.length, 26);
  scaffoldPlugin(root, name);
  const register = readFileSync(join(root, "plugins", name, "hooks/register.tsx"), "utf8");
  const tools = [...register.matchAll(/mcp__[a-z0-9_-]+/g)].map((match) => match[0]);
  assert.ok(tools.length >= 2);
  for (const tool of tools) assert.ok(tool.length <= 64, `${tool} is ${tool.length} characters`);
  assert.ok(tools.includes(`mcp__${name}__${name.replaceAll("-", "_")}_echo`));
  assert.throws(() => scaffoldPlugin(root, `${name}-x`), /longer than 26 characters/);
});

test("a valid name has no objection", () => {
  for (const name of ["a", "abc", "a1", "my-new-tool", "a".repeat(26)]) assert.equal(invalidName(name), undefined);
});

test("refuses an existing plugin directory, marketplace entry or rule, and writes nothing", (t) => {
  const root = fixture(t);
  const before = listing(root);
  assert.throws(() => scaffoldPlugin(root, "mid"), /plugins\/mid already exists/);

  rmSync(join(root, "plugins/mid"), { recursive: true });
  const without = listing(root);
  assert.throws(() => scaffoldPlugin(root, "mid"), /mid is already in \.claude-plugin\/marketplace\.json/);

  const market = JSON.parse(readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"));
  market.plugins = [];
  writeFileSync(join(root, ".claude-plugin/marketplace.json"), json(market));
  assert.throws(() => scaffoldPlugin(root, "mid"), /\.claude\/rules\/mid\.md already exists/);

  assert.ok(before.length > without.length);
  assert.ok(!existsSync(join(root, "plugins/mid")));
});

test("refuses a description of more than one line", (t) => {
  const root = fixture(t);
  const before = listing(root);
  assert.throws(() => scaffoldPlugin(root, "fresh", "one\ntwo"), /one non-empty line/);
  assert.throws(() => scaffoldPlugin(root, "fresh", "   "), /one non-empty line/);
  assert.deepEqual(listing(root), before);
});

for (const [name, file, expected] of [
  ["AGENTS.md without plugin lines", "AGENTS.md", /AGENTS\.md "Where to look": no existing plugin line/],
  ["a README without the table", "README.md", /README\.md plugin table: no existing plugin line/],
]) {
  test(`writes nothing when the root file cannot take the entry: ${name}`, (t) => {
    const root = fixture(t);
    writeFileSync(join(root, file), "nothing here\n");
    const before = listing(root);
    assert.throws(() => scaffoldPlugin(root, "fresh"), expected);
    assert.deepEqual(listing(root), before);
  });
}

test("writes nothing when the README has a table but no install block", (t) => {
  const root = fixture(t);
  writeFileSync(join(root, "README.md"), "| [mid](plugins/mid/README.md) | Mid. |\n");
  const before = listing(root);
  assert.throws(() => scaffoldPlugin(root, "fresh"), /README\.md install block: no existing plugin line/);
  assert.deepEqual(listing(root), before);
});

test("the real root files take a new plugin that then passes its own checks", (t) => {
  const root = mkdtempSync(join(tmpdir(), "new-plugin-real-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of [".claude-plugin/marketplace.json", "AGENTS.md", "README.md", "scripts/bootstrap.sh"]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(repoRoot, file), join(root, file));
  }
  scaffoldPlugin(root, "scratch-demo", "A scratch demo.");

  assert.deepEqual(checkRepo(root).errors.filter((line) => line.startsWith("scratch-demo:")), []);
  const names = (file) => JSON.parse(readFileSync(file, "utf8")).plugins.map((entry) => entry.name);
  const expected = [...names(join(repoRoot, ".claude-plugin/marketplace.json")), "scratch-demo"].sort();
  assert.deepEqual(names(join(root, ".claude-plugin/marketplace.json")), expected);
  // the new line sits among the existing plugin lines, which stay sorted by name; AGENTS.md also cites unlisted plugins
  const unlistedFile = join(repoRoot, ".claude-plugin/unlisted.json");
  const unlisted = existsSync(unlistedFile) ? JSON.parse(readFileSync(unlistedFile, "utf8")) : [];
  const cited = readFileSync(join(root, "AGENTS.md"), "utf8").matchAll(/^- [^\n]*`plugins\/([a-z0-9-]+)\/AGENTS\.md`\.$/gm);
  assert.deepEqual([...cited].map((match) => match[1]), [...expected, ...unlisted].sort());
  const installs = readFileSync(join(root, "README.md"), "utf8").matchAll(/^\/plugin install ([a-z0-9-]+)@/gm);
  assert.deepEqual([...installs].map((match) => match[1]), expected);
});

/** Runs the CLI against `root`, so the test never writes into this checkout. */
function runCli(root, args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, NEW_PLUGIN_ROOT: root },
  });
}

test("the command refuses an invalid or existing name with exit 1 and writes nothing", (t) => {
  const root = fixture(t);
  const before = listing(root);
  for (const [args, message] of [
    [["Bad Name"], 'plugin:new: "Bad Name" is not a valid plugin name'],
    [["mid"], "plugin:new: plugins/mid already exists"],
    [[], "plugin:new: a plugin name is required"],
    [["ok", "d", "extra"], "plugin:new: usage: node scripts/new-plugin.mjs <name> [description]"],
  ]) {
    const result = runCli(root, args);
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim().split("\n")[0].startsWith(message), true, result.stderr);
  }
  assert.deepEqual(listing(root), before);
  assert.ok(!existsSync(join(repoRoot, "plugins/ok")));
});

test("the command scaffolds into NEW_PLUGIN_ROOT and prints the next step", (t) => {
  const root = fixture(t);
  const result = runCli(root, ["fresh-kit"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^created \d+ files for plugins\/fresh-kit and edited .claude-plugin\/marketplace\.json, AGENTS\.md, README\.md\n/);
  assert.match(result.stdout, /next: replace the sample tool; fill in the description \(a placeholder when none was given\), the README text, and the "Where to look" label in AGENTS\.md/);
  assert.ok(existsSync(join(root, "plugins/fresh-kit/hooks/register.tsx")));
  assert.deepEqual(checkRepo(root).errors, []);
  assert.ok(!existsSync(join(repoRoot, "plugins/fresh-kit")));
});

test("the bootstrap plugin list takes the new plugin in marketplace order, and a list it cannot find writes nothing", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts/bootstrap.sh"), '#!/bin/sh\nALL="mid"\n');
  scaffoldPlugin(root, "alpha");
  assert.equal(readFileSync(join(root, "scripts/bootstrap.sh"), "utf8"), '#!/bin/sh\nALL="alpha mid"\n');
  assert.deepEqual(checkRepo(root).errors.filter((line) => line.startsWith("scripts/bootstrap.sh")), []);

  const other = fixture(t);
  mkdirSync(join(other, "scripts"));
  writeFileSync(join(other, "scripts/bootstrap.sh"), "#!/bin/sh\nPLUGINS=mid\n");
  const before = listing(other);
  assert.throws(() => scaffoldPlugin(other, "alpha"), /scripts\/bootstrap\.sh: no ALL="<plugins>" line/);
  assert.deepEqual(listing(other), before);
});
