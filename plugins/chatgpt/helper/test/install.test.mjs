import assert from 'node:assert/strict'
import { test } from 'node:test'

import { installSteps, missing } from '../lib/install.mjs'
import { pathsOf } from '../lib/paths.mjs'
import { PLAYWRIGHT_VERSION } from '../lib/version.mjs'

const paths = pathsOf('/h')
const CORE = '/h/runtime/node_modules/playwright-core/package.json'

const disk = ({ files = {}, executable = '/h/browsers/chromium/chrome' } = {}) => ({
  exists: path => Object.hasOwn(files, path),
  read: path => files[path],
  load: () => ({ chromium: { executablePath: () => executable } }),
})

test('missing names the runtime, then the browser, then nothing', () => {
  assert.equal(missing(paths, disk()), 'runtime')
  assert.equal(missing(paths, disk({ files: { [CORE]: '{"version":"1.0.0"}' } })), 'runtime')
  const core = { [CORE]: JSON.stringify({ version: PLAYWRIGHT_VERSION }) }
  assert.equal(missing(paths, disk({ files: core })), 'browser')
  assert.equal(missing(paths, disk({ files: { ...core, '/h/browsers/chromium/chrome': '' } })), undefined)
})

test('the install runs npm for the pinned playwright-core, then its installer for the full Chromium build only', () => {
  const browser = ['/bin/node', '/h/runtime/node_modules/playwright-core/cli.js', 'install', 'chromium', '--no-shell']
  assert.deepEqual(installSteps(paths, 'runtime', '/bin/node'), [
    ['npm', 'install', '--prefix', '/h/runtime', '--no-audit', '--no-fund', `playwright-core@${PLAYWRIGHT_VERSION}`],
    browser,
  ])
  assert.deepEqual(installSteps(paths, 'browser', '/bin/node'), [browser])
})
