// The Codex engine through the test host: the option, the tools, the detached worker's files and the cards. Every
// process and file is faked; nothing runs Codex.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { CODEX_TOOL, SPECIALISTS, leadSection } from '../hooks/agents'
import { tomlString } from '../hooks/codex/argv'
import { CODEX_EXEC_0_162_FAILURE, CODEX_EXEC_0_162_INTERRUPTED, CODEX_EXEC_0_162_SUCCESS } from './fixtures/codex-exec-0.162'
import { PID, fakeProcesses, pause } from './codex-fake'
import type { Run, Scenario } from './codex-fake'

const ROOT = '/repo'
const DIR = `${ROOT}/.crew/codex`
/** The Claude session that runs the tests; a job record names it as its owner. */
const SESSION = 'claude-session-1'
/** Codex thread ids are UUIDs; anything else is refused. */
const TC = '00000000-0000-4000-8000-00000000000c'
const TD = '00000000-0000-4000-8000-00000000000d'
const TV = '00000000-0000-4000-8000-00000000000e'
const ON = { options: { codex: true } }
const START = { cwd: ROOT, surface: 'terminal', isInteractive: true } as never


/** The world of the test running now: `until` names its debug lines when a job does not get there. */
let lastWorld: { logs: string[]; runs: Run[] } | undefined

/** The host beneath the plugin: a repository at /repo, a file system in memory and the processes the engine runs. */
function codexWorld(
  on: On,
  opts: {
    files?: Record<string, string>
    dirs?: string[]
    scenario?: Scenario
    alive?: boolean
    /** The repository `git rev-parse --show-toplevel` names; null: the session is not in a git repository. */
    gitRoot?: string | null
    /** Symbolic links, `link -> target`, followed by `fs.stat` with `resolve`. */
    links?: Record<string, string>
    /** The 20 s foreground wait elapses at once (the job is still running then). */
    foregroundElapses?: boolean
    /** A write of the dashboard's cards fails while this answers true. */
    failCards?: () => boolean
    /** The worker does not start (the outer shell gave up waiting for the pid). */
    workerFails?: boolean
    /** The shell step that makes the record private fails (non-zero). */
    recordFails?: boolean
    /** The project's git ignores `.crew`. */
    crewIgnored?: boolean
  } = {},
) {
  const submittedTexts: string[] = []
  const files = new Map<string, string>(Object.entries(opts.files ?? {}))
  const dirs = new Set<string>(['/', ROOT, '/elsewhere', ...(opts.dirs ?? [])])
  const gitTop = opts.gitRoot === undefined ? ROOT : opts.gitRoot
  const fsCalls: string[] = []
  /** `..` and `.` folded, then every link prefix followed, as a real path. */
  const resolve = (path: string) => {
    const parts: string[] = []
    for (const part of path.split('/')) {
      if (part === '' || part === '.') continue
      if (part === '..') parts.pop()
      else parts.push(part)
    }
    let real = `/${parts.join('/')}`
    for (const [link, target] of Object.entries(opts.links ?? {})) {
      if (real === link || real.startsWith(`${link}/`)) real = target + real.slice(link.length)
    }
    return real
  }
  const runs: Run[] = []
  const registered: { name: string; isDeferred?: unknown }[] = []
  const logs: string[] = []
  const transcript: string[] = []
  const cards: unknown[][] = []
  const alive = new Set<number>(opts.alive ? [PID] : [])
  let scenario: Scenario = opts.scenario ?? { jsonl: CODEX_EXEC_0_162_SUCCESS.jsonl, exit: 0 }

  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('agent.register', (_$, e) => ({ value: { agent: `crew:${e.name}` } }))
  on('tool.register', (_$, e) => (registered.push({ name: e.name, isDeferred: e.isDeferred }), { value: { tool: `mcp__crew__${e.name}` } }))
  on('session.cwd', () => ({ value: ROOT }))
  on('ui.log', (_$, e) => {
    ;(e.to === 'transcript' ? transcript : logs).push(String(e.text))
    return { value: undefined }
  })
  on('state.set', (_$, e, next) => {
    // A hook that throws is skipped and the write lands, so the failing write is a deny.
    if (e.key === 'agents' && opts.failCards?.()) return { deny: 'state unavailable' } as never
    if (e.key === 'agents' && Array.isArray(e.value)) cards.push(e.value)
    return next(e)
  })
  on('prompt.submit', (_$, e) => { submittedTexts.push(String(e.text)); return { text: e.text } as never })
  on('session.id', () => ({ value: SESSION }))
  on('fs.read', (_$, e) => {
    fsCalls.push(`read ${e.path}`)
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_$, e) => (fsCalls.push(`write ${e.path}`), files.set(e.path, e.text), { value: undefined }))
  on('fs.exists', (_$, e) => ({ value: files.has(e.path) || dirs.has(e.path) }))
  on('fs.list', (_$, e) => {
    fsCalls.push(`list ${e.path}`)
    const prefix = `${e.path.replace(/\/$/, '')}/`
    const names = [...files.keys()].filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    return { value: names.map(path => ({ name: path.slice(prefix.length), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.stat', (_$, e) => {
    const asked = e.path.startsWith('/') ? e.path : `${ROOT}/${e.path}`
    const path = e.resolve ? resolve(asked) : asked
    const file = files.get(path)
    if (file === undefined && !dirs.has(path)) throw new Error(`ENOENT: ${path}`)
    return { value: { kind: file === undefined ? 'dir' : 'file', size: file?.length ?? 0, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: path } : {}) } }
  })
  const run = fakeProcesses({
    files, dirs, runs, alive, gitTop: () => gitTop, scenario: () => scenario, foregroundElapses: opts.foregroundElapses,
    workerFails: opts.workerFails, recordFails: opts.recordFails, onRecord: path => fsCalls.push(`shell ${path}`), crewIgnored: () => opts.crewIgnored === true,
  })
  on('process.run', async (_$, e) => ({ value: { ...(await run([...e.argv], e.init)), isStdoutTruncated: false, isStderrTruncated: false } }))

  lastWorld = { logs, runs }
  return {
    files, runs, registered, logs, transcript, cards, alive, fsCalls,
    get submitted() { return submittedTexts.length },
    submittedTexts,
    set scenario(next: Scenario) { scenario = next },
    worker: () => runs.filter(run => run.argv[0] === '/bin/sh' && run.argv[3] === 'crew-codex'),
    polls: () => runs.filter(run => run.argv[3] === 'crew-codex-poll'),
  }
}

const compose = ($: Engine, tools: string[]) =>
  $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools, outputStyle: null, traits: [] } as never)
