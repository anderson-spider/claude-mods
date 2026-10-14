// SessionStart: in a Claude Code cloud session, installs mise and the tools mise.toml pins, so the checks run as locally.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The cloud proxy reaches npm and nodejs.org but not mise.run or GitHub releases, so mise comes from its npm package.
export const MISE_PACKAGE = "@jdxcode/mise@2026.10.10";
const rootDir = fileURLToPath(new URL("../../", import.meta.url));

// Returns one line for the session; a failure is reported, never thrown, so the session still starts.
export function setup({ env = process.env, root = rootDir, run = spawnSync, append = appendFileSync } = {}) {
  if (env.CLAUDE_CODE_REMOTE !== "true") return "";
  // Child output goes to stderr: SessionStart stdout becomes session context.
  const ok = (cmd, args) => run(cmd, args, { cwd: root, stdio: ["ignore", 2, 2], env: { ...env, MISE_YES: "1" } }).status === 0;
  if (!ok("mise", ["--version"]) && !ok("npm", ["install", "--global", MISE_PACKAGE])) return `cloud setup failed: npm could not install ${MISE_PACKAGE}`;
  if (!ok("mise", ["trust"]) || !ok("mise", ["install"])) return "cloud setup failed: mise install did not finish";
  // Shims first on PATH, so plain node and tsc are the pinned versions, as with an activated mise.
  const shims = join(env.MISE_DATA_DIR ?? join(env.HOME ?? "", ".local/share/mise"), "shims");
  if (env.CLAUDE_ENV_FILE) append(env.CLAUDE_ENV_FILE, `export MISE_YES=1\nexport PATH="${shims}:$PATH"\n`);
  return "cloud setup: mise tools installed (mise.toml)";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const line = setup();
  if (line) console.log(line);
}
