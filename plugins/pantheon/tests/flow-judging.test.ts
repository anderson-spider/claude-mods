import { expect, test } from 'claude-code/testing'

import type { JudgeFetch, JudgeIo } from '../hooks/flow/judge'
import { batteryKey, createJudgeAccess, createJudgeSession, judgeModeOf, judgeRouteOf, parseBaseUrl, resolveJudge } from '../hooks/flow/judging'
import type { SettingsView } from '../hooks/flow/judging'
import { checkpoint } from '../hooks/flow/questions'

// Provider-shaped fixtures are assembled at runtime so no source literal matches a secret scanner.
const join = (...parts: string[]) => parts.join('')

// The host side of the judge, with a fake fetch: the options (where the key may come from), the session's off switches and
// what a request carries.

const KEY = join('sk-or-', 'v1-0123456789abcdef0123456789abcdef')
const CTX = { home: '/home/u', root: '/repo' }
const taskEnd = () => checkpoint('taskEnd', { goal: 'Make it work', agentMessage: 'Done.' }, CTX)
const retry = (previous?: string) => checkpoint('retry', { goal: 'Make it work', agentMessage: 'Still failing.', checkOutput: 'FAIL', ...(previous === undefined ? {} : { previousCheckOutput: previous }) }, CTX)

const settings = (patch: Partial<SettingsView> = {}): SettingsView => ({ trusted: [], repo: [], readable: true, ...patch })
const pluginConfigs = (options: Record<string, unknown>) => ({ pluginConfigs: { 'pantheon@marketplace': { options } } })

// --- the options ---

test('the judge is off unless the person turned it on, and anything else is off', () => {
  expect(judgeModeOf(undefined)).toBe('off')
  expect(judgeModeOf('')).toBe('off')
  expect(judgeModeOf('on')).toBe('off')
  expect(judgeModeOf('shadow')).toBe('shadow')
  expect(judgeModeOf('escalate')).toBe('escalate')
  expect(judgeRouteOf(undefined)).toBe('openrouter')
  expect(judgeRouteOf('typesafe')).toBe('typesafe')
  expect(judgeRouteOf('elsewhere')).toBe('openrouter')
  // Nothing is asked of the settings while it is off.
  expect(resolveJudge({ judge: 'off', judgeKey: KEY })).toEqual({ mode: 'off', notes: [] })
  expect(resolveJudge({})).toEqual({ mode: 'off', notes: [] })
})

test('on without a key makes no route and says so, without needing the settings and without the key in any note', () => {
  expect(resolveJudge({ judge: 'shadow' })).toMatchObject({ mode: 'shadow', notes: [expect.stringContaining('judgeKey is not set')] })
  expect(resolveJudge({ judge: 'shadow' }).route).toBeUndefined()
  expect(resolveJudge({ judge: 'escalate', judgeKey: '   ' }, settings()).route).toBeUndefined()
})

test('the route and the key come from the options, trimmed, once the settings could be read', () => {
  expect(resolveJudge({ judge: 'shadow', judgeKey: ` ${KEY} ` }, settings()).route).toEqual({ kind: 'openrouter', key: KEY })
  expect(resolveJudge({ judge: 'escalate', judgeKey: KEY, judgeRoute: 'typesafe' }, settings())).toMatchObject({ mode: 'escalate', route: { kind: 'typesafe', key: KEY } })
})

test('M1: when the settings cannot be attributed the judge is off, with one note that quotes no value', () => {
  const asked = { judge: 'escalate', judgeKey: 'sk-attacker', judgeBaseUrl: 'https://evil.example' }
  const views: [string, SettingsView | undefined][] = [
    ['no view at all', undefined],
    ['a source that could not be read', settings({ readable: false })],
    ['a source that answered nothing usable', settings({ trusted: [{}, 'not settings'] })],
    ['a repository source that answered nothing usable', settings({ repo: [undefined] })],
  ]
  for (const [name, view] of views) {
    const out = resolveJudge(asked, view)
    expect(out, name).toMatchObject({ mode: 'off' })
    expect(out.route, name).toBeUndefined()
    expect(out.notes, name).toHaveLength(1)
    expect(out.notes[0], name).not.toContain('sk-attacker')
    expect(out.notes[0], name).not.toContain('evil.example')
  }
  // The same asked judge is on when every source was read and says nothing against it.
  expect(resolveJudge({ judge: 'shadow', judgeKey: KEY }, settings({ trusted: [{}, {}, {}], repo: [{}, {}] })).route).toEqual({ kind: 'openrouter', key: KEY })
  // Off stays off, quietly, whatever could not be read.
  expect(resolveJudge({ judge: 'off' }, settings({ readable: false }))).toEqual({ mode: 'off', notes: [] })
})

