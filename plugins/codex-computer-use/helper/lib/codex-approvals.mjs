// Codex's own "always allow" list (ComputerUseAppApprovals.json), which node_repl
// reads to approve an app without asking and writes when an answer says "always".
// This module only ever removes entries, and leaves every other key as it was.
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CODEX_APPROVALS = join(
  homedir(),
  'Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Application Support/Software/ComputerUseAppApprovals.json',
)

/**
 * Removes `bundleId` from `approvedBundleIdentifiers` in `file`.
 * @returns `removed`, `absent` (not listed), or `missing` (no file); throws when the file is not the expected shape.
 */
export const removeCodexApproval = (bundleId, file = CODEX_APPROVALS) => {
  if (!existsSync(file)) {
    return 'missing'
  }

  const data = JSON.parse(readFileSync(file, 'utf8'))
  const ids = data?.approvedBundleIdentifiers

  if (data === null || typeof data !== 'object' || !Array.isArray(ids)) {
    throw new Error(`${file} has no approvedBundleIdentifiers list; left untouched.`)
  }

  const kept = ids.filter(id => id !== bundleId)

  if (kept.length === ids.length) {
    return 'absent'
  }

  const temp = `${file}.codex-cu.tmp`
  // Same layout as Codex writes it: two-space indent, no trailing newline.
  writeFileSync(temp, JSON.stringify({ ...data, approvedBundleIdentifiers: kept }, null, 2), { mode: statSync(file).mode & 0o777 })
  renameSync(temp, file)

  return 'removed'
}
