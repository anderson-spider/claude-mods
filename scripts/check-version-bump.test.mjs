import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { missingBumps, pluginsNeedingBump } from "./check-version-bump.mjs";

const script = fileURLToPath(new URL("./check-version-bump.mjs", import.meta.url));

// Files under a plugin that ship, one per folder the plugins use.
const COUNTED = [
  "hooks/register.tsx",
  "hooks/hud/view.ts",
  "hooks/hooks.json",
  "helper/helper.mjs",
  "helper/lib/hub.mjs",
  "skills/brainstorm/SKILL.md",
  "skills/brainstorm/references/notes.md",
  "types/index.d.ts",
  ".claude-plugin/plugin.json",
  "tsconfig.json",
  "agents/reviewer.md",
  "scripts/build.sh",
];
// Tests and docs: they never change what a user runs.
const EXCLUDED = [
  "tests/register.test.ts",
  "tests/fixtures/data.json",
  "helper/test/config.test.mjs",
  "helper/test/contract.mjs",
  "README.md",
  "AGENTS.md",
  "CHANGELOG.md",
  "docs/design.png",
  "hooks/api.test.ts",
];

for (const path of COUNTED) {
  test(`counts a change to plugins/alpha/${path}`, () => {
    assert.deepEqual(pluginsNeedingBump([`plugins/alpha/${path}`]), ["alpha"]);
  });
}

for (const path of EXCLUDED) {
  test(`ignores a change to plugins/alpha/${path}`, () => {
    assert.deepEqual(pluginsNeedingBump([`plugins/alpha/${path}`]), []);
  });
}

test("files outside plugins/<name>/ never count", () => {
  assert.deepEqual(
    pluginsNeedingBump([
      "README.md",
      "AGENTS.md",
      "scripts/check-version-bump.mjs",
      ".github/workflows/ci.yml",
      ".claude/rules/alpha.md",
      ".claude-plugin/marketplace.json",
      "plugins/README.md",
      "plugins/alpha",
      "docs/plugins/alpha/hooks/a.ts",
      "vendor/plugins/alpha/hooks/a.ts",
    ]),
    [],
  );
});

test("a plugin counts once however many files changed, and each plugin is its own", () => {
  assert.deepEqual(
    pluginsNeedingBump([
      "plugins/zeta/hooks/a.ts",
      "plugins/alpha/hooks/a.ts",
      "plugins/alpha/skills/s/SKILL.md",
      "plugins/alpha/tests/a.test.ts",
      "plugins/beta/README.md",
      "plugins/gamma/AGENTS.md",
      "plugins/gamma/tests/a.test.ts",
    ]),
    ["alpha", "zeta"],
  );
});

/** A version lookup over `{ base: { name: version }, head: { name: version } }`. */
const versions = (table) => (side, name) => table[side][name];

test("a changed plugin with the same version is reported with the manifest to edit", () => {
  assert.deepEqual(missingBumps(["plugins/alpha/skills/s/SKILL.md"], versions({ base: { alpha: "1.0.0" }, head: { alpha: "1.0.0" } })), [
    "alpha: shipped files changed but version is still 1.0.0 (bump it in plugins/alpha/.claude-plugin/plugin.json)",
  ]);
});

test("a bumped version passes, whichever side of the semver changed", () => {
  for (const head of ["1.0.1", "1.1.0", "2.0.0"]) {
    assert.deepEqual(missingBumps(["plugins/alpha/types/index.d.ts"], versions({ base: { alpha: "1.0.0" }, head: { alpha: head } })), []);
  }
});

test("only the plugins that changed shipped files and kept their version are reported", () => {
  const table = {
    base: { alpha: "1.0.0", beta: "2.0.0", gamma: "3.0.0", delta: "4.0.0" },
    head: { alpha: "1.0.0", beta: "2.0.1", gamma: "3.0.0", delta: "4.0.0" },
  };
  assert.deepEqual(
    missingBumps(
      [
        "plugins/delta/hooks/a.ts",
        "plugins/beta/hooks/a.ts",
        "plugins/alpha/hooks/a.ts",
        "plugins/gamma/tests/a.test.ts",
        "plugins/gamma/README.md",
      ],
      versions(table),
    ),
    [
      "alpha: shipped files changed but version is still 1.0.0 (bump it in plugins/alpha/.claude-plugin/plugin.json)",
      "delta: shipped files changed but version is still 4.0.0 (bump it in plugins/delta/.claude-plugin/plugin.json)",
    ],
  );
});

