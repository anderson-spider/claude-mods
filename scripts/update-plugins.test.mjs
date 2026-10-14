import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./update-plugins.mjs", import.meta.url));

// Runs the script in a checkout holding `marketplace`, with a fake `claude` first on PATH that logs each call and
// answers `plugin list --json` with `installed`; `failOn` makes the call whose arguments start with it exit 1.
function run(t, { marketplace, installed, failOn }) {
  const dir = mkdtempSync(join(tmpdir(), "update-plugins-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const repo = join(dir, "repo");
  mkdirSync(bin);
  mkdirSync(join(repo, ".claude-plugin"), { recursive: true });
  writeFileSync(join(repo, ".claude-plugin", "marketplace.json"), JSON.stringify({ plugins: marketplace.map(name => ({ name })) }));
  const log = join(dir, "calls.jsonl");
  const fake = join(bin, "claude");
  writeFileSync(
    fake,
    `#!${process.execPath}
const args = process.argv.slice(2)
require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
if (${JSON.stringify(failOn ?? null)}?.every((a, i) => args[i] === a)) process.exit(1)
if (args.join(' ') === 'plugin list --json') process.stdout.write(${JSON.stringify(JSON.stringify(installed))})
`,
  );
  chmodSync(fake, 0o755);
  const { stdout, stderr, status } = spawnSync(process.execPath, [SCRIPT], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
  });
  const calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { stdout, stderr, status, calls };
}

test("refreshes the marketplace first, then updates each installed plugin of it in its own scope", (t) => {
  const { status, calls, stdout } = run(t, {
    marketplace: ["gitlab", "session-hud"],
    installed: [
      { id: "gitlab@spider-claude-mods", scope: "user" },
      { id: "session-hud@spider-claude-mods", scope: "project" },
    ],
  });
  assert.equal(status, 0);
  assert.deepEqual(calls, [
    ["plugin", "marketplace", "update", "spider-claude-mods"],
    ["plugin", "list", "--json"],
    ["plugin", "update", "gitlab@spider-claude-mods", "--scope", "user"],
    ["plugin", "update", "session-hud@spider-claude-mods", "--scope", "project"],
  ]);
  assert.match(stdout, /==> gitlab@spider-claude-mods \(user\)/);
  assert.match(stdout, /==> session-hud@spider-claude-mods \(project\)/);
});

test("leaves plugins of other marketplaces alone, and names one this marketplace no longer has", (t) => {
  const { status, calls, stderr } = run(t, {
    marketplace: ["gitlab"],
    installed: [
      { id: "gitlab@other-market", scope: "user" },
      { id: "git-master@spider-claude-mods", scope: "user" },
      { id: "gitlab@spider-claude-mods", scope: "local" },
    ],
  });
  assert.equal(status, 0);
  assert.deepEqual(calls.slice(2), [["plugin", "update", "gitlab@spider-claude-mods", "--scope", "local"]]);
  assert.match(stderr, /skip: git-master@spider-claude-mods is no longer in the marketplace; uninstall it/);
  assert.doesNotMatch(stderr, /other-market/);
});

test("a failed marketplace refresh stops before listing or updating anything", (t) => {
  const { status, calls } = run(t, {
    marketplace: ["gitlab"],
    installed: [{ id: "gitlab@spider-claude-mods", scope: "user" }],
    failOn: ["plugin", "marketplace", "update"],
  });
  assert.notEqual(status, 0);
  assert.deepEqual(calls, [["plugin", "marketplace", "update", "spider-claude-mods"]]);
});
