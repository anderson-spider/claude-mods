import { test, expect } from 'claude-code/testing'
import { ALLOW_THRESHOLD, DENY_THRESHOLD, decide as decision, rulesVerdict, type EditContext, type Fetch, type Timer } from '../hooks/decisions'

const testTimer: Timer = (ms, fn) => { const id = setTimeout(fn, ms); return () => clearTimeout(id) }
const decide = (fetch: Fetch, key: string | undefined, ctx: EditContext, opts: { timer?: Timer; timeoutMs?: number } = {}) =>
  decision(fetch, key, ctx, { timer: testTimer, ...opts })

const ctx: EditContext = { tool: 'Edit', path: 'src/user.ts', ext: '.ts', linesAdded: 1, linesRemoved: 0, files: 1 }
const response = (text: string, status = 200): Fetch => async () => ({ status, ok: status === 200, text })
const scored = (score: unknown) => response(JSON.stringify({ answers: { trivial: { noul: score } } }))

for (const path of ['package.json', 'plugin.json', 'marketplace.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'Cargo.lock']) {
  test(`no key asks for a one-line manifest or lockfile edit: ${path}`, async () => {
    let fetched = false
    const verdict = await decide(async () => { fetched = true; throw new Error('unexpected fetch') }, undefined, { ...ctx, path, linesAdded: 1, linesRemoved: 0 })
    expect(verdict).toMatchObject({ action: 'ask', source: 'rules' })
    expect(fetched).toBe(false)
  })
}

test('injected deadline fires and its cancellation runs', async () => {
  let fire: () => void = () => {}
  let cancelled = false
  const pending = decide(() => new Promise(() => {}), 'key', ctx, { timer: (_ms: number, fn: () => void) => { fire = fn; return () => { cancelled = true } } } as never)
  fire()
  expect((await pending).reason).toContain('timed out')
  expect(cancelled).toBe(true)
})

test('success cancels the injected deadline without global timers', async () => {
  const saved = globalThis.setTimeout
  let cancelled = false
  try {
    globalThis.setTimeout = undefined as never
    const result = await decide(scored(0), 'key', ctx, { timer: () => () => { cancelled = true } } as never)
    expect(result).toMatchObject({ action: 'deny', source: 'jev' })
    expect(cancelled).toBe(true)
  } finally { globalThis.setTimeout = saved }
})

test('exports the fixed score thresholds', () => {
  expect(ALLOW_THRESHOLD).toBe(0.85)
  expect(DENY_THRESHOLD).toBe(0.30)
})

for (const [score, action] of [[1, 'allow'], [0.85, 'allow'], [0.8499, 'ask'], [0.5, 'ask'], [0.3001, 'ask'], [0.30, 'deny'], [0, 'deny']] as const) {
  test(`Jev score ${score} yields ${action}`, async () => {
    expect(await decide(scored(score), 'key', ctx)).toMatchObject({ action, source: 'jev', score })
  })
}

for (const body of ['not json', '{}', 'null', '{"answers":{"trivial":{"noul":"0.9"}}}', '{"answers":{"trivial":{"noul":null}}}']) {
  test(`malformed response falls back: ${body}`, async () => {
    const verdict = await decide(response(body), 'key', ctx)
    expect(verdict).toMatchObject({ action: 'allow', source: 'rules' })
    expect(verdict.reason).toContain('Malformed')
  })
}

for (const score of [-0.01, 1.01]) {
  test(`out-of-range score ${score} falls back`, async () => {
    const verdict = await decide(scored(score), 'key', ctx)
    expect(verdict.source).toBe('rules')
    expect(verdict.reason).toContain('Malformed')
  })
}

test('non-200 falls back even with a valid score body', async () => {
  const verdict = await decide(response('{"answers":{"trivial":{"noul":0}}}', 201), 'key', ctx)
  expect(verdict).toMatchObject({ action: 'allow', source: 'rules' })
  expect(verdict.reason).toContain('HTTP 201')
})

test('thrown fetch falls back without exposing the error payload', async () => {
  const verdict = await decide(() => { throw new Error('secret payload') }, 'key', ctx)
  expect(verdict).toMatchObject({ action: 'allow', source: 'rules' })
  expect(verdict.reason).toContain('failed')
  expect(verdict.reason).not.toContain('secret payload')
})

test('timeout bounds a fetch that never resolves', async () => {
  const verdict = await decide(() => new Promise(() => {}), 'key', ctx, { timeoutMs: 5 })
  expect(verdict).toMatchObject({ action: 'allow', source: 'rules' })
  expect(verdict.reason).toContain('timed out')
})

test('missing key never calls fetch', async () => {
  let calls = 0
  const fetch: Fetch = async () => { calls++; return { status: 200, ok: true, text: '{}' } }
  const verdict = await decide(fetch, undefined, ctx)
  expect(calls).toBe(0)
  expect(verdict.source).toBe('rules')
  expect(verdict.reason).toContain('key')
})

test('request explicitly selects metadata and sends the exact question', async () => {
  let seen: { url: string; init: Parameters<Fetch>[1] } | undefined
  const fetch: Fetch = async (url, init) => { seen = { url, init }; return { status: 200, ok: true, text: '{"answers":{"trivial":{"noul":1}}}' } }
  const input = { ...ctx, content: 'private', old_string: 'before', new_string: 'after' }
  await decide(fetch, 'key', input)
  expect(seen?.url).toBe('https://openrouter.ai/api/alpha/decisions')
  expect(seen?.init.method).toBe('POST')
  expect(seen?.init.headers).toEqual({ Authorization: 'Bearer key', 'Content-Type': 'application/json' })
  const body = JSON.parse(seen!.init.body!)
  expect(body).toEqual({
    model: 'typesafe/jev-1.13',
    state: { tool: 'Edit', kind: 'source', ext: 'ts', linesAdded: 1, linesRemoved: 0, files: 1, caller: 'main lead session' },
    questions: { trivial: {
      type: 'noul',
      instructions: 'Is this code edit small and trivial enough for the lead to apply directly, without delegating to a specialist?',
      criteria: {
        true: 'Tiny, mechanical, single-file change such as a typo, a one-line fix or a doc tweak.',
        false: 'Substantial, risky or multi-file change that should be delegated to developer (code) or ux (visual work).',
      },
    } },
  })
  expect(seen!.init.body).not.toMatch(/content|old_string|new_string|private/)
})

test('hostile path and extension never appear anywhere in the request', async () => {
  let body = ''
  await decide(async (_url, init) => { body = init.body!; return { status: 200, ok: true, text: '{"answers":{"trivial":{"noul":0}}}' } }, 'key', {
    ...ctx, path: '/repo/CONFIDENTIAL-PATH.note.SECRET-EXT', ext: '.SECRET-EXT',
  })
  expect(body).not.toContain('CONFIDENTIAL-PATH')
  expect(body).not.toContain('SECRET-EXT')
  expect(JSON.parse(body).state).toMatchObject({ kind: 'other', ext: 'other' })
})

for (const [path, ext, kind] of [
  ['docs/readme.md', '.md', 'docs'], ['tests/a.test.ts', '.ts', 'test'], ['src/a.ts', '.ts', 'source'],
  ['src/a.tsx', '.tsx', 'ui'], ['config/app.toml', '.toml', 'config'], ['.github/workflows/ci.yml', '.yml', 'workflow'],
  ['db/migrations/001.sql', '.sql', 'migration'], ['package.json', '.json', 'manifest'], ['yarn.lock', '.lock', 'lockfile'], ['photo.png', '.png', 'other'],
]) {
  test(`request derives closed kind ${kind}`, async () => {
    let body = ''
    await decide(async (_url, init) => { body = init.body!; return { status: 200, ok: true, text: '{}' } }, 'key', { ...ctx, path, ext })
    expect(JSON.parse(body).state.kind).toBe(kind)
    expect(body).not.toContain(path)
  })
}

const battery: [string, Partial<EditContext>, string][] = [
  ['README typo', { path: 'README.md', ext: '.md' }, 'allow'],
  ['one-line bugfix', {}, 'allow'],
  ['doc paragraph', { path: 'AGENTS.md', ext: '.md', linesAdded: 8 }, 'allow'],
  ['tests update', { path: 'tests/user.test.ts', files: 2, linesAdded: 40 }, 'ask'],
  ['CI workflow', { path: '.github/workflows/ci.yml', ext: '.yml', linesAdded: 12 }, 'ask'],
  ['DB migration', { path: 'db/migrations/0042_users.sql', ext: '.sql', linesAdded: 30 }, 'ask'],
  ['new module', { files: 3, linesAdded: 220 }, 'deny'],
  ['rename across codebase', { files: 14, linesAdded: 60 }, 'deny'],
  ['sed across files', { tool: 'Bash', files: 25, linesAdded: undefined, linesRemoved: undefined }, 'deny'],
  ['core class refactor', { files: 5, linesAdded: 180 }, 'deny'],
]
for (const [name, input, action] of battery) {
  test(`local rules: ${name}`, () => {
    expect(rulesVerdict({ ...ctx, ...input })).toMatchObject({ action, source: 'rules' })
  })
}

for (const path of ['.github/workflows/ci.yml', 'db/migrate/42.sql', 'migrations/42.sql', 'package.json', 'nested/plugin.json', '.claude-plugin/marketplace.json', 'deps.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'Cargo.lock']) {
  test(`sensitive path asks even for one changed line: ${path}`, () => {
    expect(rulesVerdict({ ...ctx, path }).action).toBe('ask')
  })
}

test('local rules count added and removed lines and preserve unknowns', () => {
  expect(rulesVerdict({ ...ctx, linesAdded: 3, linesRemoved: 2 }).action).toBe('allow')
  expect(rulesVerdict({ ...ctx, linesAdded: 3, linesRemoved: 3 }).action).toBe('ask')
  expect(rulesVerdict({ ...ctx, linesRemoved: undefined }).action).toBe('ask')
  expect(rulesVerdict({ ...ctx, files: 3, linesAdded: 50, linesRemoved: 50 }).action).toBe('ask')
  expect(rulesVerdict({ ...ctx, files: 3, linesAdded: 51, linesRemoved: 50 }).action).toBe('deny')
  for (const ext of ['.md', '.mdx', '.txt', '.rst']) {
    expect(rulesVerdict({ ...ctx, ext, linesAdded: 20 }).action).toBe('allow')
    expect(rulesVerdict({ ...ctx, ext, linesAdded: 21 }).action).toBe('ask')
    expect(rulesVerdict({ ...ctx, ext, files: 4, linesAdded: 1 }).action).toBe('deny')
  }
})

test('deny reasons point to developer, and the question names ux for visual work', async () => {
  expect(rulesVerdict({ ...ctx, linesAdded: 400, linesRemoved: 0 }).reason).toBe('Large or multi-file change; delegate to developer.')
  expect(rulesVerdict({ ...ctx, files: 5 }).reason).toBe('Large or multi-file change; delegate to developer.')
  const low = await decide(scored(0.1), 'k', { ...ctx, path: 'src/App.css', ext: '.css' })
  expect(low.reason).toBe('Jev classified this edit as substantial; delegate to developer.')
})
