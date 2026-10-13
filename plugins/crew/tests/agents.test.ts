import { expect, test } from 'claude-code/testing'
import { CREW_TYPES, EFFORTS, EFFORT_FLOOR, LANES, MODELS, SPECIALISTS, isGatewayBase, leadSection, nativeCodexSection, nativeCodexSpecs, specialistOf } from '../hooks/agents'

const by = (name: string) => SPECIALISTS.find(s => s.name === name)

test('each specialist runs on its model', () => {
  expect(by('code-reader')?.model).toBe('haiku')
  expect(by('research')?.model).toBe('haiku')
  expect(by('developer')?.model).toBe('sonnet')
  expect(by('designer')?.model).toBe('sonnet')
  expect(by('tester')).toBeUndefined()
  expect(SPECIALISTS).toHaveLength(5)
  expect(by('architect')?.model).toBe('opus')
})

test('code reader cannot write and architect cannot edit', () => {
  expect(by('code-reader')?.tools).not.toContain('Edit')
  expect(by('code-reader')?.tools).not.toContain('Write')
  expect(by('architect')?.tools).toContain('Write')
  expect(by('architect')?.tools).not.toContain('Edit')
})

test('designer can edit and browse, developer runs its own tests for the architect audit', () => {
  expect(by('designer')?.tools).toContain('Edit')
  expect(by('designer')?.tools).toContain('mcp__claude-in-chrome__navigate')
  expect(by('developer')?.tools).toContain('Bash')
  expect(by('developer')?.prompt).toContain('run the relevant tests yourself')
  expect(by('developer')?.prompt).toContain('the exact commands and their output')
  expect(by('architect')?.tools).toContain('Bash')
})

test('effort is set on purpose: every specialist defaults to medium, which is also the floor', () => {
  for (const s of SPECIALISTS) expect(s.effort).toBe('medium')
  expect(EFFORT_FLOOR).toBe('medium')
})

test('names are unique', () => {
  const names = SPECIALISTS.map(s => s.name)
  expect(new Set(names).size).toBe(names.length)
})

test('every default sits on the effort scales routing moves along', () => {
  for (const s of SPECIALISTS) {
    expect(MODELS).toContain(s.model)
    expect(EFFORTS).toContain(s.effort)
    expect(EFFORTS.indexOf(s.effort)).toBeGreaterThanOrEqual(EFFORTS.indexOf(EFFORT_FLOOR))
  }
})

test('research writes its findings as input for the lead before replying', () => {
  const prompt = by('research')?.prompt ?? ''
  expect(prompt).toContain('not a report but the input the lead reads')
})

test('the architect opens with a verdict word and the lead asks for the step id in descriptions', () => {
  const prompt = SPECIALISTS.find(s => s.name === 'architect')?.prompt ?? ''
  expect(prompt).toContain("not a report but the input the lead's review triage reads")
  expect(prompt).toContain('starts with `Approve`, `Fixes` or `Reject` and a one-line reason')
  for (const jev of [true, false]) expect(leadSection(jev)).toContain('start its description with the step id')
})

test('the lead updates plan step states immediately for the HUD with static wording', () => {
  const sentence = "Update each step's `state:` in the plan file as soon as it changes; the crew HUD reads it."
  for (const jev of [true, false]) {
    const text = leadSection(jev)
    expect(text).toContain(sentence)
    expect(text.split(sentence)).toHaveLength(2)
    expect(leadSection(jev)).toBe(text)
  }
})

