import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bootstrap, reusePluginTypes } from "./ensure-plugin-types.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "ensure-plugin-types-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "worktree");
  const main = join(dir, "main");
  const parent = join(root, "plugins", "example", ".claude-plugin");
  const source = join(main, "plugins", "example", ".claude-plugin", "types");
  mkdirSync(parent, { recursive: true });
  mkdirSync(source, { recursive: true });
  for (const base of [parent, join(main, "plugins", "example", ".claude-plugin")]) {
    writeFileSync(join(base, "plugin.json"), '{"name":"example"}');
  }
  const types = ["claude-code", "claude-code-tools", "claude-code-mcp"];
  writeFileSync(join(source, "tsconfig.json"), JSON.stringify({ compilerOptions: { types } }));
  for (const name of types) {
    mkdirSync(join(source, name));
    writeFileSync(join(source, name, "index.d.ts"), name === "claude-code" ? "// Written by Claude Code 2.1.296.\n" : "// declaration\n");
  }
  return { dir, root, main, parent, source, target: join(parent, "types") };
}

test("copies complete declarations once and preserves existing destinations", (t) => {
  const { root, main, target } = fixture(t);
  assert.deepEqual(reusePluginTypes(root, main, "2.1.296"), ["example"]);
  assert.equal(existsSync(join(target, "claude-code-mcp", "index.d.ts")), true);
  assert.deepEqual(reusePluginTypes(root, main, "2.1.296"), []);
  assert.deepEqual(reusePluginTypes(root, root, "2.1.296"), []);
});

test("rejects incomplete source without leaving staging behind", (t) => {
  const { root, main, parent, source, target } = fixture(t);
  rmSync(join(source, "claude-code-mcp"), { recursive: true });
  assert.deepEqual(reusePluginTypes(root, main, "2.1.296"), []);
  assert.equal(existsSync(target), false);
  assert.deepEqual(readStaging(parent), []);
});

test("never mixes partial destination with a different source version", (t) => {
  const { root, main, target } = fixture(t);
  mkdirSync(join(target, "claude-code"), { recursive: true });
  const old = join(target, "claude-code", "index.d.ts");
  writeFileSync(old, "// Written by Claude Code 1.0.0.\n");
  assert.deepEqual(reusePluginTypes(root, main, "2.1.296"), []);
  assert.equal(existsSync(join(target, "tsconfig.json")), false);
  assert.equal(readFileSync(old, "utf8"), "// Written by Claude Code 1.0.0.\n");
});

test("refuses symlink escapes in .claude-plugin and types", (t) => {
  for (const part of [".claude-plugin", "types"]) {
    const { dir, root, main, parent } = fixture(t);
    const outside = join(dir, `outside-${part}`);
    mkdirSync(outside);
    if (part === ".claude-plugin") {
      rmSync(parent, { recursive: true });
      symlinkSync(outside, parent);
    } else {
      symlinkSync(outside, join(parent, "types"));
    }
    assert.deepEqual(reusePluginTypes(root, main, "2.1.296"), []);
    assert.equal(existsSync(join(outside, "types", "tsconfig.json")), false);
    assert.equal(existsSync(join(outside, "tsconfig.json")), false);
  }
});

test("rejects a symlink inside source and recovers after it is repaired", (t) => {
  const { root, main, source, target } = fixture(t);
  const declaration = join(source, "claude-code-tools", "index.d.ts");
  rmSync(declaration);
  symlinkSync(join(source, "claude-code", "index.d.ts"), declaration);
  assert.deepEqual(reusePluginTypes(root, main, "2.1.296"), []);
  assert.equal(existsSync(target), false);
  rmSync(declaration);
  writeFileSync(declaration, "// declaration\n");
  assert.deepEqual(reusePluginTypes(root, main, "2.1.296"), ["example"]);
});

test("startup avoids slow or unavailable subprocesses and missing sources", (t) => {
  const { root, main, source } = fixture(t);
  const seen = [];
  const run = (cmd, _args, options) => {
    seen.push([cmd, options.timeout]);
    if (cmd === "git") return { status: 0, stdout: `worktree ${main}\nHEAD abc\n` };
    return { status: null, error: new Error("ETIMEDOUT") };
  };
  assert.deepEqual(bootstrap(root, run), []);
  assert.deepEqual(seen, [["git", 750], ["claude", 750]]);
  seen.length = 0;
  rmSync(source, { recursive: true });
  assert.deepEqual(bootstrap(root, run), []);
  assert.deepEqual(seen, [["git", 750]]);
  assert.deepEqual(bootstrap(root, () => { throw new Error("missing git"); }), []);
  assert.deepEqual(bootstrap(main, () => ({ status: 0, stdout: `worktree ${main}\n` })), []);
});

function readStaging(parent) {
  return readdirSync(parent).filter((name) => name.startsWith(".types-"));
}
