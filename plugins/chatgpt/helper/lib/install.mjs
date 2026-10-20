import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { PLAYWRIGHT_VERSION } from './version.mjs'

const corePackage = paths => join(paths.runtime, 'node_modules', 'playwright-core', 'package.json')

/** The installed playwright-core; its browsers resolve under PLAYWRIGHT_BROWSERS_PATH, which helper.mjs sets first. */
export const loadPlaywright = paths => createRequire(join(paths.runtime, 'package.json'))('playwright-core')

const DISK = { exists: existsSync, read: path => readFileSync(path, 'utf8'), load: loadPlaywright }

/**
 * What is missing: `runtime` (no playwright-core, or another version than the pinned one), `browser` (no Chromium
 * build for it), or undefined when the helper can run.
 */
export function missing(paths, disk = DISK) {
  const core = corePackage(paths)
  if (!disk.exists(core) || JSON.parse(disk.read(core)).version !== PLAYWRIGHT_VERSION) return 'runtime'
  return disk.exists(disk.load(paths).chromium.executablePath()) ? undefined : 'browser'
}

/**
 * The commands that install what `lacking` names, in order. `install chromium --no-shell` takes the full build, which
 * headless runs on (`channel: 'chromium'`), without the separate headless shell.
 */
export function installSteps(paths, lacking, node) {
  const browser = [node, join(paths.runtime, 'node_modules', 'playwright-core', 'cli.js'), 'install', 'chromium', '--no-shell']
  if (lacking === 'browser') return [browser]
  return [['npm', 'install', '--prefix', paths.runtime, '--no-audit', '--no-fund', `playwright-core@${PLAYWRIGHT_VERSION}`], browser]
}