const call = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: CODEX_TOOL, ...input } as never)
const result = ($: Engine, jobId: string) => $.tool.call({ tool: 'mcp__crew__codex_result', jobId } as never)
const parsed = (answer: { result?: unknown }) => JSON.parse(String(answer.result)) as Record<string, unknown>

/** Asks for the job until its status is one of `statuses`; each call lets the job's tail run. */
async function until($: Engine, jobId: string, statuses: string[], tries = 200): Promise<Record<string, unknown>> {
  let last: Record<string, unknown> = {}
  for (let i = 0; i < tries; i++) {
    last = parsed(await result($, jobId))
    if (statuses.includes(String(last.status))) return last
    // The poller sleeps on a real (1 ms) timer between polls: let it run.
    await pause(2)
  }
  const polls = lastWorld?.runs.filter(run => run.argv[3] === 'crew-codex-poll').length
  throw new Error(`job ${jobId} stayed ${String(last.status)} after ${polls} polls; debug: ${lastWorld?.logs.slice(-8).join(' | ')}`)
}

/** The codex argv the worker got (after the five file paths). */
const codexArgv = (run: Run) => run.argv.slice(9)

test('with the option off nothing is registered or run and the lead section has no Codex sentence', async ($, on) => {
  const world = codexWorld(on)
  on('prompt.compose', () => ({ sections: [] }))

  await $.session.start(START)
  const composed = await compose($, ['Agent', CODEX_TOOL])

  expect(world.registered).toEqual([])
  expect(world.runs).toEqual([])
  const lead = composed.sections.find(s => s.id === 'crew:lead')
  expect(lead?.text).toBeDefined()
  expect(lead?.text).not.toContain('Codex')
})

test('with the option on the three tools are registered, codex not deferred, and the lead section gains the sentence', { ...ON }, async ($, on) => {
  const world = codexWorld(on)
  on('prompt.compose', () => ({ sections: [] }))

  await $.session.start(START)
  const offered = await compose($, ['Agent', CODEX_TOOL])
  const plain = await compose($, ['Agent'])

  expect(world.registered).toEqual([
    { name: 'codex', isDeferred: false },
    { name: 'codex_result', isDeferred: true },
    { name: 'codex_cancel', isDeferred: true },
  ])
  expect(offered.sections.find(s => s.id === 'crew:lead')?.text).toContain('mcp__crew__codex_result')
  expect(plain.sections.find(s => s.id === 'crew:lead')?.text).not.toContain('Codex')
})

test('a subagent cannot start, read or cancel a Codex job', { ...ON }, async ($, on) => {
  const world = codexWorld(on)

  const started = await call($, { agentId: 'a1', agent: 'developer', prompt: 'fix it', description: 'fix' })
  const read = await $.tool.call({ tool: 'mcp__crew__codex_result', agentId: 'a1', jobId: 'cx-1-aaaaa' } as never)
  const cancelled = await $.tool.call({ tool: 'mcp__crew__codex_cancel', agentId: 'a1', jobId: 'cx-1-aaaaa' } as never)

  for (const answer of [started, read, cancelled]) {
    expect(answer).toHaveProperty('isError', true)
    expect(String(answer.result)).toContain('main session')
  }
  expect(world.worker()).toEqual([])
})

test('each lane gets its sandbox; the prompt goes on stdin, never in argv; architect writes -o under .crew/reviews', { ...ON }, async ($, on) => {
  const world = codexWorld(on)

  for (const agent of ['code-reader', 'developer', 'architect']) {
    const answer = await call($, { agent, prompt: `secret task for ${agent}`, description: 'Review the parser', background: true })
    expect(answer).not.toHaveProperty('isError')
  }
  const [reader, developer, architect] = world.worker()

  expect(codexArgv(reader!).slice(0, 5)).toEqual(['codex', 'exec', '--json', '-s', 'read-only'])
  expect(codexArgv(developer!).slice(0, 5)).toEqual(['codex', 'exec', '--json', '-s', 'workspace-write'])
  expect(codexArgv(architect!).slice(0, 5)).toEqual(['codex', 'exec', '--json', '-s', 'read-only'])
  for (const run of [reader!, developer!, architect!]) {
    expect(codexArgv(run)).toContain('approval_policy="on-request"')
    expect(codexArgv(run)).toContain('approvals_reviewer="auto_review"')
    expect(codexArgv(run)).not.toContain('--ignore-user-config')
    expect(codexArgv(run)).not.toContain('--skip-git-repo-check')
    expect(codexArgv(run).at(-1)).toBe('-')
    expect(run.argv.join(' ')).not.toContain('secret task')
    expect(run.stdin).toContain('secret task')
    expect(run.argv[4]).toMatch(/^\/repo\/\.crew\/codex\/cx-[a-z0-9]+-[a-z0-9]+\.prompt$/)
  }
  expect(codexArgv(reader!)).not.toContain('-o')
  expect(codexArgv(developer!)).not.toContain('-o')
  const out = codexArgv(architect!)[codexArgv(architect!).indexOf('-o') + 1]
  expect(out).toMatch(/^\/repo\/\.crew\/reviews\/review-the-parser-cx-[a-z0-9-]+\.md$/)
  expect(world.runs.some(run => run.argv[0] === 'mkdir' && run.argv.includes('/repo/.crew/reviews'))).toBe(true)
  // The developer's role prompt rides as developer_instructions.
  expect(codexArgv(developer!).find(arg => arg.startsWith('developer_instructions='))).toContain('You are a developer.')
})

test('a write role is refused outside the repository; a read role runs there without the git check', { ...ON }, async ($, on) => {
  const world = codexWorld(on)

  const refused = await call($, { agent: 'developer', prompt: 'edit', description: 'edit', cwd: '/elsewhere', background: true })
  expect(refused).toHaveProperty('isError', true)
  expect(String(refused.result)).toContain('outside')
  expect(world.worker()).toEqual([])

  const read = await call($, { agent: 'code-reader', prompt: 'look', description: 'look', cwd: '/elsewhere', background: true })
  expect(read).not.toHaveProperty('isError')
  expect(codexArgv(world.worker()[0]!)).toContain('--skip-git-repo-check')
  expect(world.worker()[0]!.cwd).toBe('/elsewhere')
})

test('a foreground job that finishes answers with the final message, usage and its card', { ...ON }, async ($, on) => {
  const world = codexWorld(on)

  const answer = parsed(await call($, { agent: 'code-reader', prompt: 'list files', description: 'list files' }))

  expect(answer.status).toBe('done')
  expect(String(answer.answer)).toContain('Neste diretório')
  expect(answer.usage).toEqual(expect.objectContaining({ input: 49250, cached: 37632, output: 73 }))
  const record = JSON.parse(world.files.get(`${DIR}/${String(answer.jobId)}.json`) ?? '{}') as Record<string, unknown>
  expect(record.status).toBe('done')
  expect(record.pid).toBe(PID)
  const last = world.cards.at(-1) as { id: string; type: string; status: string }[]
  expect(last.find(card => card.id === answer.jobId)).toEqual(expect.objectContaining({ type: 'codex:code-reader', status: 'done' }))
})

