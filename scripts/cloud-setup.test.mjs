import assert from "node:assert/strict";
import test from "node:test";
import { setup } from "../.claude/hooks/cloud-setup.mjs";

const REMOTE = { CLAUDE_CODE_REMOTE: "true", HOME: "/home/u", CLAUDE_ENV_FILE: "/env" };

function fake(failing = []) {
  const calls = [];
  const writes = [];
  const run = (cmd, args, options) => {
    calls.push([cmd, ...args].join(" "));
    assert.equal(options.cwd, "/repo");
    return { status: failing.includes([cmd, ...args].join(" ")) ? 1 : 0 };
  };
  const append = (file, text) => writes.push([file, text]);
  return { calls, writes, run, append };
}

test("outside a cloud session nothing runs and nothing is said", () => {
  const f = fake();
  assert.equal(setup({ env: { HOME: "/home/u" }, root: "/repo", run: f.run, append: f.append }), "");
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.writes, []);
});

test("in a cloud session npm ci installs the pinned tools and puts the local bin on PATH", () => {
  const f = fake(["npm ls --silent"]);
  assert.equal(setup({ env: REMOTE, root: "/repo", run: f.run, append: f.append }), "cloud setup: npm tools installed (package-lock.json)");
  assert.deepEqual(f.calls, ["npm ls --silent", "npm ci"]);
  assert.deepEqual(f.writes, [["/env", 'export PATH="/repo/node_modules/.bin:$PATH"\n']]);
});

test("an installed tree is kept, so a nested session does not reinstall the CLI it runs from", () => {
  const f = fake();
  assert.equal(setup({ env: REMOTE, root: "/repo", run: f.run, append: f.append }), "cloud setup: npm tools installed (package-lock.json)");
  assert.deepEqual(f.calls, ["npm ls --silent"]);
  assert.equal(f.writes.length, 1);
});

test("a failed npm ci is reported, not thrown, and touches no env file", () => {
  const f = fake(["npm ls --silent", "npm ci"]);
  assert.equal(setup({ env: REMOTE, root: "/repo", run: f.run, append: f.append }), "cloud setup failed: npm ci did not finish");
  assert.deepEqual(f.writes, []);
});
