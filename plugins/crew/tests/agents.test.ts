import { expect, test } from 'claude-code/testing'
import { CODEX_BASE_EFFORT, CODEX_TOOL, EFFORTS, EFFORT_FLOOR, MODELS, MODEL_FLOORS, SPECIALISTS, codexSection, isLoopbackBase, leadSection, nativeCodexSection, nativeCodexSpecs, offersCodex } from '../hooks/agents'
import { parseCodexModels } from '../hooks/codex/models'

const by = (name: string) => SPECIALISTS.find(s => s.name === name)

test('each specialist runs on its model', () => {
  expect(by('code-reader')?.model).toBe('haiku')
  expect(by('research')?.model).toBe('haiku')
  expect(by('developer')?.model).toBe('sonnet')
  expect(by('designer')?.model).toBe('sonnet')
  expect(by('tester')?.model).toBe('sonnet')
  expect(by('architect')?.model).toBe('opus')
})

test('code reader cannot write and architect cannot edit', () => {
  expect(by('code-reader')?.tools).not.toContain('Edit')
  expect(by('code-reader')?.tools).not.toContain('Write')
  expect(by('architect')?.tools).toContain('Write')
  expect(by('architect')?.tools).not.toContain('Edit')
})

test('designer can edit and browse, tester can run commands', () => {
  expect(by('designer')?.tools).toContain('Edit')
  expect(by('designer')?.tools).toContain('mcp__claude-in-chrome__navigate')
  expect(by('tester')?.tools).toContain('Bash')
})

test('effort is set on purpose: every specialist defaults to medium, which is also the floor', () => {
  for (const s of SPECIALISTS) expect(s.effort).toBe('medium')
  expect(EFFORT_FLOOR).toBe('medium')
})

test('names are unique', () => {
  const names = SPECIALISTS.map(s => s.name)
  expect(new Set(names).size).toBe(names.length)
})

test('routing floors name real agents and tiers, and the architect never routes below opus', () => {
  for (const [name, floor] of Object.entries(MODEL_FLOORS)) {
    expect(by(name)).toBeDefined()
    expect(MODELS).toContain(floor)
    expect(MODELS.indexOf(by(name)!.model)).toBeGreaterThanOrEqual(MODELS.indexOf(floor))
  }
  expect(MODEL_FLOORS.architect).toBe('opus')
})

test('every default sits on the model and effort scales routing moves along', () => {
  for (const s of SPECIALISTS) {
    expect(MODELS).toContain(s.model)
    expect(EFFORTS).toContain(s.effort)
    expect(EFFORTS.indexOf(s.effort)).toBeGreaterThanOrEqual(EFFORTS.indexOf(EFFORT_FLOOR))
  }
})

test('codexSection names the three Codex tools', () => {
  const text = codexSection(false)
  expect(text.length).toBeGreaterThan(0)
  for (const name of ['mcp__crew__codex', 'mcp__crew__codex_result', 'mcp__crew__codex_cancel']) {
    expect(text).toContain(name)
  }
})

test('CODEX_BASE_EFFORT is medium, apart from the agents\' own defaults', () => {
  expect(CODEX_BASE_EFFORT).toBe('medium')
  expect(EFFORTS).toContain(CODEX_BASE_EFFORT)
})

test('codexSection says whether Jev sizes the job, and is stable for each flag', () => {
  expect(codexSection(true)).toContain('Jev sizes each Codex job')
  expect(codexSection(true)).not.toContain('does not size')
  expect(codexSection(false)).not.toContain('Jev')
  expect(codexSection(false)).toContain('medium effort')
  expect(codexSection(true)).toBe(codexSection(true))
  expect(codexSection(true)).not.toBe(codexSection(false))
})

test('offersCodex is true only when the Codex tool is listed', () => {
  expect(offersCodex(['Agent', CODEX_TOOL])).toBe(true)
  expect(offersCodex(['Agent', 'mcp__crew__codex_result'])).toBe(false)
  expect(offersCodex([])).toBe(false)
})

test('leadSection does not carry the Codex text', () => {
  for (const jev of [true, false]) {
    expect(leadSection(jev)).not.toContain('codex')
    expect(leadSection(jev)).toBe(leadSection(jev))
  }
})

// --- The -codex twins ---

test('each -codex twin keeps its base role\'s prompt, tools and effort, on the model id, with a one-line description', () => {
  const models = Object.fromEntries(SPECIALISTS.map(s => [s.name, `gpt-${s.name}`]))
  const twins = nativeCodexSpecs(models)

  expect(twins.map(t => t.name)).toEqual(SPECIALISTS.map(s => `${s.name}-codex`))
  for (const twin of twins) {
    const base = by(twin.name.replace(/-codex$/, ''))!
    expect(twin.prompt).toBe(base.prompt)
    expect(twin.tools).toEqual(base.tools)
    expect(twin.effort).toBe(base.effort)
    expect(twin.model).toBe(`gpt-${base.name}`)
    expect(twin.description).toContain(twin.model)
    expect(twin.description).toContain(`crew:${base.name}`)
    expect(twin.description).not.toContain('\n')
  }
})

test('only the roles named get a twin, and SPECIALISTS keep their aliases', () => {
  const before = JSON.stringify(SPECIALISTS)
  expect(nativeCodexSpecs({ tester: 'gpt-x' }).map(t => t.name)).toEqual(['tester-codex'])
  expect(nativeCodexSpecs({})).toEqual([])
  expect(JSON.stringify(SPECIALISTS)).toBe(before)
  for (const s of SPECIALISTS) expect(MODELS).toContain(s.model)
})

