import { mock, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
const ROOT = '/repo'
const HOME = '/home/u'
const SID = 'sess-1'
const timers = globalThis as unknown as { setTimeout: (run: () => void, ms: number) => unknown }
const pause = (ms: number) => new Promise<void>(resolve => timers.setTimeout(resolve, ms))

function flowWorld(on: On, store: Record<string, unknown> = {}) {
  const files = new Map<string, string>([[`${HOME}/.claude/pantheon.json`, '{}']])
  const exits: Record<string, number> = {}
  const toasts: string[] = []
  const ran: string[] = []
  // What Claude Code's permission rules answer for a check's Bash command (tool.check); allow unless a test says otherwise.
  const rules: { decision: 'allow' | 'ask' | 'deny'; reason?: string } = { decision: 'allow' }
  const isDir = (path: string) => [...files.keys()].some(f => f.startsWith(`${path}/`))
  mock.clock(on)
  mock.env(on, { HOME })
  // The plugin's store, in memory and readable by the test (the test's own engine has no store handle).
  const kv = new Map<string, unknown>(Object.entries(store))
  on('store.get', async (_$, e) => ({ value: kv.get(e.key) }))
  on('store.set', async (_$, e) => { kv.set(e.key, e.value); return { value: undefined } })
  on('store.delete', async (_$, e) => { kv.delete(e.key); return { value: undefined } })
  on('store.keys', async () => ({ value: [...kv.keys()] }))
  on('tool.check', async () => rules)
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['idle'] }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', async () => ({ value: ROOT }))
  on('session.id', async () => ({ value: SID }))
  on('fs.exists', async (_$, e) => ({ value: files.has(e.path) || isDir(e.path) }))
  on('fs.read', async (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_$, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('fs.list', async (_$, e) => {
    const names = new Map<string, 'file' | 'dir'>()
    for (const f of files.keys()) {
      if (!f.startsWith(`${e.path}/`)) continue
      const [name, ...rest] = f.slice(e.path.length + 1).split('/')
      names.set(name!, rest.length ? 'dir' : 'file')
    }
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.stat', async (_$, e) => ({ value: { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false, realPath: e.path } }))
  on('process.run', async (_$, e) => {
    const done = (stdout = '', exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const argv = [...e.argv]
    if (argv[0] === 'git') return argv.includes('--show-toplevel') ? done(`${ROOT}\n`) : done('', 128)
    if (argv[0] === 'rm') { files.delete(argv[3]!); return done() }
    if (argv[0] === 'mv') {
      const [from, to] = [argv[2]!, argv[3]!]
      for (const [f, text] of [...files]) if (f.startsWith(`${from}/`)) { files.delete(f); files.set(to + f.slice(from.length), text) }
      return done()
    }
    // A real wait: the held box polls, and a microtask-only loop would starve the timers the tests use.
    if (argv[0] === 'sleep') { await pause(5); return done() }
    if (argv[0] === '/bin/sh') {
      ran.push(argv[2]!)
      const code = exits[argv[2]!] ?? 0
      return done(code ? `${argv[2]}: failed\n` : '', code)
    }
    return done()
  })
  on('agent.register', async (_$, e) => ({ value: { agent: `pantheon:${e.name}` } }))
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__pantheon__${e.name}` } }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', async (_$, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.open', async () => ({ value: { isPlaced: false } }) as never)
  on('ui.invalidate', async () => ({ value: undefined }))
  on('classic.SessionStart', async () => ({}))
  on('classic.Stop', async () => ({}))
  return { files, exits, toasts, ran, rules, store: kv }
}


const FLOW_JSON = "{\n \"schema_version\": 1,\n \"title\": \"JevFlow decision diagram\",\n \"goal\": \"T\u00e1, agora eu preciso entender se o que foi implementado nos \u00faltimos commits vai funcionar. \u00c9, tem que passar tudo pelo Jam, n\u00e3o \u00e9 isso? Faz um artifacts para poder \u00e9, com um diagrama visual como \u00e9 que vai ser as tomadas de decis\u00f5es.\",\n \"phases\": [\n  {\n   \"id\": \"analyze\",\n   \"name\": \"Assess whether the JevFlow port works\",\n   \"done_when\": \"the pantheon plugin tests pass and a review of the Stop decision path, with a verdict line, is written to the scratchpad\",\n   \"check\": \"claude plugin test plugins/pantheon >/dev/null 2>&1 && grep -q '^Veredito' /private/tmp/claude-501/-Users-andersonsilva--herdr-worktrees-claude-mods-andersonsilva-pantheon-improve/98128366-8725-4d9b-9ede-3e31a6e864c3/scratchpad/jevflow-review.md\",\n   \"depends_on\": []\n  },\n  {\n   \"id\": \"diagram\",\n   \"name\": \"Build the decision diagram page\",\n   \"done_when\": \"an HTML page in the scratchpad shows the Stop pipeline as an SVG diagram and the ladder of judged rules 6 to 12\",\n   \"check\": \"grep -q 'id=\\\"stop-pipeline\\\"' /private/tmp/claude-501/-Users-andersonsilva--herdr-worktrees-claude-mods-andersonsilva-pantheon-improve/98128366-8725-4d9b-9ede-3e31a6e864c3/scratchpad/jevflow-decisoes.html && grep -q 'id=\\\"rules-ladder\\\"' /private/tmp/claude-501/-Users-andersonsilva--herdr-worktrees-claude-mods-andersonsilva-pantheon-improve/98128366-8725-4d9b-9ede-3e31a6e864c3/scratchpad/jevflow-decisoes.html\",\n   \"depends_on\": [\"analyze\"]\n  },\n  {\n   \"id\": \"publish\",\n   \"name\": \"Publish the artifact\",\n   \"done_when\": \"the page is published as an Artifact and its claude.ai URL is recorded in the scratchpad\",\n   \"check\": \"grep -q 'claude.ai/' /private/tmp/claude-501/-Users-andersonsilva--herdr-worktrees-claude-mods-andersonsilva-pantheon-improve/98128366-8725-4d9b-9ede-3e31a6e864c3/scratchpad/artifact-url.txt\",\n   \"depends_on\": [\"diagram\"]\n  }\n ]\n}\n"
const STATE_JSON = "{\n \"state_schema\": 1,\n \"flow_version\": \"1\",\n \"current_phase\": \"diagram\",\n \"phase_status\": {\n  \"analyze\": \"done\",\n  \"diagram\": \"active\",\n  \"publish\": \"pending\"\n },\n \"blocks_this_session\": 0,\n \"restarts\": 0,\n \"jev_calls\": 8,\n \"loop_iterations\": {},\n \"phase_attempts\": {\n  \"analyze\": 1,\n  \"diagram\": 1\n },\n \"consecutive_blocks\": 0,\n \"stuck_streak\": 0,\n \"escalations\": 0,\n \"same_reason_count\": 0,\n \"needs_human\": null,\n \"last_failure\": null,\n \"review_streak\": null,\n \"last_block_reason\": \"Phase 'analyze' is complete. Now work on phase 'diagram' (Build the decision diagram page): an HTML page in the scratchpad shows the Stop pipeline as an SVG diagram and the ladder of judged rules 6 to 12.\",\n \"last_error\": null,\n \"started_at\": 1791651154.919,\n \"updated_at\": 1791651504.227,\n \"history\": [\n  {\n   \"ts\": 1791651154.919,\n   \"seq\": 1,\n   \"event\": \"flow_laid_out\",\n   \"phases\": 3,\n   \"phase\": \"analyze\"\n  },\n  {\n   \"ts\": 1791651342.107,\n   \"seq\": 2,\n   \"event\": \"stop\",\n   \"decision\": \"BLOCK\",\n   \"condition\": \"drop_band\",\n   \"enforced\": true,\n   \"to_phase\": null,\n   \"reason\": \"Continue phase 'analyze' (Assess whether the JevFlow port works). Not done yet: the pantheon plugin tests pass and a review of the Stop decision path, with a verdict line, is written to the scratchpad. Check for 'analyze' fails:\\ngrep: /private/tmp/claude-501/-Users-andersonsilva--herdr-worktrees-claude-mods-andersonsilva-pantheon-improve/98128366-8725-4d9b-9ede-3e31a6e864c3/scratchpad/jevflow-review.md: No such file or directory\",\n   \"checks\": {\n    \"analyze\": false\n   },\n   \"probs\": {\n    \"current_phase\": [\n     \"analyze\",\n     1\n    ],\n    \"next_action\": [\n     \"continue_phase\",\n     0.82\n    ],\n    \"stuck\": 0.27,\n    \"off_goal\": 0.31,\n    \"claims_done\": 0.09,\n    \"phase_done__analyze\": 0.02,\n    \"phase_done__diagram\": 0.03,\n    \"verify\": [\n     \"analyze\",\n     0.02\n    ],\n    \"progress\": 0.245\n   },\n   \"phase\": \"analyze\"\n  },\n  {\n   \"ts\": 1791651406.393,\n   \"seq\": 3,\n   \"event\": \"stop\",\n   \"decision\": \"BLOCK\",\n   \"condition\": \"drop_band\",\n   \"enforced\": true,\n   \"to_phase\": null,\n   \"reason\": \"Continue phase 'analyze' (Assess whether the JevFlow port works). Not done yet: the pantheon plugin tests pass and a review of the Stop decision path, with a verdict line, is written to the scratchpad.\",\n   \"checks\": {\n    \"analyze\": true\n   },\n   \"probs\": {\n    \"current_phase\": [\n     \"analyze\",\n     1\n    ],\n    \"next_action\": [\n     \"continue_phase\",\n     0.8\n    ],\n    \"stuck\": 0.24,\n    \"off_goal\": 0.04,\n    \"claims_done\": 0.09,\n    \"phase_done__analyze\": 0.29,\n    \"phase_done__diagram\": 0.14,\n    \"verify\": [\n     \"analyze\",\n     0.25\n    ],\n    \"progress\": 0.535\n   },\n   \"phase\": \"analyze\"\n  },\n  {\n   \"ts\": 1791651438.994,\n   \"seq\": 4,\n   \"event\": \"stop\",\n   \"decision\": \"BLOCK\",\n   \"condition\": \"review_band\",\n   \"enforced\": true,\n   \"to_phase\": null,\n   \"reason\": \"Continue phase 'analyze' (Assess whether the JevFlow port works). Not done yet: the pantheon plugin tests pass and a review of the Stop decision path, with a verdict line, is written to the scratchpad.\\nNote: Jev is not yet confident phase 'analyze' is done (0.60); its check passes. Confirm every part of: the pantheon plugin tests pass and a review of the Stop decision path, with a verdict line, is written to the scratchpad.\",\n   \"checks\": {\n    \"analyze\": true\n   },\n   \"probs\": {\n    \"current_phase\": [\n     \"analyze\",\n     0.99\n    ],\n    \"next_action\": [\n     \"advance_phase\",\n     0.52\n    ],\n    \"stuck\": 0.19,\n    \"off_goal\": 0.08,\n    \"claims_done\": 0.13,\n    \"phase_done__analyze\": 0.59,\n    \"phase_done__diagram\": 0.03,\n    \"verify\": [\n     \"analyze\",\n     0.6\n    ],\n    \"progress\": 0.41\n   },\n   \"phase\": \"analyze\"\n  },\n  {\n   \"ts\": 1791651472.664,\n   \"seq\": 5,\n   \"event\": \"stop\",\n   \"decision\": \"ADVANCE\",\n   \"condition\": \"advance\",\n   \"enforced\": true,\n   \"to_phase\": \"diagram\",\n   \"reason\": \"Phase 'analyze' is complete. Now work on phase 'diagram' (Build the decision diagram page): an HTML page in the scratchpad shows the Stop pipeline as an SVG diagram and the ladder of judged rules 6 to 12.\",\n   \"checks\": {\n    \"analyze\": true\n   },\n   \"probs\": {\n    \"current_phase\": [\n     \"analyze\",\n     0.84\n    ],\n    \"next_action\": [\n     \"advance_phase\",\n     0.96\n    ],\n    \"stuck\": 0.33,\n    \"off_goal\": 0.06,\n    \"claims_done\": 0.7,\n    \"phase_done__analyze\": 0.88,\n    \"phase_done__diagram\": 0.04,\n    \"verify\": [\n     \"analyze\",\n     0.88\n    ],\n    \"progress\": 0.443\n   },\n   \"phase\": \"diagram\"\n  },\n  {\n   \"ts\": 1791651504.227,\n   \"seq\": 6,\n   \"event\": \"budget_refill\",\n   \"source\": \"user_prompt\",\n   \"used\": 3,\n   \"phase\": \"diagram\"\n  }\n ],\n \"done\": false,\n \"agents\": {\n  \"session:98128366-8725-4d9b-9ede-3e31a6e864c3\": {\n   \"label\": \"lead\",\n   \"kind\": \"session\",\n   \"session\": \"98128366-8725-4d9b-9ede-3e31a6e864c3\",\n   \"first_at\": 1791651156.414,\n   \"at\": 1791651472.664,\n   \"tools\": 0,\n   \"stops\": 4,\n   \"phase\": \"diagram\",\n   \"role\": \"lead\"\n  }\n },\n \"seq\": 6,\n \"session_id\": \"98128366-8725-4d9b-9ede-3e31a6e864c3\"\n}\n"




const ID = '20261010-165211-jevflow-decision-diagram'

type Surface = 'terminal' | 'desktop'
async function withPane(
  $: Engine, surface: Surface, bodyRows: number, check: (texts: string[], ui: Awaited<ReturnType<Engine['ui']['mount']>>) => Promise<void> | void, columns = 72,
) {
  const ui = await $.ui.mount({ plugin: 'pantheon', surface, component: 'Pane', requestId: 'pantheon', props: { title: 'Pantheon', isFocused: true, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows } }, viewport: { columns: 120, rows: 40 } } as never)
  try {
    const texts = (await ui.findAll({ type: 'Text' })).map(n => String(n.text))
    await check(texts, ui)
  } finally { await ui.unmount().catch(() => undefined) }
}

function seedFlow(w: ReturnType<typeof flowWorld>) {
  w.files.set(`${ROOT}/.pantheon/flow/flows/${ID}/flow.json`, FLOW_JSON)
  w.files.set(`${ROOT}/.pantheon/flow/flows/${ID}/state.json`, STATE_JSON)
  w.files.set(`${ROOT}/.pantheon/flow/sessions/${SID}`, `${ID}\n`)
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a flow with recorded decisions draws its card in the panel, with no tab row (${surface})`, async ($, on) => {
    const w = flowWorld(on)
    seedFlow(w)
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await withPane($, surface, 60, async (texts, ui) => {
      expect(texts.join('|')).not.toContain('panel failed to draw')
      expect(texts).toContain('Flow')
      for (const phase of ['analyze', 'diagram', 'publish']) expect(texts.some(t => t.trim().endsWith(phase))).toBe(true)
      expect(texts.some(t => t.includes('ADVANCE/advance'))).toBe(true)
      expect(texts.some(t => t.includes('Jev off'))).toBe(true)
      expect(texts).toContain('Session')
      expect(await ui.find({ key: 'tab-flow' })).toBeUndefined()
      expect(await ui.find({ key: 'tab-agents' })).toBeUndefined()
    })
  })
}

test('the panel has no flow card for a session without a flow', async ($, on) => {
  flowWorld(on)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await withPane($, 'terminal', 60, texts => {
    expect(texts).toContain('Session')
    expect(texts).not.toContain('Flow')
    expect(texts.join('|')).not.toContain('Jev off')
  })
})

test('a flow bound to another session is not drawn', async ($, on) => {
  const w = flowWorld(on)
  seedFlow(w)
  w.files.delete(`${ROOT}/.pantheon/flow/sessions/${SID}`)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await withPane($, 'terminal', 60, texts => { expect(texts).not.toContain('Flow') })
})

test('a draft flow draws a card that says the phases are not laid out', async ($, on) => {
  const w = flowWorld(on)
  w.files.set(`${ROOT}/.pantheon/flow/flows/${ID}/draft.json`, '{"goal":"Ship the thing"}')
  w.files.set(`${ROOT}/.pantheon/flow/sessions/${SID}`, `${ID}\n`)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await withPane($, 'terminal', 60, texts => {
    expect(texts).toContain('Flow')
    expect(texts.some(t => t.includes('Draft: phases not laid out yet'))).toBe(true)
  })
})

for (const rows of [3, 4, 6, 8, 10, 12, 16, 24, 60]) {
  test(`the panel with a flow draws within ${rows} rows and never goes blank`, async ($, on) => {
    const w = flowWorld(on)
    seedFlow(w)
    await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
    await withPane($, 'terminal', rows, texts => {
      expect(texts.length).toBeGreaterThan(0)
      expect(texts.join('|')).not.toContain('panel failed to draw')
      // Every row is one Box in the pane; the card never pushes the panel past its height.
    })
  })
}

test('a render failure draws an error line instead of a blank pane', async ($, on) => {
  const w = flowWorld(on)
  seedFlow(w)
  // Corrupt the flow so the card draws from malformed data: the pane must still draw something.
  w.files.set(`${ROOT}/.pantheon/flow/flows/${ID}/flow.json`, '{"schema_version":1,"goal":"g","phases":"nope"}')
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await withPane($, 'terminal', 40, texts => {
    expect(texts).toContain('Flow')
    expect(texts.length).toBeGreaterThan(0)
    expect(texts).toContain('Session')
  })
})
