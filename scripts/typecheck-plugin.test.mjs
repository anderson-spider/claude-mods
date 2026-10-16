import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const hook = fileURLToPath(new URL("../.claude/hooks/typecheck-plugin.mjs", import.meta.url));

for (const { name, file, config, warning } of [
  { name: "missing typings warn without blocking the edit", file: "plugins/example/hooks/register.tsx", config: true, warning: true },
  { name: "a plugin without tsconfig still skips silently", file: "plugins/example/hooks/register.tsx", config: false, warning: false },
  { name: "generated typings are still ignored", file: "plugins/example/.claude-plugin/types/index.d.ts", config: true, warning: false },
  { name: "files outside plugins are still ignored", file: "scripts/example.ts", config: true, warning: false },
]) {
  test(name, (t) => {
    const root = mkdtempSync(join(tmpdir(), "typecheck-plugin-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    if (config) {
      const plugin = join(root, "plugins/example");
      mkdirSync(plugin, { recursive: true });
      writeFileSync(join(plugin, "tsconfig.json"), "{}");
    }
    const result = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ cwd: root, tool_input: { file_path: file } }),
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, warning
      ? "typecheck skipped for plugins/example: typings missing; run npm run plugins:types (SessionStart reuses matching main-checkout typings when available)\n"
      : "");
  });
}

test("present typings without an installed TypeScript warn without blocking the edit", (t) => {
  const root = mkdtempSync(join(tmpdir(), "typecheck-plugin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plugin = join(root, "plugins/example");
  mkdirSync(join(plugin, ".claude-plugin/types"), { recursive: true });
  writeFileSync(join(plugin, "tsconfig.json"), "{}");
  writeFileSync(join(plugin, ".claude-plugin/types/tsconfig.json"), "{}");
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ cwd: root, tool_input: { file_path: join(root, "plugins/example/hooks/register.tsx") } }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "typecheck skipped for plugins/example: TypeScript is not installed; run npm ci\n");
});

test("a worktree without node_modules type-checks with the main checkout's TypeScript", (t) => {
  const main = mkdtempSync(join(tmpdir(), "typecheck-main-"));
  const worktree = `${main}-worktree`;
  t.after(() => {
    rmSync(main, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });
  const git = (...args) => assert.equal(spawnSync("git", args, { cwd: main, encoding: "utf8" }).status, 0);
  mkdirSync(join(main, "plugins/example/.claude-plugin/types"), { recursive: true });
  writeFileSync(join(main, "plugins/example/tsconfig.json"), "{}");
  writeFileSync(join(main, "plugins/example/.claude-plugin/types/tsconfig.json"), "{}");
  git("init", "-q");
  git("add", "plugins");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
  git("worktree", "add", "-q", worktree);
  mkdirSync(join(worktree, "plugins/example/.claude-plugin/types"), { recursive: true });
  writeFileSync(join(worktree, "plugins/example/.claude-plugin/types/tsconfig.json"), "{}");
  // A fake tsc in the main checkout records where it ran and passes.
  const marker = join(main, "tsc-ran");
  mkdirSync(join(main, "node_modules/.bin"), { recursive: true });
  writeFileSync(join(main, "node_modules/.bin/tsc"), `#!/bin/sh\npwd > "${marker}"\n`);
  chmodSync(join(main, "node_modules/.bin/tsc"), 0o755);

  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ cwd: worktree, tool_input: { file_path: join(worktree, "plugins/example/hooks/register.tsx") } }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.ok(existsSync(marker));
  assert.equal(readFileSync(marker, "utf8").trim(), worktree);
});
