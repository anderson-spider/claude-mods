import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