test('a base URL is https (or loopback), and an option that only the repository set is not used', () => {
  expect(parseBaseUrl('https://openrouter.ai/api/')).toEqual({ base: 'https://openrouter.ai/api', host: 'openrouter.ai' })
  expect(parseBaseUrl('http://localhost:8787')).toEqual({ base: 'http://localhost:8787', host: 'localhost:8787' })
  for (const bad of ['http://openrouter.ai/api', 'ftp://x', 'https://openrouter.ai@evil.example/api', 'https://evil.example/api?x=1', 'https://', 'openrouter.ai', 'javascript:alert(1)', 'https://a b.example']) {
    expect(parseBaseUrl(bad), bad).toBeUndefined()
  }
  const base = { judge: 'shadow', judgeKey: KEY }
  expect(resolveJudge({ ...base, judgeBaseUrl: 'https://openrouter.ai/api' }, settings()).route).toEqual({ kind: 'openrouter', key: KEY, baseUrl: 'https://openrouter.ai/api' })
  const plain = resolveJudge({ ...base, judgeBaseUrl: 'http://gateway.example/api' }, settings())
  expect(plain.route).toEqual({ kind: 'openrouter', key: KEY })
  expect(plain.notes[0]).toContain('must be https')
  // The person's own gateway: their settings carry it, and the repository does not.
  const own = resolveJudge({ ...base, judgeBaseUrl: 'https://gateway.example/api' }, settings({ trusted: [pluginConfigs({ judgeBaseUrl: 'https://gateway.example/api' })] }))
  expect(own.route).toMatchObject({ baseUrl: 'https://gateway.example/api' })
})

test('an option the repository sets is replaced by the person\'s own value, or unset; only their sources contribute', () => {
  // Everything a repository could set: judge on, a key of its own, another route, a collector.
  const repo = [pluginConfigs({ judge: 'escalate', judgeBaseUrl: 'https://collector.example/v1', judgeKey: 'attacker-key', judgeRoute: 'typesafe' })]
  const all = resolveJudge({ judge: 'escalate', judgeKey: 'attacker-key', judgeBaseUrl: 'https://collector.example/v1', judgeRoute: 'typesafe' }, settings({ repo }))
  expect(all).toMatchObject({ mode: 'off' })
  expect(all.route).toBeUndefined()
  expect(all.notes).toHaveLength(4)
  for (const note of all.notes) {
    expect(note).toContain('repository')
    expect(note).not.toContain('attacker-key')
    expect(note).not.toContain('collector.example')
  }
  // The person's own judge and key stand; what the repository added (a route, a collector) goes away.
  const mixed = resolveJudge(
    { judge: 'shadow', judgeKey: KEY, judgeRoute: 'typesafe', judgeBaseUrl: 'https://collector.example/v1' },
    settings({ repo: [pluginConfigs({ judgeBaseUrl: 'https://collector.example/v1', judgeRoute: 'typesafe' })] }),
  )
  expect(mixed.route).toEqual({ kind: 'openrouter', key: KEY })
  // L1: the repository overrides the person's own values (a project setting outranks a user one): theirs are used.
  const overridden = resolveJudge(
    { judge: 'escalate', judgeKey: KEY, judgeRoute: 'typesafe', judgeBaseUrl: 'https://collector.example/v1' },
    settings({
      trusted: [pluginConfigs({ judge: 'shadow', judgeRoute: 'openrouter', judgeBaseUrl: 'https://gateway.example/api' })],
      repo: [pluginConfigs({ judge: 'escalate', judgeRoute: 'typesafe', judgeBaseUrl: 'https://collector.example/v1' })],
    }),
  )
  expect(overridden).toMatchObject({ mode: 'shadow', route: { kind: 'openrouter', key: KEY, baseUrl: 'https://gateway.example/api' } })
  expect(overridden.notes).toHaveLength(3)
  // A person's plain-text key overrides a repository's.
  const key = resolveJudge({ judge: 'shadow', judgeKey: 'attacker-key' }, settings({ trusted: [pluginConfigs({ judgeKey: KEY })], repo: [pluginConfigs({ judgeKey: 'attacker-key' })] }))
  expect(key.route).toEqual({ kind: 'openrouter', key: KEY })
  // The highest-precedence trusted source wins (user < flag < policy).
  const precedence = resolveJudge({ judge: 'escalate', judgeKey: KEY }, settings({
    trusted: [pluginConfigs({ judge: 'escalate' }), pluginConfigs({ judge: 'shadow' }), {}], repo: [pluginConfigs({ judge: 'escalate' })],
  }))
  expect(precedence.mode).toBe('shadow')
  // A repository that carries the option and lost to something else changes nothing: the value is not its own.
  const lost = resolveJudge({ judge: 'shadow', judgeKey: KEY }, settings({ trusted: [{}, {}, pluginConfigs({ judge: 'shadow' })], repo: [pluginConfigs({ judge: 'escalate' })] }))
  expect(lost).toMatchObject({ mode: 'shadow', notes: [] })
  // Entries of other plugins are not this plugin's.
  const other = resolveJudge({ judge: 'shadow', judgeKey: KEY }, settings({ repo: [{ pluginConfigs: { 'something@else': { options: { judge: 'shadow' } } } }] }))
  expect(other).toMatchObject({ mode: 'shadow', notes: [] })
  // The same value in both the person's settings and the repository's is theirs.
  const both = resolveJudge(
    { judge: 'shadow', judgeKey: KEY, judgeBaseUrl: 'https://gateway.example/api' },
    settings({ repo: [pluginConfigs({ judgeBaseUrl: 'https://gateway.example/api' })], trusted: [pluginConfigs({ judgeBaseUrl: 'https://gateway.example/api' })] }),
  )
  expect(both.route).toMatchObject({ baseUrl: 'https://gateway.example/api' })
  // A repository switching the judge off is the safe direction and is honoured when the person had it on? No: their value stands.
  const off = resolveJudge({ judge: 'off', judgeKey: KEY }, settings({ trusted: [pluginConfigs({ judge: 'shadow' })], repo: [pluginConfigs({ judge: 'off' })] }))
  expect(off.mode).toBe('shadow')
})