test('a failed turn is an error; exit 1 with no terminal event and no cancel is an error, not a cancel', { ...ON }, async ($, on) => {
  const world = codexWorld(on, { scenario: { jsonl: CODEX_EXEC_0_162_FAILURE.jsonl, exit: 1 } })

  const failed = await call($, { agent: 'code-reader', prompt: 'x', description: 'fails' })
  expect(failed).toHaveProperty('isError', true)
  expect(parsed(failed).status).toBe('error')

  world.scenario = { jsonl: CODEX_EXEC_0_162_INTERRUPTED.jsonl, exit: 1 }
  const died = parsed(await call($, { agent: 'code-reader', prompt: 'x', description: 'dies' }))
  expect(died.status).toBe('error')
})

test('jobs are read back from their files after a reload: ended, finished meanwhile, and lost', { ...ON }, async ($, on) => {
  const record = (id: string, status: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ v: 1, id, agent: 'developer', description: `job ${id}`, cwd: ROOT, status, startedAt: 1000, pid: PID, owner: SESSION, ...extra })
  const world = codexWorld(on, {
    files: {
      [`${DIR}/cx-a-00001.json`]: record('cx-a-00001', 'done', { result: 'kept answer', endedAt: 2000 }),
      [`${DIR}/cx-b-00002.json`]: record('cx-b-00002', 'background'),
      [`${DIR}/cx-b-00002.jsonl`]: CODEX_EXEC_0_162_SUCCESS.jsonl,
      [`${DIR}/cx-b-00002.exit`]: '0\n',
      [`${DIR}/cx-c-00003.json`]: record('cx-c-00003', 'running', { sessionId: TC }),
      [`${DIR}/cx-c-00003.jsonl`]: `{"type":"thread.started","thread_id":"${TC}"}\n{"type":"turn.started"}\n`,
      [`${DIR}/notes.json`]: '{"not":"a job"}',
    },
  })

  await $.session.start(START)

  expect(parsed(await result($, 'cx-a-00001'))).toEqual(expect.objectContaining({ status: 'done', answer: 'kept answer' }))
  const finished = await until($, 'cx-b-00002', ['done', 'error'])
  expect(finished.status).toBe('done')
  expect(String(finished.answer)).toContain('Neste diretório')
  const lost = await until($, 'cx-c-00003', ['lost', 'error', 'done'])
  expect(lost.status).toBe('lost')
  expect(lost.resumable).toBe(true)
  expect(JSON.parse(world.files.get(`${DIR}/cx-b-00002.json`) ?? '{}')).toEqual(expect.objectContaining({ status: 'done' }))
  expect(world.transcript.some(line => line.includes('cx-b-00002') && line.includes('done'))).toBe(true)
  // The lead gets the same fixed line as a prompt of its own.
  expect(world.submittedTexts).toContain(`Codex job cx-b-00002 (developer) ended with done; use codex_result({ jobId: 'cx-b-00002' }).`)
  // An ended job read back is listed, not drawn again.
  expect(world.cards.flat().some(card => (card as { id: string }).id === 'cx-a-00001')).toBe(false)

  // A lost job resumes in its Codex session, as the same agent.
  const wrongAgent = await call($, { agent: 'tester', prompt: 'go on', description: 'go on', resume: 'cx-c-00003', background: true })
  expect(String(wrongAgent.result)).toContain('ran developer')
  await call($, { agent: 'developer', prompt: 'go on', description: 'go on', resume: 'cx-c-00003', background: true })
  const argv = codexArgv(world.worker().at(-1)!)
  expect(argv.slice(-3)).toEqual(['resume', TC, '-'])
})

test('a job still running after a reload keeps being followed until its worker writes the exit code', { ...ON }, async ($, on) => {
  const world = codexWorld(on, {
    alive: true,
    files: {
      [`${DIR}/cx-d-00004.json`]: JSON.stringify({ v: 1, id: 'cx-d-00004', agent: 'tester', description: 'tests', cwd: ROOT, status: 'background', startedAt: 1, pid: PID, owner: SESSION }),
      [`${DIR}/cx-d-00004.jsonl`]: `{"type":"thread.started","thread_id":"${TD}"}\n{"type":"turn.started"}\n`,
    },
  })

  await $.session.start(START)
  expect(parsed(await result($, 'cx-d-00004')).status).toBe('background')
  for (let i = 0; i < 20; i++) await result($, 'cx-d-00004')
  expect(parsed(await result($, 'cx-d-00004')).status).toBe('background')

  world.files.set(`${DIR}/cx-d-00004.jsonl`, CODEX_EXEC_0_162_SUCCESS.jsonl.replace('01a12bd5-30e4-7f12-8e42-d8db931e560d', TD))
  world.files.set(`${DIR}/cx-d-00004.exit`, '0\n')
  world.alive.clear()
  expect((await until($, 'cx-d-00004', ['done', 'error', 'lost'])).status).toBe('done')
})

test('cancel sends SIGINT to the recorded pid, and the job ends cancelled', { ...ON }, async ($, on) => {
  const world = codexWorld(on, { scenario: { jsonl: `{"type":"thread.started","thread_id":"${TV}"}\n{"type":"turn.started"}\n` } })

  const started = parsed(await call($, { agent: 'developer', prompt: 'long work', description: 'long', background: true }))
  const jobId = String(started.jobId)
  await until($, jobId, ['background'])

  // The job stays active until Codex has stopped: the answer is `cancelling`, then the job ends `cancelled`.
  const cancelled = await $.tool.call({ tool: 'mcp__crew__codex_cancel', jobId } as never)
  expect(parsed(cancelled).status).toBe('cancelling')
  expect(world.runs.find(run => run.argv[0] === 'kill')?.argv).toEqual(['kill', '-INT', String(PID)])
  expect((await until($, jobId, ['cancelled', 'error', 'done', 'lost'])).status).toBe('cancelled')
  const record = JSON.parse(world.files.get(`${DIR}/${jobId}.json`) ?? '{}') as Record<string, unknown>
  expect(record).toEqual(expect.objectContaining({ status: 'cancelled', cancelRequested: true }))
})

// --- Independent verification (T2): one block per criterion ---

/** One step of the main loop (no agentId), answered by a terminal step below the crew's. */
async function mainStep($: Engine) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'sonnet', messageCount: 1 } as never)
  let item = await stream.next()
  while (!item.done) item = await stream.next()
}
const answerSteps = (on: On) =>
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null } as never
  })
