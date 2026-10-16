// SessionStart: in a Claude Code cloud session, installs the tools package-lock.json pins, so the checks run as locally.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));

// Returns one line for the session; a failure is reported, never thrown, so the session still starts.
export function setup({ env = process.env, root = rootDir, run = spawnSync, append = appendFileSync } = {}) {
  if (env.CLAUDE_CODE_REMOTE !== "true") return "";
  // Child output goes to stderr: SessionStart stdout becomes session context.
  const ok = (args) => run("npm", args, { cwd: root, stdio: ["ignore", 2, 2], env }).status === 0;
  // A session started inside this one (as `npm run plugins:types` does) inherits the cloud env: npm ci would then delete
  // the node_modules its own claude runs from, so an installed tree that matches package.json is kept.
  const installed = ok(["ls", "--silent"]);
  if (!installed && !ok(["ci"])) return "cloud setup failed: npm ci did not finish";
  // The local bin first on PATH, so plain claude and tsc are the pinned versions, as `npm run` sees them.
  if (env.CLAUDE_ENV_FILE) append(env.CLAUDE_ENV_FILE, `export PATH="${join(root, "node_modules/.bin")}:$PATH"\n`);
  return "cloud setup: npm tools installed (package-lock.json)";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const line = setup();
  if (line) console.log(line);
}
