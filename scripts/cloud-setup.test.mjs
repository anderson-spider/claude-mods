import assert from "node:assert/strict";
import test from "node:test";
import { MISE_PACKAGE, setup } from "../.claude/hooks/cloud-setup.mjs";

const REMOTE = { CLAUDE_CODE_REMOTE: "true", HOME: "/home/u", CLAUDE_ENV_FILE: "/env" };

function fake(failing = []) {
  const calls = [];
  const writes = [];
  const run = (cmd, args, options) => {
    calls.push([cmd, ...args].join(" "));
    assert.equal(options.cwd, "/repo");
    assert.equal(options.env.MISE_YES, "1");
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

test("in a cloud session mise is installed from npm when missing, then the pinned tools, with its shims on PATH", () => {
  const f = fake(["mise --version"]);
  assert.equal(setup({ env: REMOTE, root: "/repo", run: f.run, append: f.append }), "cloud setup: mise tools installed (mise.toml)");
  assert.deepEqual(f.calls, ["mise --version", `npm install --global ${MISE_PACKAGE}`, "mise trust", "mise install"]);
  assert.deepEqual(f.writes, [["/env", 'export MISE_YES=1\nexport PATH="/home/u/.local/share/mise/shims:$PATH"\n']]);
});

test("a present mise is reused, and MISE_DATA_DIR places the shims", () => {
  const f = fake();
  setup({ env: { ...REMOTE, MISE_DATA_DIR: "/data" }, root: "/repo", run: f.run, append: f.append });
  assert.deepEqual(f.calls, ["mise --version", "mise trust", "mise install"]);
  assert.match(f.writes[0][1], /PATH="\/data\/shims:\$PATH"/);
});

test("a failed step is reported, not thrown, and touches no env file", () => {
  for (const [failing, line] of [
    [["mise --version", `npm install --global ${MISE_PACKAGE}`], `cloud setup failed: npm could not install ${MISE_PACKAGE}`],
    [["mise install"], "cloud setup failed: mise install did not finish"],
  ]) {
    const f = fake(failing);
    assert.equal(setup({ env: REMOTE, root: "/repo", run: f.run, append: f.append }), line);
    assert.deepEqual(f.writes, []);
  }
});