const leadOf = (composed: { sections: readonly { id: string; text: string }[] }) => composed.sections.find(s => s.id === 'crew:lead')?.text
const line = (value: unknown) => `${JSON.stringify(value)}\n`
const THREAD = { type: 'thread.started', thread_id: TV }

test('C1: option off, the lead section is byte-identical with or without the Codex tool, and a main-loop step touches nothing', async ($, on) => {
  const world = codexWorld(on)
  on('prompt.compose', () => ({ sections: [] }))
  answerSteps(on)

  await $.session.start(START)
  const offered = await compose($, ['Agent', CODEX_TOOL])
  const plain = await compose($, ['Agent'])
  await mainStep($)

  expect(leadOf(offered)).toBe(leadSection(false))
  expect(leadOf(plain)).toBe(leadSection(false))
  expect(world.registered).toEqual([])
  expect(world.runs).toEqual([])
  expect(world.fsCalls.filter(call => call.includes('.crew'))).toEqual([])
  expect(world.submitted).toBe(0)
})

test('C1: option on, a request without the Codex tool gets the same bytes as option off', { ...ON }, async ($, on) => {
  codexWorld(on)
  on('prompt.compose', () => ({ sections: [] }))

  await $.session.start(START)
  expect(leadOf(await compose($, ['Agent']))).toBe(leadSection(false))
  expect(leadOf(await compose($, ['Agent', CODEX_TOOL]))).not.toBe(leadSection(false))
})

test('C2: a subagent is refused on all three tools even for a job that exists, and nothing about it leaks', { ...ON }, async ($, on) => {
  const world = codexWorld(on)
  const started = parsed(await call($, { agent: 'code-reader', prompt: 'p', description: 'd' }))
  const jobId = String(started.jobId)
  const workers = world.worker().length

  for (const tool of ['mcp__crew__codex_result', 'mcp__crew__codex_cancel']) {
    const answer = await $.tool.call({ tool, agentId: 'sub-1', jobId } as never)
    expect(answer).toHaveProperty('isError', true)
    expect(String(answer.result)).not.toContain('Neste diretório')
    expect(String(answer.result)).not.toContain(jobId)
  }
  const resumed = await call($, { agentId: 'sub-1', agent: 'code-reader', prompt: 'p', description: 'd', resume: jobId })
  expect(resumed).toHaveProperty('isError', true)
  expect(world.worker().length).toBe(workers)
  expect(world.runs.some(run => run.argv[0] === 'kill')).toBe(false)
})

test('C2: resume keeps the agent and the cwd: another agent or another cwd is refused, the same cwd by another spelling is not', { ...ON }, async ($, on) => {
  const world = codexWorld(on, { dirs: [`${ROOT}/src`] })
  const first = parsed(await call($, { agent: 'developer', prompt: 'p', description: 'd', cwd: `${ROOT}/src` }))
  const jobId = String(first.jobId)
  expect(first.status).toBe('done')

  const otherAgent = await call($, { agent: 'tester', prompt: 'p', description: 'd', resume: jobId })
  expect(String(otherAgent.result)).toContain('ran developer')
  const otherCwd = await call($, { agent: 'developer', prompt: 'p', description: 'd', resume: jobId, cwd: ROOT })
  expect(otherCwd).toHaveProperty('isError', true)
  expect(String(otherCwd.result)).toContain('keeps that directory')
  const workers = world.worker().length

  const same = await call($, { agent: 'developer', prompt: 'p', description: 'd', resume: jobId, cwd: `${ROOT}/x/../src` })
  expect(same).not.toHaveProperty('isError')
  expect(world.worker().length).toBe(workers + 1)
  expect(world.worker().at(-1)!.cwd).toBe(`${ROOT}/src`)
  expect(codexArgv(world.worker().at(-1)!).slice(-3)).toEqual(['resume', '01a12bd5-30e4-7f12-8e42-d8db931e560d', '-'])
})

test('C3: every lane gets the sandbox of the plan; -o only for architect and research, from the lane and never from the input', { ...ON }, async ($, on) => {
  const world = codexWorld(on, { dirs: [`${ROOT}/src`] })
  const lanes: Record<string, string> = {
    'code-reader': 'read-only', research: 'read-only', architect: 'read-only',
    developer: 'workspace-write', designer: 'workspace-write', tester: 'workspace-write',
  }
  const hostile = {
    sandbox: 'danger-full-access', output: '/etc/passwd', model: 'evil-model', effort: 'max', approvals: false,
    description: '../../etc/passwd $(rm -rf ~) "quoted"',
  }
  for (const agent of Object.keys(lanes)) {
    const answer = await call($, { agent, prompt: `PROMPT-${agent} $(id) \`id\``, ...hostile, cwd: `${ROOT}/src`, background: true })
    expect(answer).not.toHaveProperty('isError')
  }
  const workers = world.worker()
  expect(workers.length).toBe(6)
  Object.keys(lanes).forEach((agent, i) => {
    const run = workers[i]!
    const argv = codexArgv(run)
    const spec = SPECIALISTS.find(s => s.name === agent)!
    expect(argv.slice(0, 5)).toEqual(['codex', 'exec', '--json', '-s', lanes[agent]!])
    const instructions = argv[6]!
    if (agent === 'architect' || agent === 'research') {
      // The lane suffix: the final message is the whole answer, saved by Codex to the -o file; no file writes.
      expect(instructions.startsWith(`developer_instructions=${tomlString(spec.prompt).slice(0, -1)}`)).toBe(true)
      expect(instructions).toContain(`Codex saves your final message verbatim to .crew/${agent === 'architect' ? 'reviews' : 'research'}/`)
      expect(instructions).toContain('cannot write files')
    } else {
      expect(instructions).toBe(`developer_instructions=${tomlString(spec.prompt)}`)
    }
    expect(argv.slice(7, 11)).toEqual(['-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"'])
    const pinned = argv.includes('sandbox_workspace_write.writable_roots=[]') && argv.includes('sandbox_workspace_write.network_access=false')
    expect(pinned).toBe(lanes[agent] === 'workspace-write')
    for (const banned of ['--ignore-user-config', '--dangerously-bypass-approvals-and-sandbox', 'danger-full-access', '/etc/passwd', '-m', 'evil-model', '--skip-git-repo-check']) {
      expect(argv).not.toContain(banned)
    }
    expect(argv.join('\n')).not.toContain(`PROMPT-${agent}`)
    expect(run.stdin).toBe(`PROMPT-${agent} $(id) \`id\``)
    expect(argv.at(-1)).toBe('-')
    const o = argv.indexOf('-o')
    if (agent === 'architect' || agent === 'research') {
      const folder = agent === 'architect' ? 'reviews' : 'research'
      expect(argv[o + 1]).toMatch(new RegExp(`^/repo/\\.crew/${folder}/etc-passwd-rm-rf-quoted-cx-[a-z0-9]+-[a-z0-9]+\\.md$`))
      expect(argv.filter(arg => arg === '-o').length).toBe(1)
    } else {
      expect(o).toBe(-1)
    }
    expect(run.cwd).toBe(`${ROOT}/src`)
  })
})