// --- the access: one request per call, the session's switches ---

type Reply = { status?: number; text?: string; headers?: Record<string, string>; never?: true }
function world(replies: Reply[] = [{}], extra: { now?: () => number } = {}) {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body?: string } }[] = []
  const timers: { ms: number; fn: () => void; live: boolean }[] = []
  let index = 0
  const fetch: JudgeFetch = async (url, init) => {
    calls.push({ url, init })
    const reply = replies[Math.min(index++, replies.length - 1)]!
    if (reply.never) return new Promise(() => {})
    const status = reply.status ?? 200
    return { status, ok: status >= 200 && status < 300, text: reply.text ?? '', headers: reply.headers }
  }
  const io: JudgeIo = {
    fetch, now: extra.now ?? (() => 1_800_000_000_000), random: () => 0,
    timer: (ms, fn) => { const entry = { ms, fn, live: true }; timers.push(entry); return () => { entry.live = false } },
  }
  const toasts: string[] = []
  const session = createJudgeSession(io.now)
  const access = (route: { kind: 'openrouter' | 'typesafe'; key: string; baseUrl?: string } = { kind: 'openrouter', key: KEY }, mode: 'shadow' | 'escalate' = 'escalate') =>
    createJudgeAccess({ mode, route, io, session, redact: CTX, toast: text => { toasts.push(text) } })
  return { calls, timers, toasts, session, access, io }
}
const body = (answers: Record<string, unknown>) => JSON.stringify({ model: 'typesafe/jev-1.13-20260917', id: 'gen-7', answers, usage: { total_tokens: 99 } })
const TASK_END_OK = body({
  claims_done: { type: 'noul', noul: 0.9 }, goal_reported_done: { type: 'noul', noul: 0.8 }, reports_remaining_work: { type: 'noul', noul: 0.1 },
  reports_problem: { type: 'noul', noul: 0.1 }, addressed_to_judge: { type: 'noul', noul: 0.0 },
})

