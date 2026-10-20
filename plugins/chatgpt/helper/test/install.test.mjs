import assert from 'node:assert/strict'
import { test } from 'node:test'

import { completeMarker, installSteps, missing } from '../lib/install.mjs'
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
  assert.equal(missing(paths, disk({ files: { ...core, '/h/browsers/chromium/chrome': '', '/h/browsers/chromium/INSTALLATION_COMPLETE': '' } })), undefined)
})

test('a download cut short (no INSTALLATION_COMPLETE) is the browser missing, and a runtime that does not load is the runtime missing', () => {
  const core = { [CORE]: JSON.stringify({ version: PLAYWRIGHT_VERSION }) }
  assert.equal(missing(paths, disk({ files: { ...core, '/h/browsers/chromium/chrome': '' } })), 'browser')
  const broken = { ...disk({ files: core }), load: () => { throw new Error("Cannot find module 'playwright-core'") } }
  assert.equal(missing(paths, broken), 'runtime')
})

test('the marker sits in the browser build folder right under the browsers folder', () => {
  const executable = '/h/browsers/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
  assert.equal(completeMarker(paths, executable), '/h/browsers/chromium-1248/INSTALLATION_COMPLETE')
})

test('the install runs npm for the pinned playwright-core, then its installer for the full Chromium build only', () => {
  const browser = ['/bin/node', '/h/runtime/node_modules/playwright-core/cli.js', 'install', 'chromium', '--no-shell']
  assert.deepEqual(installSteps(paths, 'runtime', '/bin/node'), [
    ['npm', 'install', '--prefix', '/h/runtime', '--no-audit', '--no-fund', `playwright-core@${PLAYWRIGHT_VERSION}`],
    browser,
  ])
  assert.deepEqual(installSteps(paths, 'browser', '/bin/node'), [browser])
})
