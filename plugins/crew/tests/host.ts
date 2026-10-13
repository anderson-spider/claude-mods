// The shared host for the crew host tests: the world beneath the plugin (env, settings, files, the API, the spawn and
// the step it routes), the fixtures and the assertions that read what it saw. A new host test builds its world here
// instead of declaring another one.
import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// Key-shaped fixtures are assembled at runtime so no source literal matches a secret scanner.
export const KEY = ['key-', 'jev-0123456789abcdef'].join('')
export const TOKEN = ['ghp_', 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4'].join('')
export const HOME = '/home/u'
export const ROOT = '/repo'
export const ON = { options: { jevKey: KEY } }
export const OFF = { options: {} }

export const answer = (depth: number) =>
  JSON.stringify({
    model: 'jev-1.13.0',
    answers: {
      reasoning_depth: { score: depth, confidence: 0.5 },
    },
  })

export type Reply = { status: number; ok: boolean; headers: Record<string, string>; text: string }
export const ok = (text: string): Reply => ({ status: 200, ok: true, headers: {}, text })
export const rejected = (status: number): Reply => ({ status, ok: false, headers: {}, text: `HTTP ${status}` })

/** A request the plugin sent through `$.http.fetch`. */
export type Fetched = { url: string; headers: Record<string, string>; body: string }
export type Replies = (call: Fetched) => Promise<Reply>

/**
 * The host's `http.fetch`, no network: it records each request in `calls` before it awaits `reply`, which answers every
 * URL. Routing by URL comes back with its first consumer and a test.
 */
export function fakeFetch(on: On, reply: Replies, calls: Fetched[] = [], helper?: { replies: Replies; calls: Fetched[] }): Fetched[] {
  on('http.fetch', async (_$, e) => {
    const call = {
      url: e.url,
      headers: (e.init?.headers ?? {}) as Record<string, string>,
      body: String(e.init?.body ?? ''),
    }
    // The crew Codex helper's socket is its own world: its calls are kept apart, and no socket answers by default.
    if (helper && call.url.startsWith(HELPER_URL)) {
      helper.calls.push(call)
      return { value: await helper.replies(call) }
    }
    calls.push(call)
    return { value: await reply(call) }
  })
  return calls
}

/** The URL prefix of every request to the crew Codex helper (`hooks/appserver.ts`). */
export const HELPER_URL = 'http://crew-codex/'

export type Seen = {
  fetches: Fetched[]
  /** What the plugin put on the status line, in order. */
  statusLine: (string | undefined)[]
  /** The slash commands the plugin registered. */
  commands: string[]
  /** The agent types the plugin registered, as it registered them. */
  registered: { name: string; model?: string; description: string }[]
  spawned: Record<string, unknown>[]
  steps: (string | number | undefined)[]
  notices: string[]
  logs: string[]
  writes: { path: string; text: string }[]
  /** The lines `$.ui.log` sent to the transcript. */
  transcript: string[]
  settingsReads: number
  /** What the plugin sent to the crew Codex helper's socket (the API calls are in `fetches`). */
  helper: Fetched[]
}

/** The host beneath the plugin: env, settings and files, Jev's endpoint, the spawn and the step the plugin routes. */
export function jevWorld(
  on: On,
  opts: {
    env?: Record<string, string>
    project?: Record<string, unknown>
    local?: Record<string, unknown>
    files?: Record<string, string>
    /** The repository's settings cannot be read (the returned `flags` can switch it later). */
    settingsFail?: boolean
    /** The session's directory; the repository root by default. */
    cwd?: string
    root?: string
    /** What the API answers, for every URL (see `fakeFetch`). */
    reply?: Replies
    /** What the crew Codex helper's socket answers; by default nothing listens on it. */
    helper?: Replies
    spawn?: (e: Record<string, unknown>) => Promise<{ model: string; agentId: string }>
    agents?: { id: string; type: string; description: string }[]
    /** The decision log's write rejects. */
    writeFail?: boolean
    /** The decision log's write never settles. */
    writeHang?: boolean
    /** The model id the API reports for a step; none by default (no usage). */
    stepModel?: string | (() => string | undefined)
    /** Holds the API answer so a step may finish after its spawn. */
    stepWait?: () => Promise<void>
    /** `$.clock.now` answers with this instead of the mock clock's time (the waits stay the mock clock's). */
    now?: () => number
    /** Hooks beneath `$.session.start` and `$.agent.register`, so a test can start the session and register the agents. */
    register?: boolean
    twinFail?: (name: string) => boolean
    /** `$.agent.list()` rejects. */
    listFail?: boolean
  } = {},
) {
  const seen: Seen = { fetches: [], statusLine: [], commands: [], registered: [], spawned: [], steps: [], notices: [], logs: [], writes: [], transcript: [], settingsReads: 0, helper: [] }
  const flags = { settingsFail: opts.settingsFail === true, registerFail: false }
  // `mock.clock` registers `clock.now` itself and the engine refuses a second one, so a test's own is registered instead.
  const now = opts.now
  const clock = mock.clock(now ? (((name: string, ...rest: unknown[]) => (name === 'clock.now' ? undefined : (on as (...a: unknown[]) => unknown)(name, ...rest))) as unknown as On) : on)
  if (now) on('clock.now', () => ({ value: now() }))
  mock.env(on, { HOME, ...opts.env })
  on('session.cwd', async () => ({ value: opts.cwd ?? ROOT }))
  on('session.root', async () => ({ value: opts.root ?? opts.cwd ?? ROOT }))
  on('settings.read', async (_$, e) => {
    seen.settingsReads++
    if (flags.settingsFail) throw new Error('settings unreadable')
    return {
      value: (e.source === 'project' ? opts.project : e.source === 'local' ? opts.local : undefined) ?? {},
    } as never
  })
  on('fs.stat', (_$, e) => ({ value: hudStat(e.path, opts.files) }) as never)
  on('fs.exists', (_$, e) => ({ value: hudExists(e.path, opts.files) }) as never)
  on('fs.read', async (_$, e) => {
    const text = opts.files?.[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_$, e) => {
    if (opts.writeFail) throw new Error('EACCES')
    if (opts.writeHang) return new Promise<never>(() => {})
    seen.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  fakeFetch(on, opts.reply ?? (async () => ok(answer(2.1))), seen.fetches, {
    calls: seen.helper,
    replies: opts.helper ?? (async () => { throw new Error('connect ENOENT') }),
  })
  if (opts.register) {
    on('agent.register', (_$, e) => {
      if (e.name.endsWith('-codex') && (flags.registerFail || opts.twinFail?.(e.name))) throw new Error('refused')
      seen.registered.push({ name: e.name, model: e.model, description: e.description })
      return { value: { agent: `crew:${e.name}` } }
    })
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('ui.status', (_$, e) => (seen.statusLine.push(e.text), { value: undefined }))
    on('command.register', (_$, e) => (seen.commands.push(e.name), { value: { command: e.name } }))
  }
  on('agent.list', async () => {
    if (opts.listFail) throw new Error('list unavailable')
    return { value: opts.agents ?? [] } as never
  })
  on('agent.spawn', async (_$, e) => {
    seen.spawned.push({ ...e })
    return opts.spawn ? opts.spawn({ ...e }) : { model: String(e.model ?? 'default'), agentId: 'a1' }
  })
  on('turn.step', async function* (_$, e) {
    seen.steps.push(e.effort)
    await opts.stepWait?.()
    const model = typeof opts.stepModel === 'function' ? opts.stepModel() : opts.stepModel
    const usage = model ? { model } : null
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage } as never
  })
  on('ui.notice', async (_$, e) => { seen.notices.push(String(e.text)); return { value: undefined } })
  on('ui.log', async (_$, e) => {
    seen.logs.push(e.text)
    if (e.to === 'transcript') seen.transcript.push(e.text)
    return { value: undefined }
  })
  return { seen, clock, flags }
}

export const spawnInput = (over: Record<string, unknown> = {}) => ({
  tool_use_id: 'tu1',
  prompt: 'Audit the auth token refresh flow for race conditions.',
  description: 'audit auth',
  subagentType: 'crew:digger',
  provider: { plugin: 'crew', tier: 'user' },
  parentModel: 'opus',
  background: false,
  fork: false,
  ...over,
}) as never

/** `effort: null` is a model without effort: the field is absent. */
export const step = async ($: Engine, agentId?: string, effort: string | null = 'high', model: string | null = 'sonnet') => {
  const stream = $.turn.step({
    turnId: 't1', index: 0, ...(model === null ? {} : { model }), messageCount: 1,
    ...(effort === null ? {} : { effort }), ...(agentId ? { agentId } : {}),
  } as never)
  let item = await stream.next()
  while (!item.done) item = await stream.next()
  return item.value
}

const timers = globalThis as unknown as { setTimeout: (run: () => void, ms: number) => unknown }
export const pause = () => new Promise<void>(resolve => timers.setTimeout(resolve, 0))
/** The first plan read runs behind `session.start`: let it and the writes it makes settle. */
export const flush = async () => { for (let i = 0; i < 10; i++) await pause() }

// --- Prompt composition ---

export const compose = ($: Engine, tools: string[], traits: string[] = []) =>
  $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools, outputStyle: null, traits } as never)

// --- Assertions on what the world saw ---

/** The `i`-th decision record the plugin wrote. */
export const record = (seen: Seen, i = 0) => JSON.parse(seen.writes[i]?.text ?? '{}') as Record<string, unknown>
export const notRouted = (seen: Seen) => seen.logs.filter(line => line.includes('not routed'))

// --- Gateway ---

export const GATEWAY = { ANTHROPIC_BASE_URL: 'https://ai.example.ts.net' }

/** `jevWorld` with the session started behind a gateway, so the twins are registered and routable. */
export async function twinWorld($: Engine, on: On, opts: Parameters<typeof jevWorld>[1] = {}) {
  const world = jevWorld(on, { env: GATEWAY, register: true, ...opts })
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as never)
  return world
}