test('C3: a read role outside the repository still writes -o under the session repository, with --skip-git-repo-check', { ...ON }, async ($, on) => {
  const world = codexWorld(on)
  await call($, { agent: 'architect', prompt: 'p', description: 'out', cwd: '/elsewhere', background: true })
  const argv = codexArgv(world.worker()[0]!)
  expect(argv[argv.indexOf('-o') + 1]).toMatch(/^\/repo\/\.crew\/reviews\/out-cx-[a-z0-9-]+\.md$/)
  expect(argv).toContain('--skip-git-repo-check')
  expect(argv.indexOf('--skip-git-repo-check')).toBeLessThan(argv.length - 1)
})

test('C3: codexModels adds -m only for the roles it names; a malformed id is ignored', { options: { codex: true, codexModels: 'developer=gpt-x, tester=--evil, architect=gpt-y' } }, async ($, on) => {
  const world = codexWorld(on)
  await $.session.start(START)
  for (const agent of ['developer', 'tester', 'code-reader', 'architect']) {
    await call($, { agent, prompt: 'p', description: 'd', background: true })
  }
  const [developer, tester, reader, architect] = world.worker().map(codexArgv)
  expect(developer![developer!.indexOf('-m') + 1]).toBe('gpt-x')
  expect(architect![architect!.indexOf('-m') + 1]).toBe('gpt-y')
  expect(tester).not.toContain('-m')
  expect(tester).not.toContain('--evil')
  expect(reader).not.toContain('-m')
  expect(world.logs.some(log => log.includes('codexModels ignored in part'))).toBe(true)
})

for (const agent of ['developer', 'designer', 'tester'] as const) {
  test(`C4: ${agent} is refused when the session is not in a git repository; a read role still runs`, { ...ON }, async ($, on) => {
    const world = codexWorld(on, { gitRoot: null })
    const refused = await call($, { agent, prompt: 'p', description: 'd', background: true })
    expect(refused).toHaveProperty('isError', true)
    expect(String(refused.result)).toContain('git repository')
    expect(world.worker()).toEqual([])

    const read = await call($, { agent: 'code-reader', prompt: 'p', description: 'd', background: true })
    expect(read).not.toHaveProperty('isError')
    expect(codexArgv(world.worker()[0]!)).toContain('--skip-git-repo-check')
  })
}

test('C4: a write role cwd that resolves outside the repository is refused: a symlink to /tmp, .. segments, a sibling prefix', { ...ON }, async ($, on) => {
  const world = codexWorld(on, {
    dirs: ['/private/tmp/x', '/repository', `${ROOT}/src`],
    links: { [`${ROOT}/link`]: '/private/tmp/x', '/tmp': '/private/tmp' },
  })
  for (const cwd of [`${ROOT}/link`, '/tmp/x', `${ROOT}/../elsewhere`, `${ROOT}/src/../../elsewhere`, '/repository', '/', '../elsewhere', 'link']) {
    const answer = await call($, { agent: 'developer', prompt: 'p', description: 'd', cwd, background: true })
    expect(answer).toHaveProperty('isError', true)
    expect(String(answer.result)).toMatch(/outside it|does not exist/)
  }
  expect(world.worker()).toEqual([])

  // Inside, by any spelling: run at the real path.
  for (const cwd of [`${ROOT}/src/../src`, 'src', `${ROOT}/./src/`]) {
    const answer = await call($, { agent: 'developer', prompt: 'p', description: 'd', cwd, background: true })
    expect(answer).not.toHaveProperty('isError')
    expect(world.worker().at(-1)!.cwd).toBe(`${ROOT}/src`)
  }
})

test('C4: a repository reached through a symlink compares real paths on both sides', { ...ON }, async ($, on) => {
  // git names the real top level; the cwd asked is the link.
  const world = codexWorld(on, { gitRoot: '/real/repo', dirs: ['/real/repo', '/real/repo/src'], links: { [ROOT]: '/real/repo' } })
  const answer = await call($, { agent: 'developer', prompt: 'p', description: 'd', cwd: `${ROOT}/src`, background: true })
  expect(answer).not.toHaveProperty('isError')
  expect(world.worker()[0]!.cwd).toBe('/real/repo/src')
})

test('C6: a reload reads back the latest 50 records only', { ...ON }, async ($, on) => {
  const files: Record<string, string> = {}
  for (let i = 1; i <= 55; i++) {
    const id = `cx-r${i}-00001`
    files[`${DIR}/${id}.json`] = JSON.stringify({ v: 1, id, agent: 'code-reader', description: `job ${i}`, cwd: ROOT, status: 'done', startedAt: i, endedAt: i + 1, result: `answer ${i}` })
  }
  const world = codexWorld(on, { files })
  await $.session.start(START)

  for (let i = 1; i <= 5; i++) expect(String((await result($, `cx-r${i}-00001`)).result)).toContain('Unknown job')
  for (const i of [6, 30, 55]) expect(parsed(await result($, `cx-r${i}-00001`))).toEqual(expect.objectContaining({ status: 'done', answer: `answer ${i}` }))
  // Ended jobs are listed, never drawn again, and their records are not rewritten.
  expect(world.cards.flat().length).toBe(0)
  expect(world.fsCalls.filter(call => call.startsWith('write '))).toEqual([])
  expect(world.runs.filter(run => run.argv[0] === '/bin/sh' || run.argv[0] === 'kill')).toEqual([])
})

test('C6: after a reload, an answer the record cut at 20k is read again from the JSONL and capped at 50k', { ...ON }, async ($, on) => {
  const long = 'y'.repeat(60_000)
  const cut = `${long.slice(0, 20_000)}\n[... cut at 20000 characters]`
  const record = (id: string) => JSON.stringify({ v: 1, id, agent: 'architect', description: id, cwd: ROOT, status: 'done', startedAt: 1, endedAt: 2, result: cut, owner: SESSION })
  const world = codexWorld(on, {
    files: {
      [`${DIR}/cx-w-00001.json`]: record('cx-w-00001'),
      [`${DIR}/cx-w-00001.jsonl`]: line(THREAD) + line({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'draft' } })
        + line({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: long } }) + line({ type: 'turn.completed', usage: {} }),
      // No JSONL left: the record's copy stands.
      [`${DIR}/cx-w-00002.json`]: record('cx-w-00002'),
    },
  })
  await $.session.start(START)

  const whole = String(parsed(await result($, 'cx-w-00001')).answer)
  expect(whole.startsWith('y'.repeat(50_000))).toBe(true)
  expect(whole).toContain('[... cut at 50000 characters]')
  expect(whole.length).toBeLessThanOrEqual(50_000 + 64)
  // Asked again, the JSONL is not read twice.
  const reads = world.fsCalls.filter(call => call === `read ${DIR}/cx-w-00001.jsonl`).length
  expect(String(parsed(await result($, 'cx-w-00001')).answer)).toBe(whole)
  expect(world.fsCalls.filter(call => call === `read ${DIR}/cx-w-00001.jsonl`).length).toBe(reads)

  expect(parsed(await result($, 'cx-w-00002')).answer).toBe(cut)
})