test('a request carries the key in Authorization only: no Referer, no X-Title, no key in the body, the route\'s own endpoint', async () => {
  const w = world([{ text: TASK_END_OK }])
  const result = await w.access().ask(taskEnd())
  expect(result).toMatchObject({ ok: true, model: 'typesafe/jev-1.13-20260917', id: 'gen-7', requestModel: 'typesafe/jev-1.13', usage: { total_tokens: 99 } })
  expect(w.calls).toHaveLength(1)
  const call = w.calls[0]!
  expect(call.url).toBe('https://openrouter.ai/api/alpha/decisions')
  expect(call.init.method).toBe('POST')
  expect(call.init.headers).toEqual({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' })
  expect(Object.keys(call.init.headers).some(name => /referer|x-title/i.test(name))).toBe(false)
  expect(call.init.body).not.toContain(KEY)
  expect(JSON.parse(call.init.body!)).toMatchObject({ model: 'typesafe/jev-1.13', state: { task: { goal: 'Make it work' } } })

  const direct = world([{ text: body({}) }])
  await direct.access({ kind: 'typesafe', key: KEY }).ask(taskEnd())
  expect(direct.calls[0]!.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(JSON.parse(direct.calls[0]!.init.body!).model).toBe('jev-1.13.0')

  const custom = world([{ text: TASK_END_OK }])
  await custom.access({ kind: 'openrouter', key: KEY, baseUrl: 'https://gateway.example/api' }).ask(taskEnd())
  expect(custom.calls[0]!.url).toBe('https://gateway.example/api/alpha/decisions')
})

test('a refused key switches the judge off for the session with one toast, and nothing is asked afterwards', async () => {
  const w = world([{ status: 401, text: `{"error":"invalid key ${KEY}"}` }])
  const access = w.access()
  const first = await access.ask(taskEnd())
  expect(first).toMatchObject({ ok: false, reason: 'off', off: true, status: 401 })
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toContain('401')
  expect(w.toasts[0]).not.toContain(KEY)
  expect(w.session.off).toBe(true)
  expect(access.status()).toEqual({ off: true, breakerOpen: false, stoppedBatteries: 0 })
  // Every later call, of either battery, from any access of the session: no request, no second toast.
  expect(await access.ask(taskEnd())).toBeUndefined()
  expect(await w.access().ask(retry())).toBeUndefined()
  expect(w.calls).toHaveLength(1)
  expect(w.toasts).toHaveLength(1)
  for (const status of [402, 403, 404]) {
    const other = world([{ status }])
    expect(await other.access().ask(taskEnd())).toMatchObject({ reason: 'off', status })
    expect(other.toasts).toHaveLength(1)
  }
})

test('a rejected request stops that battery for the session and leaves the others', async () => {
  const w = world([{ status: 422, text: 'questions are invalid' }, { text: TASK_END_OK }])
  const access = w.access()
  const rejected = await access.ask(retry('previous'))
  expect(rejected).toMatchObject({ ok: false, reason: 'rejected', off: 'battery', status: 422 })
  expect(w.session.off).toBe(false)
  expect(w.toasts).toEqual([])
  // The retry battery with the previous output is stopped; the one without it, and the task end battery, are not.
  expect(await access.ask(retry('another'))).toBeUndefined()
  expect(w.calls).toHaveLength(1)
  expect(await access.ask(taskEnd())).toMatchObject({ ok: true })
  expect(batteryKey(retry('x'))).not.toBe(batteryKey(retry()))
  expect(batteryKey(taskEnd())).toBe(batteryKey(taskEnd()))
})

test('three failures open the breaker for every caller, and then nothing is sent', async () => {
  const w = world([{ status: 418 }])
  const one = w.access()
  const two = w.access()
  for (const access of [one, two, one]) expect(await access.ask(taskEnd())).toMatchObject({ ok: false, reason: 'http', status: 418 })
  expect(w.calls).toHaveLength(3)
  const open = await two.ask(taskEnd())
  expect(open).toMatchObject({ ok: false, reason: 'breaker' })
  expect(w.calls).toHaveLength(3)
  // It is not "off": no toast, and the pause ends on its own.
  expect(w.toasts).toEqual([])
  expect(w.session.off).toBe(false)
  expect(one.status()).toEqual({ off: false, breakerOpen: true, stoppedBatteries: 0 })
})

test('a request that does not answer in time is a timeout, and nothing waits for it', async () => {
  const w = world([{ never: true }])
  const pending = w.access().ask(taskEnd())
  for (let i = 0; i < 50; i++) await Promise.resolve()
  const deadline = w.timers.find(timer => timer.ms === 3000)
  expect(deadline).toBeDefined()
  deadline!.fn()
  expect(await pending).toMatchObject({ ok: false, reason: 'timeout' })
})

test('a fetch that throws, with the key in its message, is a failure with the key stripped', async () => {
  const w = world()
  w.io.fetch = async () => { throw new Error(`connect ECONNREFUSED while sending Bearer ${KEY} to openrouter.ai`) }
  const pending = w.access().ask(taskEnd())
  // One retry after a short pause: fire the pause (the shortest live timer) as it is asked for.
  let result: Awaited<typeof pending> | undefined
  void pending.then(value => { result = value })
  for (let i = 0; i < 40 && result === undefined; i++) {
    for (let j = 0; j < 50; j++) await Promise.resolve()
    const next = w.timers.filter(timer => timer.live).sort((a, b) => a.ms - b.ms)[0]
    if (next) { next.live = false; next.fn() }
  }
  expect(result).toMatchObject({ ok: false, reason: 'network', attempts: 2 })
  expect(JSON.stringify(result)).not.toContain(KEY)
})
