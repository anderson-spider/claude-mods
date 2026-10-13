import { expect, test } from 'claude-code/testing'
import { CREW_TYPES, EFFORTS, EFFORT_FLOOR, MODELS, SPECIALISTS, isGatewayBase, mainSection, nativeCodexSection, nativeCodexSpecs, specialistOf } from '../hooks/agents'

const by = (name: string) => SPECIALISTS.find(s => s.name === name)

test('the three helpers run on their models at high effort: planner and challenger on Opus, digger on Haiku', () => {
  expect(SPECIALISTS.map(s => [s.name, s.model, s.effort])).toEqual([
    ['planner', 'opus', 'high'],
    ['challenger', 'opus', 'high'],
    ['digger', 'haiku', 'high'],
  ])
  expect(EFFORT_FLOOR).toBe('medium')
})

test('no removed role is registered: no developer, architect, auditor, QA, designer, research or code reader', () => {
  for (const name of ['developer', 'architect', 'auditor', 'qa', 'designer', 'research', 'code-reader', 'explorer']) {
    expect(by(name)).toBeUndefined()
    expect(CREW_TYPES).not.toContain(`crew:${name}`)
  }
})

test('every helper is read-only and cannot delegate: no Write, Edit, NotebookEdit or Agent', () => {
  for (const s of SPECIALISTS) {
    for (const tool of ['Write', 'Edit', 'NotebookEdit', 'Agent']) expect(s.tools).not.toContain(tool)
    expect(s.prompt).toContain('never edit files')
    expect(s.prompt).toContain('call other agents')
  }
})

test('planner and challenger only read the code; the digger also reads git, docs, the web and pages', () => {
  expect(by('planner')?.tools).toEqual(['Read', 'Grep', 'Glob'])
  expect(by('challenger')?.tools).toEqual(['Read', 'Grep', 'Glob'])
  const digger = by('digger')?.tools ?? []
  for (const tool of ['Read', 'Grep', 'Glob', 'Bash', 'WebSearch', 'WebFetch', 'mcp__claude_ai_Context7__query-docs', 'mcp__claude-in-chrome__get_page_text']) {
    expect(digger).toContain(tool)
  }
  // Pages are read, never clicked or typed into.
  expect(digger).not.toContain('mcp__claude-in-chrome__computer')
  expect(by('digger')?.prompt).toContain('Run only commands that change nothing')
})