test('failed steps return to the same developer and the PR opens only after an architect reaudit', () => {
  const specs = nativeCodexSpecs({ developer: 'gpt-a', architect: 'gpt-b' })
  for (const jev of [true, false]) {
    const lead = leadSection(jev)
    expect(lead).toContain("Before the PR opens, crew:architect independently audits the deliverable's full diff")
    expect(lead).toContain('only then do its steps become `verified`')
    expect(lead).toContain("the developer's own commands and output are never acceptance")
    expect(lead).toContain('Send failures to the developer who owns the step via SendMessage with the criterion and expected versus actual')
    expect(lead).toContain('after the fix, the architect reaudits before the PR opens')
  }
  const native = nativeCodexSection(specs)
  expect(native).toContain("Only crew:architect or its registered -codex twin independently accepts a deliverable's diff")
  expect(native).toContain("developer twin's own commands and output are its report, not acceptance")
  expect(native).toContain('same developer, including a -codex developer, then have the architect reaudit before the PR opens')
  expect(native).toContain('otherwise use the Claude role')
})

test('the lead delegates in waves, relaunches unblocked work unasked and ends updates with run/wait status', () => {
  for (const jev of [true, false]) {
    const lead = leadSection(jev)
    expect(lead).toContain('launch every independent piece with ready inputs in one message')
    expect(lead).toContain('separate files, no mutual dependencies')
    expect(lead).toContain('After each report, launch newly unblocked or independent work without being asked or waiting for unrelated agents')
    expect(lead).toContain('End each update with one line saying what runs, what waits and on what')
    expect(lead).toContain('nothing else can run in parallel')
  }
})

test('leadSection does not carry the Codex text', () => {
  for (const jev of [true, false]) {
    expect(leadSection(jev)).not.toContain('codex')
    expect(leadSection(jev)).toBe(leadSection(jev))
  }
})

// --- Lanes and crew types ---

test('each specialist declares its write lane: the architect writes crew documents, every other role is unrestricted', () => {
  expect(Object.keys(LANES)).toEqual(SPECIALISTS.map(s => s.name))
  expect(SPECIALISTS.map(s => [s.name, LANES[s.name]])).toEqual([
    ['code-reader', 'unrestricted'],
    ['research', 'unrestricted'],
    ['designer', 'unrestricted'],
    ['developer', 'unrestricted'],
    ['architect', 'crew-documents'],
  ])
})

test('CREW_TYPES lists each specialist and its -codex twin, and nothing else', () => {
  expect(CREW_TYPES).toEqual([
    'crew:code-reader', 'crew:code-reader-codex', 'crew:research', 'crew:research-codex', 'crew:designer', 'crew:designer-codex',
    'crew:developer', 'crew:developer-codex', 'crew:architect', 'crew:architect-codex',
  ])
  expect(CREW_TYPES).toEqual(SPECIALISTS.flatMap(s => [`crew:${s.name}`, `crew:${s.name}-codex`]))
})

test('specialistOf names the specialist of a role or of its twin, and no one for any other name', () => {
  for (const s of SPECIALISTS) {
    expect(specialistOf(s.name)).toBe(s)
    expect(specialistOf(`${s.name}-codex`)).toBe(s)
    expect(specialistOf(`${s.name}-codex-codex`)).toBeUndefined()
  }
  for (const role of ['tester', 'tester-codex', '-codex', '', 'Developer', 'crew:developer']) expect(specialistOf(role)).toBeUndefined()
})

