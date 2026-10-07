import type { On } from 'claude-code'

declare const setTimeout: (fn: () => void, ms: number) => unknown
export const pause = (ms: number) => new Promise<void>(done => setTimeout(() => done(), ms))
export const ran = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

export const TOOL = 'mcp__codex-computer-use__codex_cu'
export const OWN = 'mcp__computer-use__left_click'
export const BAND = {
  plugin: 'codex-computer-use',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const

export const COMPOSE = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never

type Posted = { route: string; body: Record<string, unknown>; socketPath?: string }

/**
 * A fake helper behind curl: TextEdit needs approval until the caller answers,
 * Calculator is approved, and `get n` reads back what `set n=` stored per caller.
 */
export const world = (on: On) => {
  const posted: Posted[] = []
  const allowed = new Map<string, string>()
  const vars = new Map<string, string>()
  const store = new Map<string, unknown>()

  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => (store.set(e.key, e.value), { value: undefined }))
  on('env.get', () => ({ value: '/home/me' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'sleep') {
      await pause(5)
    }

    return { value: ran('') }
  })
  on('http.fetch', async (_$, e) => {
    const route = e.url.replace('http://codex-cu', '')
    const body = JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>
    posted.push({ route, body, socketPath: e.init?.socketPath })
    const caller = String(body.caller)
    const code = String(body.code ?? '')
    const reply = (value: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(value) } })

    if (route === '/forget') {
      return body.app === 'Nowhere'
        ? reply({ status: 'error', message: 'no app found for "Nowhere"' })
        : reply({ status: 'ok', bundleId: 'com.apple.grapher', helper: true, codex: 'removed' })
    }

    if (route === '/approve') {
      allowed.set(`${caller}:${String(body.bundleId)}`, String(body.choice))

      return reply({ status: 'ok' })
    }

    if (route === '/call' && code.includes('TextEdit')) {
      const answer = allowed.get(`${caller}:com.apple.TextEdit`)

      if (answer === undefined) {
        return reply({ status: 'needs_approval', app: { bundleId: 'com.apple.TextEdit', displayName: 'TextEdit', canAlways: true } })
      }

      if (answer === 'deny') {
        return reply({ status: 'denied', app: { bundleId: 'com.apple.TextEdit', displayName: 'TextEdit' } })
      }
    }

    if (route === '/call' && code.includes('Calculator') && caller !== 'sess-1') {
      return reply({ status: 'busy', app: { bundleId: 'com.apple.calculator', displayName: 'Calculator' }, owner: 'sess-1', idleSeconds: 12 })
    }

    if (route === '/call') {
      const set = /^set n=(.*)$/.exec(code)

      if (set !== null) {
        vars.set(caller, set[1] ?? '')
      }

      const text = code === 'get n' ? (vars.get(caller) ?? 'undefined') : `ran ${code}`

      return reply({ status: 'ok', isError: false, content: [{ type: 'text', text }] })
    }

    return reply({ status: 'ok', ended: [] })
  })
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['idle'] }))
  on('tool.call', { tool: OWN }, () => ({ result: 'clicked' }))

  return posted
}

export const textOf = (result: { result?: unknown }) => (typeof result.result === 'string' ? result.result : JSON.stringify(result.result))