test("a new plugin and a removed plugin have nothing to bump", () => {
  const changed = ["plugins/fresh/hooks/a.ts", "plugins/gone/hooks/a.ts"];
  assert.deepEqual(missingBumps(changed, versions({ base: { gone: "1.0.0" }, head: { fresh: "0.1.0" } })), []);
});

test("a plugin whose manifest is on neither side is skipped, not reported as unbumped", () => {
  assert.deepEqual(missingBumps(["plugins/odd/hooks/a.ts"], versions({ base: {}, head: {} })), []);
});

test("nothing changed means nothing missing", () => {
  assert.deepEqual(missingBumps([], versions({ base: {}, head: {} })), []);
});

// The command, against a real repository: main with two plugins, then a branch that changes them.
function fixtureRepo(t) {
  const root = mkdtempSync(join(tmpdir(), "check-version-bump-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "pipe" });
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const manifest = (name, version) => JSON.stringify({ name, version });
  git("init", "-q", "-b", "main");
  write("plugins/alpha/.claude-plugin/plugin.json", manifest("alpha", "1.0.0"));
  write("plugins/alpha/hooks/register.tsx", "export {};\n");
  write("plugins/beta/.claude-plugin/plugin.json", manifest("beta", "2.0.0"));
  write("plugins/beta/hooks/register.tsx", "export {};\n");
  write("plugins/beta/skills/s/SKILL.md", "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("switch", "-q", "-c", "work");
  const commit = () => {
    git("add", "-A");
    git("commit", "-q", "-m", "work");
  };
  const move = (from, to) => {
    mkdirSync(dirname(join(root, to)), { recursive: true });
    git("mv", from, to);
    git("commit", "-q", "-m", "move");
  };
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
  return { write, manifest, commit, move, run };
}

test("the command exits 2 with usage when no base ref is given", (t) => {
  const result = fixtureRepo(t).run();
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "usage: node scripts/check-version-bump.mjs <base-ref>\n");
});

test("the command passes when only tests and docs changed", (t) => {
  const repo = fixtureRepo(t);
  repo.write("plugins/alpha/tests/a.test.ts", "test\n");
  repo.write("plugins/alpha/README.md", "docs\n");
  repo.write("plugins/beta/AGENTS.md", "docs\n");
  repo.commit();
  const result = repo.run("main");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "ok: every plugin with changed shipped files bumped its version\n");
  assert.equal(result.stderr, "");
});

test("the command fails on a changed skill and types file without a bump, and prints one line per plugin", (t) => {
  const repo = fixtureRepo(t);
  repo.write("plugins/beta/skills/s/SKILL.md", "two\n");
  repo.write("plugins/alpha/types/index.d.ts", "export {};\n");
  repo.commit();
  const result = repo.run("main");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    [
      "alpha: shipped files changed but version is still 1.0.0 (bump it in plugins/alpha/.claude-plugin/plugin.json)",
      "beta: shipped files changed but version is still 2.0.0 (bump it in plugins/beta/.claude-plugin/plugin.json)",
      "",
    ].join("\n"),
  );
});

test("the command passes when each changed plugin bumped, and a new plugin needs no bump", (t) => {
  const repo = fixtureRepo(t);
  repo.write("plugins/alpha/hooks/register.tsx", "export const a = 1;\n");
  repo.write("plugins/alpha/.claude-plugin/plugin.json", repo.manifest("alpha", "1.0.1"));
  repo.write("plugins/beta/skills/s/SKILL.md", "two\n");
  repo.write("plugins/beta/.claude-plugin/plugin.json", repo.manifest("beta", "2.1.0"));
  repo.write("plugins/fresh/.claude-plugin/plugin.json", repo.manifest("fresh", "0.1.0"));
  repo.write("plugins/fresh/hooks/register.tsx", "export {};\n");
  repo.commit();
  const result = repo.run("main");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "ok: every plugin with changed shipped files bumped its version\n");
});

// A move is a removal at the old path: git reports a rename by its destination alone unless told not to.
for (const { name, from, to, plugin } of [
  { name: "a skill moved to docs/", from: "plugins/beta/skills/s/SKILL.md", to: "plugins/beta/docs/s.md", plugin: "beta" },
  { name: "a hook moved to tests/", from: "plugins/alpha/hooks/register.tsx", to: "plugins/alpha/tests/register.tsx", plugin: "alpha" },
  { name: "a hook moved to another plugin", from: "plugins/alpha/hooks/register.tsx", to: "plugins/beta/hooks/moved.tsx", plugin: "alpha" },
]) {
  test(`the command fails when ${name} without a bump`, (t) => {
    const repo = fixtureRepo(t);
    repo.move(from, to);
    const result = repo.run("main");
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`^${plugin}: shipped files changed but version is still `, "m"));
  });
}
