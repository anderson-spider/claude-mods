import { readFileSync } from 'node:fs'

// The helper runs from the plugin's folder, so its version is the plugin's: `start` replaces a running daemon of
// another version, and the hooks compare `/health` with their own plugin.json.
export const VERSION = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version

// The playwright-core the helper installs; it pins the Chromium build `install chromium` downloads.
export const PLAYWRIGHT_VERSION = '1.64.1'
