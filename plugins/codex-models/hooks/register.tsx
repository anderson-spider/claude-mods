import type { Hook, Register } from 'claude-code'
import { configOf, loopbackBase, noticeText, probe, reportText, settingsView, tokenOf, versionOf } from './status'
import type { ProbeIo, SettingsView } from './status'

/** The `$` a hook receives; every function below takes its hook's own and keeps none. */
type Dollar = Parameters<Hook<'session.start'>>[0]

/** The status check's host access: the request through the host's network, the deadline on the host's clock. */
function probeIo($: Dollar): ProbeIo {
  return {
    fetch: async (url, headers) => {
      const reply = await $.http.fetch(url, { headers })
      return { status: reply.status, text: reply.text }
    },
    timer: (ms, fn) => {
      const handle = $.clock.after(ms, fn)
      return () => handle.cancel()
    },
  }
}

async function pluginVersion($: Dollar): Promise<string> {
  try {
    return versionOf(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`))
  } catch {
    return 'unknown'
  }
}

/** ccmproxy's config in the install-owned home (the URL it listens on and its secret), or nothing when unreadable. */
async function proxyConfig($: Dollar): Promise<{ base?: string; token?: string }> {
  try {
    const home = await $.env.get('HOME')
    if (!home || !home.startsWith('/')) return {}
    return configOf(await $.fs.read(`${home}/.claude/codex-models/home/config.json`))
  } catch {
    return {}
  }
}

/** The base URL and secret this session sends, from its environment (settings.json's `env` lands there). */
async function sessionTarget($: Dollar): Promise<{ base?: string; token?: string }> {
  const base = loopbackBase(await $.env.get('ANTHROPIC_BASE_URL'))
  const token = tokenOf(await $.env.get('ANTHROPIC_CUSTOM_HEADERS'))
  return { ...(base ? { base } : {}), ...(token ? { token } : {}) }
}

async function userSettings($: Dollar): Promise<SettingsView | undefined> {
  try {
    return settingsView(await $.settings.read({ source: 'user' }))
  } catch {
    return undefined
  }
}

/** At start, one bounded check of the proxy this session goes through, and a line when it cannot serve it. */
async function checkAtStart($: Dollar) {
  const session = await sessionTarget($)
  if (!session.base) return
  const found = await probe(probeIo($), session.base, session.token)
  $.ui.log(`status check at start: ${found.kind}`, { to: 'debug' })
  const text = noticeText(found, { base: session.base, pluginVersion: await pluginVersion($), pluginRoot: $.plugin.root })
  if (!text) return
  // The transcript line stays; the toast draws the eye at start. A `-p` run shows neither to anyone.
  $.ui.log(text, { to: 'transcript' })
  $.ui.toast(text, { timeoutMs: 15000 })
}

async function statusReport($: Dollar): Promise<string> {
  const [version, session, config, settings] = await Promise.all([pluginVersion($), sessionTarget($), proxyConfig($), userSettings($)])
  const base = session.base ?? config.base
  // The session's own secret first: that is what its requests carry.
  const found = base ? await probe(probeIo($), base, session.token ?? config.token) : undefined
  return reportText({
    pluginVersion: version,
    pluginRoot: $.plugin.root,
    ...(base ? { base } : {}),
    ...(found ? { probe: found } : {}),
    ...(config.token ? { configToken: config.token } : {}),
    ...(settings ? { settings } : {}),
  })
}

export const register: Register = on => {
  // Observes only: the start goes on whatever the check finds, and a failed check is one debug line.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      await checkAtStart($)
    } catch {
      try {
        $.ui.log('status check at start failed', { to: 'debug' })
      } catch {}
    }
    return started
  })

  // Answers the command itself, so the markdown body is only a fallback for a plugin that did not load.
  on('command.run', { command: 'codex-models:status' }, async $ => ({ text: await statusReport($) })).catch(() => ({
    text: 'codex-models: the status check failed; run /reload-plugins and try again.',
  }))
}
