import { expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { createPaneLayout } from '../hooks/pane-layout'
import type { AgentState, Deps, Herdr, Job, Request, Settled, Loop, Run } from '../hooks/model'
import { createBook } from '../hooks/book'
import { herdrOf } from '../hooks/herdr'
import type { BandJob } from '../types'

export type Script = { prompt?: (Settled | Error)[]; wait?: (AgentState | Error)[]; start?: Error; rename?: Error; close?: Error; split?: (string | Error)[]; splitGate?: Promise<void>; read?: string; onPrompt?: () => void; live?: string[]; gate?: Promise<void> }

export function fakeHerdr(script: Script) {
  const calls: string[] = []
  const prompts = [...(script.prompt ?? [])]
  const waits = [...(script.wait ?? [])]
  const splits = [...(script.split ?? [])]
  let panes = 1
  const pop = <T>(queue: (T | Error)[], fallback: T): T => {
    const next = queue.length ? queue.shift()! : fallback
    if (next instanceof Error) throw next
    return next
  }
  const herdr: Herdr = {
    split: async (direction, target) => {
      calls.push(`split ${direction}${target ? ` ${target}` : ''}`)
      await script.splitGate
      return pop(splits, `w1:p${++panes}`)
    },
    rename: async (pane, name) => {
      calls.push(`rename ${pane} ${name}`)
      if (script.rename) throw script.rename
    },
    close: async pane => {
      calls.push(`close ${pane}`)
      if (script.close) throw script.close
    },
    start: async (name, pane, args) => {
      calls.push(`start ${name} ${pane} ${args.join(' ')}`)
      if (script.start) throw script.start
    },
    prompt: async (name, text) => {
      calls.push(`prompt ${name}`)
      script.onPrompt?.()
      await script.gate
      return pop<Settled>(prompts, 'idle')
    },
    wait: async (name, _timeoutMs, until) => {
      calls.push(`wait ${name}${until ? ` until ${until.join('|')}` : ''}`)
      return pop<AgentState>(waits, 'idle')
    },
    read: async () => {
      calls.push('read')
      return script.read ?? 'pane text'
    },
    sendKeys: async (name, keys) => {
      calls.push(`keys ${name} ${keys.join(' ')}`)
    },
    submit: async (name, text) => {
      calls.push(`submit ${name} ${text}`)
    },
    list: async () => (script.live ?? []).map(name => ({ name, pane: 'w9:p9' })),
  }
  return { herdr, calls }
}

export const job = (kind: 'execute' | 'review' = 'execute', id = 1): Job => ({ id, kind, title: 't', status: 'queued', agent: `ct-${id}`, startedAt: 0 })
export const request = (kind: 'execute' | 'review' = 'execute'): Request => ({ kind, task: 'do it', files: [] })

export function setup(script: Script, files: Record<string, string> = { '/tmp/codex-team/1.md': '# Report\nall done' }) {
  const { herdr, calls } = fakeHerdr(script)
  const events: string[] = []
  let clock = 0
  const deps: Deps = {
    herdr,
    layout: createPaneLayout(),
    files: { read: async path => files[path], write: async () => {} },
    tmpdir: undefined,
    now: () => clock,
    notify: (event, j) => events.push(`${event} ${j.status}`),
  }
  return { deps, calls, events, advance: (ms: number) => (clock += ms) }
}

declare const setTimeout: (fn: () => void, ms: number) => unknown
export const pause = (ms: number) => new Promise<void>(done => setTimeout(() => done(), ms))
export const over = (j: Job) => ['done', 'failed', 'cancelled'].includes(j.status)
export const settled = async (...jobs: Job[]) => {
  for (let i = 0; i < 100 && !jobs.every(over); i++) await pause(1)
}

export function bookWith(script: Script) {
  const { herdr, calls } = fakeHerdr(script)
  const events: string[] = []
  const book = createBook({
    herdr,
    layout: createPaneLayout(),
    files: { read: async () => 'report text', write: async () => {} },
    tmpdir: undefined,
    now: () => 0,
    notify: (event, j) => events.push(`${event} ${j.agent} ${j.status}`),
  })
  return { book, calls, events, herdr }
}

export function loopWith(reports: (string | undefined)[], script: Script = {}, gates: Record<number, Promise<void>> = {}) {
  const { herdr, calls } = fakeHerdr(script)
  const files: Record<string, string> = {}
  const prompts: string[] = []
  const events: string[] = []
  const prompt = herdr.prompt
  herdr.prompt = async (name, text, timeout) => {
    const index = prompts.length
    prompts.push(text)
    const report = reports[index]
    if (report !== undefined) files[text.match(/write your final report as Markdown to (.+) and answer/)![1]!] = report
    await gates[index]
    return prompt(name, text, timeout)
  }
  const deps = {
    herdr,
    layout: createPaneLayout(),
    files: { read: async (path: string) => files[path], write: async (path: string, text: string) => { files[path] = text } },
    tmpdir: undefined,
    now: () => 0,
    notify: (event: 'blocked' | 'finished', loop: Loop, job?: Job) => { events.push(event === 'blocked' ? `blocked ${job!.agent}` : `loop ${loop.id} ${loop.status}`) },
  }
  const book = createBook({ ...deps, notify: (event, job) => { events.push(`${event} ${job.agent}`) } })
  const finished = async (loop: Loop) => {
    for (let i = 0; i < 100 && !events.some(event => event.startsWith(`loop ${loop.id} `)); i++) await pause(1)
    expect(events.some(event => event.startsWith(`loop ${loop.id} `))).toBe(true)
  }
  return { deps, book, calls, files, prompts, events, finished }
}

export const loopRequest = (maxRounds = 3) => ({ task: 'add X', files: ['a.ts'], maxRounds })

export type Answer = { exitCode?: number; stdout?: string; stderr?: string }

// A fake `run` that records argv and answers by the herdr subcommand ("pane split", "agent wait", …).
export function fakeRun(answers: Record<string, Answer>) {
  const argvs: string[][] = []
  const timeouts: (number | undefined)[] = []
  const run: Run = async (argv, init) => {
    argvs.push(argv)
    timeouts.push(init?.timeoutMs)
    const key = argv[0] === 'herdr' && argv.length > 2 ? `${argv[1]} ${argv[2]}` : argv[0]!
    const answer = answers[key] ?? { stdout: '{}' }
    return { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
  }
  return { run, argvs, timeouts }
}

export const agent = (status: string) => JSON.stringify({ result: { agent: { agent_status: status, name: 'ct-1', pane_id: 'w1:p2' } } })
export const adapter = (answers: Record<string, Answer>) => {
  const fake = fakeRun(answers)
  return { ...fake, herdr: herdrOf(fake.run, { pane: 'w1:p1', cwd: '/proj' }) }
}

export const band = (id: string, status: BandJob['status'], elapsedSeconds: number, pane = 'w1:p2'): BandJob => ({ id, kind: 'execute', status, pane, elapsedSeconds })

// --- Tool wiring against the engine, with no host processes or files ---

export function loopHost(on: On, gate?: Promise<void>, script: Script = {}) {
  const promptStates = [...(script.prompt ?? [])]
  const waitStates = [...(script.wait ?? [])]
  const clock = mock.clock(on)
  mock.env(on, { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', TMPDIR: '/tmp' })
  const tools: Record<string, unknown> = {}
  const files: Record<string, string> = {}
  const messages: string[] = []
  const argvs: string[][] = []
  let rows: BandJob[] = []
  let version = 0
  let prompts = 0
  let panes = 1
  on('tool.register', (_$, e) => { tools[e.name] = e.inputSchema; return { value: { tool: `mcp__codex-team__${e.name}` } } })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('state.get', () => ({ value: { value: rows, version } }))
  on('state.set', (_$, e) => { rows = e.value as BandJob[]; return { value: { isSet: true as const, version: ++version } } })
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_$, e) => { messages.push(e.text); return { text: e.text } })
  on('fs.read', (_$, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_$, e) => { files[e.path] = e.text; return { value: undefined } })
  on('process.run', async (_$, e) => {
    argvs.push([...e.argv])
    const argv = e.argv
    let stdout = '{}'
    if (argv[1] === '--version') stdout = 'installed'
    if (argv[1] === 'pane' && argv[2] === 'split') stdout = JSON.stringify({ result: { pane: { pane_id: `w1:p${++panes}` } } })
    if (argv[1] === 'agent' && argv[2] === 'list') stdout = JSON.stringify({ result: { agents: [] } })
    if (argv[1] === 'agent' && argv[2] === 'prompt' && argv[4] !== '/stop') {
      const index = prompts++
      files[argv[4]!.match(/write your final report as Markdown to (.+) and answer/)![1]!] = index === 0 ? 'dev report' : 'VERDICT: APPROVED'
      if (index === 1) await gate
      stdout = agent(String(promptStates.shift() ?? 'done'))
    }
    if (argv[1] === 'agent' && argv[2] === 'wait') stdout = agent(String(waitStates.shift() ?? 'idle'))
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  return { tools, files, messages, argvs, clock, rows: () => rows, prompts: () => prompts }
}

export const startSession = ($: Engine) => $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
