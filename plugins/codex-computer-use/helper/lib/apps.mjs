// Which apps a piece of bridge code names, and their bundle identifiers, so the
// helper can check ownership before the code runs. Best effort: an app reached
// through a variable is only learned from the result's `codex/toolSurface` meta.
import { execFile } from 'node:child_process'

const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/

/** The string literals passed to `getApp(...)` and `launch_app({ app })`. */
export const namedApps = code => {
  const names = new Set()

  for (const match of code.matchAll(/\bgetApp\(\s*(["'`])([^"'`$]+)\1/g)) {
    names.add(match[2].trim())
  }

  for (const match of code.matchAll(/\blaunch_app\(\s*\{\s*app\s*:\s*(["'`])([^"'`$]+)\1/g)) {
    names.add(match[2].trim())
  }

  return [...names].filter(name => name !== '')
}

/** The app a result's meta says the call used, as a bundle identifier. */
export const usedApp = result => {
  const app = result?._meta?.['codex/toolSurface']?.app

  return app?.kind === 'appId' && typeof app.appId === 'string' ? app.appId : undefined
}

const run = (file, args) =>
  new Promise(resolve =>
    execFile(file, args, { timeout: 5000 }, (error, stdout) => resolve(error === null ? stdout.trim() : '')),
  )

const quote = text => text.replace(/["\\]/g, '\\$&')

/** Resolves a name, path or bundle id to a bundle id with Spotlight (no app is launched); undefined when unknown. */
export const resolveBundleId = async (name, aliases = new Map()) => {
  if (BUNDLE_ID.test(name) && !name.endsWith('.app')) {
    return name
  }

  if (aliases.has(name.toLowerCase())) {
    return aliases.get(name.toLowerCase())
  }

  let path = name.startsWith('/') ? name : undefined

  if (path === undefined) {
    const bare = quote(name.replace(/\.app$/i, ''))
    const query = `kMDItemContentType == "com.apple.application-bundle" && (kMDItemFSName == "${bare}.app"c || kMDItemDisplayName == "${bare}"c)`
    const found = (await run('/usr/bin/mdfind', [query])).split('\n').filter(line => line !== '')
    path = found.find(line => /^\/(System\/)?Applications\//.test(line)) ?? found[0]
  }

  if (path === undefined) {
    return undefined
  }

  const id = await run('/usr/bin/mdls', ['-raw', '-name', 'kMDItemCFBundleIdentifier', path])

  return id === '' || id === '(null)' ? undefined : id
}