test('C6: a running record whose pid is dead and has no .exit turns lost only after three dead checks', { ...ON }, async ($, on) => {
  const world = codexWorld(on, {
    files: {
      [`${DIR}/cx-l-00001.json`]: JSON.stringify({ v: 1, id: 'cx-l-00001', agent: 'developer', description: 'l', cwd: ROOT, status: 'running', startedAt: 1, pid: PID, owner: SESSION }),
      [`${DIR}/cx-l-00001.jsonl`]: line(THREAD),
    },
  })
  await $.session.start(START)
  const lost = await until($, 'cx-l-00001', ['lost', 'error', 'done'])
  expect(lost).toEqual(expect.objectContaining({ status: 'lost', resumable: true }))
  // Three polls in a row find no live Codex and no exit code: lost on the third.
  expect(world.polls().length).toBe(3)
  const record = JSON.parse(world.files.get(`${DIR}/cx-l-00001.json`) ?? '{}') as Record<string, unknown>
  expect(record).toEqual(expect.objectContaining({ status: 'lost', sessionId: TV }))
  const notice = `Codex job cx-l-00001 (developer) ended with lost; use codex_result({ jobId: 'cx-l-00001' }).`
  expect(world.transcript).toEqual([notice])
  expect(world.submittedTexts).toEqual([notice])
})

test('C7: the card carries status, usage and activity; while running it is throttled and the end is always written', { ...ON }, async ($, on) => {
  const world = codexWorld(on)
  const answer = parsed(await call($, { agent: 'developer', prompt: 'p', description: 'cards' }))
  const id = String(answer.jobId)
  const mine = world.cards.map(list => (list as { id: string; status: string; ctx: number; out: number; tools: { text: string }[] }[]).find(card => card.id === id)).filter(Boolean)

  // Seven events arrive in one read within a second: one running write at most, then the end.
  expect(mine.filter(card => card!.status === 'running').length).toBeLessThanOrEqual(1)
  const last = mine.at(-1)!
  expect(last).toEqual(expect.objectContaining({ status: 'done', ctx: 49250, out: 73 }))
  expect(last.tools.map(t => t.text).join('\n')).toContain("$ /bin/zsh -lc 'ls -la'")
})

test('C7: a card write that fails is written by the next main-loop step', { ...ON }, async ($, on) => {
  let failing = true
  const world = codexWorld(on, { failCards: () => failing })
  answerSteps(on)
  await $.session.start(START)
  const answer = parsed(await call($, { agent: 'code-reader', prompt: 'p', description: 'retry' }))
  expect(answer.status).toBe('done')
  expect(world.cards.flat().some(card => (card as { id: string }).id === answer.jobId)).toBe(false)
  expect(world.logs.filter(log => log.includes('panel write failed')).length).toBe(1)

  failing = false
  await mainStep($)
  for (let i = 0; i < 20 && !world.cards.length; i++) await Promise.resolve()
  expect((world.cards.at(-1) as { id: string; status: string }[]).find(card => card.id === answer.jobId)).toEqual(expect.objectContaining({ status: 'done' }))
})

test('C8: no answer while running; the answer is capped at 50k with usage, files and the -o output once done', { ...ON }, async ($, on) => {
  const long = 'x'.repeat(60_000)
  const running = line(THREAD) + line({ type: 'turn.started' }) + line({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'partial so far' } })
  const ended = running
    + line({ type: 'item.completed', item: { id: 'i1', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }, { path: 'src/b.ts', kind: 'add' }], status: 'completed' } })
    + line({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: long } })
    + line({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 } })
  const world = codexWorld(on, { scenario: { jsonl: running } })

  const started = parsed(await call($, { agent: 'architect', prompt: 'p', description: 'cap', background: true }))
  const jobId = String(started.jobId)
  const during = await until($, jobId, ['background'])
  for (let i = 0; i < 10; i++) await result($, jobId)
  const mid = parsed(await result($, jobId))
  expect(during).not.toHaveProperty('answer')
  expect(mid).not.toHaveProperty('answer')
  expect(String(mid.output)).toContain('only when the turn completes')

  world.files.set(`${DIR}/${jobId}.jsonl`, ended)
  world.files.set(`${DIR}/${jobId}.exit`, '0\n')
  const done = await until($, jobId, ['done', 'error', 'lost'])
  expect(done.status).toBe('done')
  expect(String(done.answer).length).toBeLessThanOrEqual(50_000 + 64)
  expect(String(done.answer)).toContain('[... cut at 50000 characters]')
  expect(done.usage).toEqual({ input: 10, cached: 4, output: 3 })
  expect(done.files).toEqual(['src/a.ts', 'src/b.ts'])
  expect(String(done.output)).toMatch(/^\/repo\/\.crew\/reviews\/cap-cx-[a-z0-9-]+\.md$/)
  // The record keeps a shorter copy.
  const record = JSON.parse(world.files.get(`${DIR}/${jobId}.json`) ?? '{}') as { result: string }
  expect(record.result.length).toBeLessThanOrEqual(20_000 + 64)
})

test('C8: codex_cancel is idempotent: a second cancel and a cancel after the end answer without another SIGINT', { ...ON }, async ($, on) => {
  const world = codexWorld(on, { scenario: { jsonl: line(THREAD) + line({ type: 'turn.started' }) } })
  const cancel = (jobId: string) => $.tool.call({ tool: 'mcp__crew__codex_cancel', jobId } as never)

  const jobId = String(parsed(await call($, { agent: 'developer', prompt: 'p', description: 'c', background: true })).jobId)
  await until($, jobId, ['background'])
  const first = parsed(await cancel(jobId))
  const second = parsed(await cancel(jobId))
  await until($, jobId, ['cancelled'])
  const third = parsed(await cancel(jobId))

  expect(first.status).toBe('cancelling')
  expect(['cancelling', 'cancelled']).toContain(String(second.status))
  expect(third).toEqual(expect.objectContaining({ status: 'cancelled', note: 'The job had already ended.' }))
  expect(world.runs.filter(run => run.argv[0] === 'kill').length).toBe(1)

  // A job that has already ended: the scenario ends it, so the foreground call returns done.
  world.scenario = { jsonl: CODEX_EXEC_0_162_SUCCESS.jsonl, exit: 0 }
  const finished = String(parsed(await call($, { agent: 'code-reader', prompt: 'p', description: 'f' })).jobId)
  expect(parsed(await cancel(finished)).note).toBe('The job had already ended.')
  expect(String((await cancel('cx-nope-00000')).result)).toContain('Unknown job')
})

