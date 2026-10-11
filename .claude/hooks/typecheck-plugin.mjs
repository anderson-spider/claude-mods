// PostToolUse (Edit|Write): type-checks the plugin that owns the edited .ts/.tsx file.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const MAX_LINES = 40;

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const file = resolve(input.cwd ?? process.cwd(), String(input.tool_input?.file_path ?? "").replaceAll("\\", "/"));
const match = /^(.*)\/plugins\/([^/]+)\/.+\.tsx?$/.exec(file);
if (!match || file.includes("/.claude-plugin/types/")) process.exit(0);

const [, root, plugin] = match;
const tsconfig = join(root, "plugins", plugin, "tsconfig.json");
// The typings tsconfig.json extends exist only after `mise run plugins:types`; without them tsc only reports noise.
if (!existsSync(tsconfig) || !existsSync(join(root, "plugins", plugin, ".claude-plugin/types/tsconfig.json"))) {
  process.exit(0);
}

const run = spawnSync("mise", ["exec", "--", "tsc", "-p", tsconfig, "--noEmit"], {
  cwd: root,
  encoding: "utf8",
  timeout: 90_000,
});
if (run.error) {
  console.error(`typecheck skipped for plugins/${plugin}: ${run.error.message}`);
  process.exit(0);
}
if (run.status !== 0) {
  // tsc checks the whole plugin: list the edited file's errors first so they are not buried under the rest.
  const edited = relative(root, file);
  const lines = `${run.stdout}${run.stderr}`.split("\n").filter(Boolean);
  const own = lines.filter((line) => line.startsWith(edited));
  const rest = lines.filter((line) => !line.startsWith(edited));
  const shown = [...own, ...rest].slice(0, MAX_LINES);
  const cut = lines.length - shown.length;
  console.error(
    [
      `tsc failed for plugins/${plugin} (${own.length} line(s) in ${edited}, ${rest.length} elsewhere):`,
      ...shown,
      ...(cut > 0 ? [`... ${cut} more line(s) not shown`] : []),
    ].join("\n")
  );
  process.exit(2);
}
