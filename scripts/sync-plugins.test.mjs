import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./sync-plugins.mjs", import.meta.url));

// Runs the script in a checkout whose marketplace.json lists `checkout`, with a fake `claude` first on PATH that logs
// each call, answers `plugin list --json` with `installed` and `plugin marketplace list --json` with a local copy of the
// marketplace listing `marketplace` (none when `marketplace` is null); `failOn` makes the call whose arguments start
// with it exit 1.
function run(t, { marketplace, checkout = [], installed, failOn }) {
  const dir = mkdtempSync(join(tmpdir(), "sync-plugins-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const repo = join(dir, "repo");
  mkdirSync(bin);
  mkdirSync(join(repo, ".claude-plugin"), { recursive: true });
  writeFileSync(join(repo, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: checkout.map(name => ({ name })) }));
  const copy = join(dir, "copy");
  mkdirSync(join(copy, ".claude-plugin"), { recursive: true });
  if (marketplace) writeFileSync(join(copy, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: marketplace.map(name => ({ name })) }));
  const markets = [{ name: "other-market", installLocation: dir }, ...(marketplace ? [{ name: "spider-claude-mods", installLocation: copy }] : [])];
  const log = join(dir, "calls.jsonl");
  const cwds = join(dir, "cwds.jsonl");
  const fake = join(bin, "claude");
  writeFileSync(
    fake,
    `#!${process.execPath}
const args = process.argv.slice(2)
require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
if (${JSON.stringify(failOn ?? null)}?.every((a, i) => args[i] === a)) process.exit(1)
if (args.join(' ') === 'plugin list --json') process.stdout.write(${JSON.stringify(JSON.stringify(installed))})
if (args.join(' ') === 'plugin marketplace list --json') process.stdout.write(${JSON.stringify(JSON.stringify(markets))})
if (['update', 'uninstall'].includes(args[1])) require('fs').appendFileSync(${JSON.stringify(cwds)}, JSON.stringify([args[2], require('fs').realpathSync(process.cwd())]) + '\\n')
`,
  );
  chmodSync(fake, 0o755);
  const { stdout, stderr, status } = spawnSync(process.execPath, [SCRIPT], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
  });
  const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const dirs = existsSync(cwds) ? Object.fromEntries(readFileSync(cwds, "utf8").trim().split("\n").map(line => JSON.parse(line))) : {};
  return { stdout, stderr, status, calls, dirs, repo: realpathSync(repo) };
}

test("refreshes the marketplace first, then updates each installed plugin it lists in its own scope", (t) => {
  const { status, calls, stdout } = run(t, {
    marketplace: ["gitlab", "session-hud"],
    installed: [
      { id: "gitlab@spider-claude-mods", scope: "user" },
      { id: "session-hud@spider-claude-mods", scope: "local" },
    ],
  });
  assert.equal(status, 0);
  assert.deepEqual(calls, [
    ["plugin", "marketplace", "update", "spider-claude-mods"],
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "list", "--json"],
    ["plugin", "update", "gitlab@spider-claude-mods", "--scope", "user"],
    ["plugin", "update", "session-hud@spider-claude-mods", "--scope", "local"],
  ]);
  assert.match(stdout, /==> gitlab@spider-claude-mods \(user\)/);
  assert.match(stdout, /==> session-hud@spider-claude-mods \(local\)/);
});

test("uninstalls, in its own scope, a plugin the refreshed marketplace no longer lists, even when the checkout still does", (t) => {
  const { status, calls, stdout } = run(t, {
    marketplace: ["spider-team"],
    checkout: ["spider-team", "spider-progress"],
    installed: [
      { id: "spider-progress@spider-claude-mods", scope: "user" },
      { id: "spider-team@spider-claude-mods", scope: "user" },
    ],
  });
  assert.equal(status, 0);
  assert.deepEqual(calls.slice(3), [
    ["plugin", "uninstall", "spider-progress@spider-claude-mods", "--scope", "user"],
    ["plugin", "update", "spider-team@spider-claude-mods", "--scope", "user"],
  ]);
  assert.match(stdout, /==> spider-progress@spider-claude-mods \(user\): no longer in the marketplace, uninstalling/);
});

test("keeps a plugin the refreshed marketplace lists although the checkout does not", (t) => {
  const { status, calls } = run(t, {
    marketplace: ["gitlab", "new-plugin"],
    checkout: ["gitlab"],
    installed: [{ id: "new-plugin@spider-claude-mods", scope: "user" }],
  });
  assert.equal(status, 0);
  assert.deepEqual(calls.slice(3), [["plugin", "update", "new-plugin@spider-claude-mods", "--scope", "user"]]);
});

test("a project install is updated or uninstalled from its own project", (t) => {
  const project = mkdtempSync(join(tmpdir(), "sync-project-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const { status, dirs, repo } = run(t, {
    marketplace: ["gitlab"],
    installed: [
      { id: "gitlab@spider-claude-mods", scope: "project", projectPath: project },
      { id: "old@spider-claude-mods", scope: "project", projectPath: project },
      { id: "gitlab@spider-claude-mods", scope: "user" },
    ],
  });
  assert.equal(status, 0);
  assert.equal(dirs["old@spider-claude-mods"], realpathSync(project));
  assert.equal(dirs["gitlab@spider-claude-mods"], repo);
});

test("leaves plugins of other marketplaces alone", (t) => {
  const { status, calls, stderr, stdout } = run(t, {
    marketplace: ["gitlab"],
    installed: [
      { id: "old@other-market", scope: "user" },
      { id: "gitlab@spider-claude-mods", scope: "user" },
    ],
  });
  assert.equal(status, 0);
  assert.deepEqual(calls.slice(3), [["plugin", "update", "gitlab@spider-claude-mods", "--scope", "user"]]);
  assert.doesNotMatch(stdout + stderr, /other-market/);
});

test("a marketplace with no local copy stops before listing or changing any plugin", (t) => {
  const { status, calls, stderr } = run(t, {
    marketplace: null,
    checkout: ["gitlab"],
    installed: [{ id: "old@spider-claude-mods", scope: "user" }],
  });
  assert.notEqual(status, 0);
  assert.deepEqual(calls, [["plugin", "marketplace", "update", "spider-claude-mods"], ["plugin", "marketplace", "list", "--json"]]);
  assert.match(stderr, /spider-claude-mods has no local copy/);
});

test("a failed marketplace refresh stops before listing or changing anything", (t) => {
  const { status, calls } = run(t, {
    marketplace: ["gitlab"],
    installed: [{ id: "old@spider-claude-mods", scope: "user" }],
    failOn: ["plugin", "marketplace", "update"],
  });
  assert.notEqual(status, 0);
  assert.deepEqual(calls, [["plugin", "marketplace", "update", "spider-claude-mods"]]);
});