test('C9: the foreground call waits 20 s, then returns background; the end notice carries only id, role and status', { ...ON }, async ($, on) => {
  const world = codexWorld(on, { foregroundElapses: true, scenario: { jsonl: line(THREAD) + line({ type: 'turn.started' }) } })

  const answer = parsed(await call($, { agent: 'developer', prompt: 'p', description: 'fg' }))
  const jobId = String(answer.jobId)
  expect(answer.status).toBe('background')
  expect(answer).not.toHaveProperty('answer')
  expect(String(answer.next)).toContain('codex_result')
  // The call held the job with its own wait process, which reached the limit.
  const wait = world.runs.find(run => run.argv[3] === 'crew-codex-wait')
  expect(wait?.argv[4]).toBe(`${DIR}/${jobId}.exit`)
  // The limit is the 20 s foreground, in quarter seconds (the time already spent starting the job comes off it).
  expect(Number(wait?.argv[5])).toBeGreaterThanOrEqual(76)
  expect(Number(wait?.argv[5])).toBeLessThanOrEqual(80)

  world.files.set(`${DIR}/${jobId}.jsonl`, CODEX_EXEC_0_162_SUCCESS.jsonl.replace('01a12bd5-30e4-7f12-8e42-d8db931e560d', TV))
  world.files.set(`${DIR}/${jobId}.exit`, '0\n')
  await until($, jobId, ['done'])
  const notice = `Codex job ${jobId} (developer) ended with done; use codex_result({ jobId: '${jobId}' }).`
  expect(world.transcript).toEqual([notice])
  expect(world.submittedTexts).toEqual([notice])
  expect([...world.transcript, ...world.logs, ...world.submittedTexts].join('\n')).not.toContain('Neste diretório')
})

test('C9: background true returns at once with no foreground wait; a foreground job that ends in time posts no notice', { ...ON }, async ($, on) => {
  const world = codexWorld(on, { scenario: { jsonl: line(THREAD) + line({ type: 'turn.started' }) } })

  const bg = parsed(await call($, { agent: 'developer', prompt: 'p', description: 'bg', background: true }))
  expect(bg.status).toBe('background')
  expect(world.runs.some(run => run.argv[3] === 'crew-codex-wait')).toBe(false)

  world.scenario = { jsonl: CODEX_EXEC_0_162_SUCCESS.jsonl, exit: 0 }
  const fg = parsed(await call($, { agent: 'code-reader', prompt: 'p', description: 'fg' }))
  expect(fg.status).toBe('done')
  expect(world.transcript.filter(line => line.includes(String(fg.jobId)))).toEqual([])
  expect(world.submittedTexts.filter(line => line.includes(String(fg.jobId)))).toEqual([])

  // End the background job: a tail left polling a live worker spins the test host's instant sleeps.
  world.files.set(`${DIR}/${String(bg.jobId)}.exit`, '0\n')
  world.alive.clear()
  await until($, String(bg.jobId), ['done', 'error'])
})

// --- A job of another Claude session, the abandoned worker, the `.crew` ignore and the record on return ---

const OTHER = 'claude-session-0'
const foreignRecord = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, id, agent: 'developer', description: id, cwd: ROOT, status: 'running', startedAt: 1, pid: PID, owner: OTHER, ...extra })

test('A: another session\'s job is read-only while its Codex runs, then settles from its files and can be resumed', { ...ON }, async ($, on) => {
  const id = 'cx-f-00001'
  const world = codexWorld(on, {
    alive: true,
    files: { [`${DIR}/${id}.json`]: foreignRecord(id), [`${DIR}/${id}.jsonl`]: line(THREAD) + line({ type: 'turn.started' }), [`${DIR}/${id}.pid`]: `${PID}\n` },
  })
  await $.session.start(START)

  // Codex still runs under the other session: listed read-only, never cancelled or resumed from here.
  const running = parsed(await result($, id))
  expect(running).toEqual(expect.objectContaining({ status: 'running', note: expect.stringContaining('another Claude session') }))
  const cancel = await $.tool.call({ tool: 'mcp__crew__codex_cancel', jobId: id } as never)
  expect(cancel).toEqual(expect.objectContaining({ isError: true, result: expect.stringContaining('still running') }))
  expect(world.runs.some(run => run.argv[0] === 'kill')).toBe(false)
  expect(await call($, { agent: 'developer', prompt: 'more', description: 'r', resume: id })).toHaveProperty('isError', true)

  // The other session ended and so did Codex: the next look reads the job from its files.
  world.files.set(`${DIR}/${id}.jsonl`, CODEX_EXEC_0_162_SUCCESS.jsonl.replace('01a12bd5-30e4-7f12-8e42-d8db931e560d', TV))
  world.files.set(`${DIR}/${id}.exit`, '0\n')
  world.alive.clear()
  const done = parsed(await result($, id))
  expect(done).toEqual(expect.objectContaining({ status: 'done', resumable: true }))
  expect(String(done.answer)).toContain('Neste diretório')
  expect(done).not.toHaveProperty('note')
  // Settled here with no notice and no card; the record is ended and keeps its owner.
  expect(world.transcript).toEqual([])
  expect(world.submittedTexts).toEqual([])
  expect(world.cards.flat().some(card => (card as { id: string }).id === id)).toBe(false)
  expect(JSON.parse(world.files.get(`${DIR}/${id}.json`) ?? '{}')).toEqual(expect.objectContaining({ status: 'done', owner: OTHER }))
  expect(world.runs.some(run => run.argv[0] === 'kill')).toBe(false)

  const resumed = parsed(await call($, { agent: 'developer', prompt: 'more', description: 'r', resume: id, background: true }))
  expect(resumed.status).toBe('background')
  expect(world.worker().at(-1)!.argv).toEqual(expect.arrayContaining(['resume', TV]))
  world.alive.clear()
  world.files.set(`${DIR}/${String(resumed.jobId)}.exit`, '0\n')
  await until($, String(resumed.jobId), ['done', 'error'])
})