test('the twins are built from the Codex engine\'s parser: its roles, its id check, its errors', () => {
  const parsed = parseCodexModels('developer=gpt-x, bogus=gpt-y, tester=-m, architect')
  expect(nativeCodexSpecs(parsed.models).map(t => [t.name, t.model])).toEqual([['developer-codex', 'gpt-x']])
  expect(parsed.errors.length).toBe(3)
})

test('isLoopbackBase accepts http on 127.0.0.0/8, ::1 and localhost only', () => {
  for (const url of ['http://127.0.0.1:8081', 'http://127.0.0.1', 'http://127.255.0.9:1/', 'http://127.1:9', 'http://[::1]:8081', 'http://localhost:8081', 'http://LOCALHOST', 'http://user@127.0.0.1:5']) {
    expect(isLoopbackBase(url)).toBe(true)
  }
  for (const url of [
    undefined, '', 'localhost', '127.0.0.1:8081', 'not a url', 'https://127.0.0.1:8081', 'https://localhost',
    'http://api.anthropic.com', 'http://128.0.0.1', 'http://10.0.0.1', 'http://0.0.0.0', 'http://[::2]:1', 'http://[::ffff:8.8.8.8]',
    'http://127.0.0.1.evil.com', 'http://localhost.evil.com', 'http://evil.com/127.0.0.1', 'http://127.0.0.1@evil.com', 'http://evil.com#@127.0.0.1',
    'http://127.0.0.256', 'ftp://127.0.0.1',
  ]) {
    expect(isLoopbackBase(url)).toBe(false)
  }
})

test('nativeCodexSection lists every twin with its model, is stable, and compares with the Codex tool only when it is offered', () => {
  const specs = nativeCodexSpecs({ developer: 'gpt-a', architect: 'gpt-b' })
  const text = nativeCodexSection(specs, false)

  expect(text).toContain('crew:developer-codex (gpt-a)')
  expect(text).toContain('crew:architect-codex (gpt-b)')
  expect(text).not.toContain('crew:tester-codex')
  expect(text).not.toContain('mcp__crew__codex')
  expect(text).toContain('never pass `model`')
  expect(nativeCodexSection(specs, true)).toContain('mcp__crew__codex')
  expect(nativeCodexSection(specs, true)).toContain(text.slice(0, 40))
  expect(nativeCodexSection(specs, false)).toBe(text)
})

// --- The loopback gate and the twins' shape ---

const LOOPBACK_URLS = [
  'http://127.0.0.1:41237', 'HTTP://127.0.0.1', 'http://127.255.255.255', 'http://[::1]:9', 'http://localhost', 'http://LOCALHOST:1',
  'http://user:pass@127.0.0.1:41237', 'http://evil.com@127.0.0.1', 'http://127.0.0.1:41237/v1', ' http://127.0.0.1 ',
  // Normalized by the URL parser to 127.0.0.1 or ::1, which is where a client would connect.
  'http://0x7f000001', 'http://127.1', 'http://2130706433', 'http://0177.0.0.1', 'http://[0:0:0:0:0:0:0:1]', 'http:127.0.0.1',
]
const OTHER_URLS = [
  'http://127.0.0.1.nip.io', 'http://[::ffff:127.0.0.1]', 'http://localhost.evil', 'http://localhost.', 'http://127.0.0.1@evil.com',
  'http://128.0.0.1', 'http://0.0.0.0', 'http://[::]', 'ws://127.0.0.1', 'https://127.0.0.1', 'http://sub.localhost',
  'http://10.0.0.1', 'localhost:41237', '127.0.0.1', '', undefined, 'http://', 'http://127.0.0.256', 'file:///127.0.0.1',
]

for (const url of LOOPBACK_URLS) test(`the gate accepts ${JSON.stringify(url)}`, () => expect(isLoopbackBase(url)).toBe(true))
for (const url of OTHER_URLS) test(`the gate refuses ${JSON.stringify(url)}`, () => expect(isLoopbackBase(url)).toBe(false))

test('a twin changes only name, model and description of its base, over a three-role option', () => {
  const twins = nativeCodexSpecs({ developer: 'gpt-6-astra', architect: 'gpt-6-sage', 'code-reader': 'gpt-6-mini' })
  expect(twins.map(t => t.name)).toEqual(['code-reader-codex', 'developer-codex', 'architect-codex'])
  for (const twin of twins) {
    const base = SPECIALISTS.find(s => `${s.name}-codex` === twin.name)!
    expect(twin.prompt).toBe(base.prompt)
    expect(twin.tools).toEqual(base.tools)
    expect(twin.effort).toBe(base.effort)
    expect(twin.description.includes('\n')).toBe(false)
  }
})


// --- The lead text ---

test('leadSection never names Codex in any case, for either Jev flag', () => {
  for (const jev of [true, false]) expect(leadSection(jev).toLowerCase()).not.toContain('codex')
})

test('the native section lists only the given twins, and not the Codex tool when it is not offered', () => {
  const text = nativeCodexSection(nativeCodexSpecs({ tester: 'gpt-6-astra' }), false)
  expect(text).toContain('crew:tester-codex (gpt-6-astra)')
  expect(text).not.toContain('crew:developer-codex')
  expect(text).not.toContain('mcp__crew__codex')
})
