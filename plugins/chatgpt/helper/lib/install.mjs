import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, sep } from 'node:path'

import { PLAYWRIGHT_VERSION } from './version.mjs'

const corePackage = paths => join(paths.runtime, 'node_modules', 'playwright-core', 'package.json')

/** The installed playwright-core; its browsers resolve under PLAYWRIGHT_BROWSERS_PATH, which helper.mjs sets first. */
export const loadPlaywright = paths => createRequire(join(paths.runtime, 'package.json'))('playwright-core')

const DISK = { exists: existsSync, read: path => readFileSync(path, 'utf8'), load: loadPlaywright }

/** The marker Playwright's installer writes in a browser's folder once the download is whole. */
export const completeMarker = (paths, executable) => join(paths.browsers, relative(paths.browsers, executable).split(sep)[0], 'INSTALLATION_COMPLETE')

/**
 * What is missing: `runtime` (no playwright-core of the pinned version, or one that does not load), `browser` (no
 * whole Chromium build for it), or undefined when the helper can run.
 */
export function missing(paths, disk = DISK) {
  const core = corePackage(paths)
  let executable
  try {
    if (!disk.exists(core) || JSON.parse(disk.read(core)).version !== PLAYWRIGHT_VERSION) return 'runtime'
    executable = disk.load(paths).chromium.executablePath()
  } catch {
    return 'runtime'
  }
  return disk.exists(executable) && disk.exists(completeMarker(paths, executable)) ? undefined : 'browser'
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