test('A: another session\'s job whose Codex is gone with no exit code settles as lost on a look', { ...ON }, async ($, on) => {
  const id = 'cx-f-00002'
  const world = codexWorld(on, { files: { [`${DIR}/${id}.json`]: foreignRecord(id), [`${DIR}/${id}.jsonl`]: line(THREAD) } })
  await $.session.start(START)
  // Not followed at load: it is not this session's.
  expect(world.polls()).toEqual([])
  expect(parsed(await result($, id))).toEqual(expect.objectContaining({ status: 'lost', resumable: true }))
  expect(world.transcript).toEqual([])
})

test('A: a foreign job with no pid yet is starting inside the grace window and stays read-only; past it, it is handled as ended', { ...ON }, async ($, on) => {
  const young = 'cx-f-00003'
  const old = 'cx-f-00004'
  const world = codexWorld(on, {
    files: {
      [`${DIR}/${young}.json`]: foreignRecord(young, { pid: undefined, startedAt: Date.now() }),
      [`${DIR}/${young}.jsonl`]: line(THREAD),
      [`${DIR}/${old}.json`]: foreignRecord(old, { pid: undefined, startedAt: Date.now() - 60_000 }),
      [`${DIR}/${old}.jsonl`]: line(THREAD),
    },
  })
  await $.session.start(START)

  // Inside the window: the worker may not have written its pid yet, so the job is not claimed and cannot be cancelled here.
  expect(parsed(await result($, young))).toEqual(expect.objectContaining({ status: 'running', note: expect.stringContaining('another Claude session') }))
  const cancel = await $.tool.call({ tool: 'mcp__crew__codex_cancel', jobId: young } as never)
  expect(cancel).toEqual(expect.objectContaining({ isError: true, result: expect.stringContaining('still running') }))
  expect(world.polls()).toEqual([])
  expect(world.runs.some(run => run.argv[0] === 'kill')).toBe(false)

  // Past it, with no pid and no exit file: lost, as before.
  expect(parsed(await result($, old))).toEqual(expect.objectContaining({ status: 'lost' }))
})

test('the job record is created private (0600) by the shell before the first host write', { ...ON }, async ($, on) => {
  const world = codexWorld(on)
  const answer = parsed(await call($, { agent: 'code-reader', prompt: 'list files', description: 'list files' }))
  const path = `${DIR}/${String(answer.jobId)}.json`
  const made = world.runs.find(run => run.argv[3] === 'crew-codex-record' && run.argv[4] === path)
  expect(made!.argv[2]).toContain('umask 077')
  expect(made!.argv[2]).toContain('chmod 600')
  // One ordered log: the shell step comes before the first host write of the record.
  const ordered = world.fsCalls.filter(entry => entry === `shell ${path}` || entry === `write ${path}`)
  expect(ordered[0]).toBe(`shell ${path}`)
  expect(ordered).toContain(`write ${path}`)
  expect(world.runs.filter(run => run.argv[3] === 'crew-codex-record' && run.argv[4] === path)).toHaveLength(1)
})

test('a failing shell step leaves the record written, with one log line', { ...ON }, async ($, on) => {
  const world = codexWorld(on, { recordFails: true })
  const answer = parsed(await call($, { agent: 'code-reader', prompt: 'list files', description: 'list files' }))
  const path = `${DIR}/${String(answer.jobId)}.json`
  expect(answer.status).toBe('done')
  expect(JSON.parse(world.files.get(path) ?? '{}')).toEqual(expect.objectContaining({ status: 'done' }))
  expect(world.logs.filter(text => text.includes('not made private'))).toHaveLength(1)
})

test('E: a worker that gave up waiting for its pid ends the job as an error, with no prompt file left and no poll', { ...ON }, async ($, on) => {
  const world = codexWorld(on, { workerFails: true })
  const answer = await call($, { agent: 'developer', prompt: 'secret prompt', description: 'abandoned' })
  expect(answer).toHaveProperty('isError', true)
  expect(String(answer.result)).toContain('did not start')
  const jobId = /cx-[a-z0-9]+-[a-z0-9]+/.exec(String(answer.result))![0]
  expect([...world.files.keys()].filter(path => path.endsWith('.prompt'))).toEqual([])
  expect(world.files.has(`${DIR}/${jobId}.pid.abandoned`)).toBe(true)
  expect(world.polls()).toEqual([])
  expect(world.runs.some(run => run.argv[0] === 'kill')).toBe(false)
  expect(JSON.parse(world.files.get(`${DIR}/${jobId}.json`) ?? '{}')).toEqual(expect.objectContaining({ status: 'error' }))
  expect([...world.files.values()].join('\n')).not.toContain('secret prompt')
})

test('G: the -o lanes leave .crew ignored: .crew/.gitignore is written only when git does not ignore .crew and none is there', { ...ON }, async ($, on) => {
  const world = codexWorld(on)
  await call($, { agent: 'architect', prompt: 'p', description: 'review' })
  expect(world.files.get(`${ROOT}/.crew/.gitignore`)).toBe('*\n')
  expect(world.runs.some(run => run.argv.join(' ') === 'git check-ignore -q .crew' && run.cwd === ROOT)).toBe(true)
  // The root .gitignore is never touched.
  expect(world.fsCalls.some(call => call === `write ${ROOT}/.gitignore`)).toBe(false)

  // A .crew/.gitignore of the project's own stays as it is.
  world.files.set(`${ROOT}/.crew/.gitignore`, 'plans/\n')
  await call($, { agent: 'research', prompt: 'p', description: 'docs' })
  expect(world.files.get(`${ROOT}/.crew/.gitignore`)).toBe('plans/\n')
})

test('G: a project that already ignores .crew gets no .crew/.gitignore, and a lane without -o checks nothing', { ...ON }, async ($, on) => {
  const world = codexWorld(on, { crewIgnored: true })
  await call($, { agent: 'code-reader', prompt: 'p', description: 'look' })
  expect(world.runs.some(run => run.argv[1] === 'check-ignore')).toBe(false)
  await call($, { agent: 'architect', prompt: 'p', description: 'review' })
  expect(world.runs.some(run => run.argv[1] === 'check-ignore')).toBe(true)
  expect(world.files.has(`${ROOT}/.crew/.gitignore`)).toBe(false)
})

test('H: background true returns only once the job record is on disk', { ...ON }, async ($, on) => {
  const world = codexWorld(on, { scenario: { jsonl: line(THREAD) + line({ type: 'turn.started' }) } })
  const jobId = String(parsed(await call($, { agent: 'developer', prompt: 'p', description: 'bg', background: true })).jobId)
  expect(JSON.parse(world.files.get(`${DIR}/${jobId}.json`) ?? '{}')).toEqual(expect.objectContaining({ id: jobId, owner: SESSION }))
  world.alive.clear()
  world.files.set(`${DIR}/${jobId}.exit`, '0\n')
  await until($, jobId, ['done', 'error'])
})