test('each helper answers in its own shape: a plan, a challenge, evidence', () => {
  expect(by('planner')?.prompt).toContain('acceptance criteria')
  expect(by('planner')?.prompt).toContain('- T1 (main, after: —) <action and files> — state: queued')
  expect(by('challenger')?.prompt).toContain('say plainly when you find nothing significant')
  expect(by('challenger')?.prompt).toContain('approve routine work')
  expect(by('digger')?.prompt).toContain('marked confirmed or inferred')
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

test('the main session implements and delegation is optional, with no required review step', () => {
  for (const jev of [true, false]) {
    const text = mainSection(jev)
    expect(text).toContain('You are the main session: you implement, edit files, run commands and tests, review your own changes, commit and open pull requests.')
    expect(text).toContain('Simple and medium tasks need no subagent; every helper is optional and none is a required step.')
    expect(text).toContain('crew:planner to plan complex or ambiguous work')
    expect(text).toContain('(never a routine review)')
    expect(text).toContain('run several diggers at once only for independent questions')
    expect(text).toContain('to ask the same thing twice')
    for (const gone of ['crew:developer', 'crew:architect', 'crew:designer', 'crew:research', 'crew:code-reader', 'audit', 'ready for QA', 'verified']) {
      expect(text).not.toContain(gone)
    }
  }
})

test('the main section names the step id and updates plan step states immediately for the HUD with static wording', () => {
  const sentence = "Update each step's `state:` in the plan file as soon as it changes; the crew HUD reads it."
  for (const jev of [true, false]) {
    const text = mainSection(jev)
    expect(text).toContain('start its description with the step id')
    expect(text).toContain(sentence)
    expect(text.split(sentence)).toHaveLength(2)
    expect(mainSection(jev)).toBe(text)
  }
})

test('the Jev sentence is the only difference between the two main sections', () => {
  expect(mainSection(true)).toContain("Jev sizes each helper call's effort.")
  expect(mainSection(false)).toContain("Each helper runs on its role's model and effort.")
  expect(mainSection(true).replace("Jev sizes each helper call's effort.", "Each helper runs on its role's model and effort.")).toBe(mainSection(false))
})

// --- Crew types ---

test('CREW_TYPES lists each specialist and its -codex twin, and nothing else', () => {
  expect(CREW_TYPES).toEqual(['crew:planner', 'crew:planner-codex', 'crew:challenger', 'crew:challenger-codex', 'crew:digger', 'crew:digger-codex'])
  expect(CREW_TYPES).toEqual(SPECIALISTS.flatMap(s => [`crew:${s.name}`, `crew:${s.name}-codex`]))
})

test('specialistOf names the specialist of a role or of its twin, and no one for any other name', () => {
  for (const s of SPECIALISTS) {
    expect(specialistOf(s.name)).toBe(s)
    expect(specialistOf(`${s.name}-codex`)).toBe(s)
    expect(specialistOf(`${s.name}-codex-codex`)).toBeUndefined()
  }
  for (const role of ['developer', 'developer-codex', '-codex', '', 'Digger', 'crew:digger']) expect(specialistOf(role)).toBeUndefined()
})

test('a specialist and a twin hold the agent definition fields only', () => {
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
    expect(twin.description).toBe(`crew:${base.name} on ${twin.model} (OpenAI, through the session's gateway): same job, read-only.`)
  }
})

test('only the roles named get a twin, and SPECIALISTS keep their aliases', () => {
  const before = JSON.stringify(SPECIALISTS)
  expect(nativeCodexSpecs({ digger: 'gpt-x' }).map(t => t.name)).toEqual(['digger-codex'])
  expect(nativeCodexSpecs({ developer: 'gpt-x' })).toEqual([])
  expect(nativeCodexSpecs({})).toEqual([])
  expect(JSON.stringify(SPECIALISTS)).toBe(before)
})

test('isGatewayBase accepts any http or https base URL except Anthropic\'s API', () => {
  for (const url of ['https://ai.example.ts.net', 'http://127.0.0.1:8081', 'https://gateway.example.com/v1', 'HTTPS://GW.EXAMPLE']) {
    expect(isGatewayBase(url)).toBe(true)
  }
  for (const url of [undefined, '', 'gateway.example', 'not a url', 'ftp://gateway.example', 'https://api.anthropic.com', 'https://API.ANTHROPIC.COM/']) {
    expect(isGatewayBase(url)).toBe(false)
  }
})

test('nativeCodexSection lists only the given twins with their models, never names the Codex engine tools, and is stable', () => {
  const specs = nativeCodexSpecs({ planner: 'gpt-a', digger: 'gpt-b' })
  const text = nativeCodexSection(specs)

  expect(text).toContain('crew:planner-codex (gpt-a), crew:digger-codex (gpt-b)')
  expect(text).not.toContain('crew:challenger-codex')
  expect(text).not.toContain('mcp__crew__codex')
  expect(text).toContain('never pass `model`')
  expect(nativeCodexSection(specs)).toBe(text)
})

// --- The crew mode ---

test('the main section never names Codex, and the native section names the codex mode in one fixed sentence', () => {
  const specs = nativeCodexSpecs({ digger: 'gpt-a' })
  for (const jev of [true, false]) expect(mainSection(jev)).not.toMatch(/codex/i)
  const text = nativeCodexSection(specs)
  expect(text).toContain('In the codex crew mode, crew runs a plain crew:<role> call on its registered twin and the task shows it; passing `model` keeps a call on Claude.')
  expect(nativeCodexSection(specs)).toBe(text)
})