test('a specialist and a twin hold the agent definition fields only: the lane is kept in LANES, out of what is registered', () => {
  const fields = ['description', 'effort', 'model', 'name', 'prompt', 'tools']
  for (const s of SPECIALISTS) expect(Object.keys(s).sort()).toEqual(fields)
  for (const twin of nativeCodexSpecs(Object.fromEntries(SPECIALISTS.map(s => [s.name, `gpt-${s.name}`])))) {
    expect(Object.keys(twin).sort()).toEqual(fields)
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
  expect(nativeCodexSpecs({ developer: 'gpt-x' }).map(t => t.name)).toEqual(['developer-codex'])
  expect(nativeCodexSpecs({ tester: 'gpt-x' })).toEqual([])
  expect(nativeCodexSpecs({})).toEqual([])
  expect(JSON.stringify(SPECIALISTS)).toBe(before)
  for (const s of SPECIALISTS) expect(MODELS).toContain(s.model)
})

test('isGatewayBase accepts any http or https base URL except Anthropic\'s API', () => {
  for (const url of ['https://ai.example.ts.net', 'http://127.0.0.1:8081', 'https://gateway.example.com/v1', 'HTTPS://GW.EXAMPLE']) {
    expect(isGatewayBase(url)).toBe(true)
  }
  for (const url of [undefined, '', 'gateway.example', 'not a url', 'ftp://gateway.example', 'https://api.anthropic.com', 'https://API.ANTHROPIC.COM/']) {
    expect(isGatewayBase(url)).toBe(false)
  }
})

test('nativeCodexSection lists every twin with its model, never names the Codex engine tools, and is stable', () => {
  const specs = nativeCodexSpecs({ developer: 'gpt-a', architect: 'gpt-b' })
  const text = nativeCodexSection(specs)

  expect(text).toContain('crew:developer-codex (gpt-a)')
  expect(text).toContain('crew:architect-codex (gpt-b)')
  expect(text).not.toContain('crew:tester-codex')
  expect(text).not.toContain('mcp__crew__codex')
  expect(text).toContain('never pass `model`')
  expect(nativeCodexSection(specs)).toBe(text)
})

// --- The twins' shape ---

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

test('the native section lists only the given twins and never names the Codex engine tools', () => {
  const text = nativeCodexSection(nativeCodexSpecs({ architect: 'gpt-6-astra' }))
  expect(text).toContain('crew:architect-codex (gpt-6-astra)')
  expect(text).not.toContain('crew:developer-codex')
  expect(text).not.toContain('mcp__crew__codex')
})

test('independent acceptance is the architect audit, not the developer self-check or a different family', () => {
  expect(SPECIALISTS.find(s => s.name === 'architect')?.prompt).toContain('your audit of the full diff is the acceptance')
  for (const jev of [true, false]) {
    const text = leadSection(jev)
    expect(text).toContain('crew:developer for implementation and tests')
    expect(text).toContain("Before the PR opens, crew:architect independently audits the deliverable's full diff")
    expect(text).toContain('the developer\'s own commands and output are never acceptance')
    expect(text).toContain('a single step gets an early audit only when the plan marks it `risky`')
    expect(text).toContain('after the fix, the architect reaudits before the PR opens')
    expect(text).toContain("Ask for a separate reproduction only for behavior that needs it (auth, routing, or live checks against the real host or service), not for every step: it comes from a fresh crew:developer, not the implementer, or from the project's live-test procedure, and it must pass before the PR opens.")
    expect(text).not.toContain('crew:tester')
  }
  const text = nativeCodexSection(nativeCodexSpecs({ developer: 'gpt-x', architect: 'gpt-y' }))
  expect(text).toContain("Only crew:architect or its registered -codex twin independently accepts a deliverable's diff")
  expect(text).toContain("a developer twin's own commands and output are its report, not acceptance")
  expect(text).toContain('same developer, including a -codex developer')
  expect(text).not.toContain('counts as someone other than the implementer')
})

// --- The crew mode ---

test('the lead section never names Codex, and the native section names the codex mode in one fixed sentence', () => {
  const specs = nativeCodexSpecs({ developer: 'gpt-a' })
  for (const jev of [true, false]) expect(leadSection(jev)).not.toMatch(/codex/i)
  const text = nativeCodexSection(specs)
  expect(text).toContain('In the codex crew mode, crew runs a plain crew:<role> call on its registered twin and the task shows it; passing `model` keeps a call on Claude.')
  expect(nativeCodexSection(specs)).toBe(text)
})

// Planning belongs to the lead; the architect accepts the implemented diff.
test('the lead delegates audits, not plans, to the architect', () => {
  for (const jev of [true, false]) {
    expect(leadSection(jev)).toContain('crew:architect for audits')
    expect(leadSection(jev)).not.toContain('crew:architect for plans')
  }
})