// --- Order tracing ---

/** Wraps `on` so the host calls that matter are recorded in the order they reach the host. */
export function traced(on: On, timeline: string[]): On {
  const mark: Record<string, (e: Record<string, unknown>) => string> = {
    'http.fetch': () => 'fetch',
    'agent.spawn': () => 'spawn',
    'fs.write': () => 'write',
    'ui.notice': e => `notice ${String(e.text)}`,
    'ui.log': e => `log ${String(e.text)}`,
  }
  const record = (event: string, hook: (host: unknown, e: Record<string, unknown>) => unknown) =>
    (host: unknown, e: Record<string, unknown>) => {
      timeline.push(mark[event]?.(e) ?? event)
      return hook(host, e)
    }
  return ((event: string, ...rest: unknown[]) => {
    const hook = rest[rest.length - 1]
    if (event in mark && typeof hook === 'function') {
      rest[rest.length - 1] = record(event, hook as (host: unknown, e: Record<string, unknown>) => unknown)
    }
    return (on as unknown as (...args: unknown[]) => unknown)(event, ...rest)
  }) as unknown as On
}

/** The timeline with the measured duration of a debug line made constant. */
export const shape = (timeline: string[]) => timeline.map(entry => entry.replace(/ \d+ms$/, ' Nms'))

// --- HUD ---

export function hudStat(path: string, files?: Record<string, string>) {
  if (path === ROOT || path === `${ROOT}/.crew/plans`) return { kind: 'dir', isLink: false, realPath: path, size: 0, mtimeMs: 0 }
  if (files?.[path] !== undefined) return { kind: 'file', isLink: false, realPath: path, size: 1, mtimeMs: 0 }
  throw new Error('ENOENT')
}
/** What the `hudStat` fake has: the plans directory and the files a test names. */
export function hudExists(path: string, files?: Record<string, string>): boolean {
  return path === ROOT || path === `${ROOT}/.crew/plans` || files?.[path] !== undefined
}
export function hudCapture(on: On) {
  const values: Record<string, unknown> = {}
  on('state.set', (_$, e, next) => { values[e.key] = e.value; return next(e) })
  return values
}
export const hudBand = (surface: 'terminal' | 'desktop' = 'terminal', hasSurvey = false) => ({
  plugin: 'crew', component: 'AbovePrompt', surface,
  props: { hasSurvey, isWorking: false, maxRows: 20, bodyColumns: 60, scroll: { offset: 0, bodyRows: 20 }, view: {} },
}) as never

export const hudPane = (columns = 100, rows = 30) => ({
  plugin: 'crew', component: 'Pane', requestId: 'crew-hud', surface: 'terminal',
  viewport: { columns, rows }, props: { bodyColumns: columns },
}) as never

export const hudText = '## Steps\n### Delivery\n- T1 (crew:digger, after: —) private task — state: implementing'
