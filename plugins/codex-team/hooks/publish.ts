// Publish the newest plan only after the installed validator admits the complete candidate.
import { buildDagr } from './dagr'
import type { Times } from './dagr'
import { parsePlan, PlanError } from './plan'
import { listAgents } from './herdr'
import { logicalName } from './names'
import type { Run } from './herdr'

export type PublishIo = {
  env: () => Promise<{ HERDR_ENV?: string; HERDR_PANE_ID?: string; HERDR_WORKSPACE_ID?: string; DAGR_BIN?: string; HOME?: string }>
  run: Run
  list: (path: string) => Promise<readonly { name: string; kind: string; mtimeMs: number; isLink?: boolean }[]>
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  now: () => Promise<number>
  log: (text: string) => void
}

let missingDagrLogged = false

/** Probe argv directly so an override or installed path containing spaces stays intact. */
async function resolveDagr(io: PublishIo, env: Awaited<ReturnType<PublishIo['env']>>): Promise<string | undefined> {
  const available = async (binary: string): Promise<boolean> => (await io.run([binary, '--version']).catch(() => undefined))?.exitCode === 0
  if (env.DAGR_BIN && await available(env.DAGR_BIN)) return env.DAGR_BIN
  if (await available('dagr')) return 'dagr'
  if (!env.HOME?.startsWith('/')) return undefined
  const dir = `${env.HOME.replace(/\/+$/, '')}/.config/herdr/plugins/github`
  const entries = await io.list(dir).catch(() => [])
  for (const entry of entries.filter(entry => /^herdr-dagr-[^/]+$/.test(entry.name) && (entry.kind === 'dir' || entry.isLink))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const binary = `${dir}/${entry.name}/bin/dagr`
    if (await available(binary)) return binary
  }
  return undefined
}

/** Serializes candidates sharing run.json.tmp; failures never poison the next publication. */
export function createPublisher() {
  const pending = new Map<string, Promise<void>>()
  return async (io: PublishIo, root: string): Promise<void> => {
    const previous = pending.get(root) ?? Promise.resolve()
    const next = previous.then(() => publishDagr(io, root))
    pending.set(root, next)
    try { await next } finally { if (pending.get(root) === next) pending.delete(root) }
  }
}

export async function publishDagr(io: PublishIo, root: string): Promise<void> {
  let failure = 'publication failed'
  try {
    const env = await io.env()
    if (env.HERDR_ENV !== '1') return
    const binary = await resolveDagr(io, env)
    if (!binary) {
      if (!missingDagrLogged) {
        missingDagrLogged = true
        io.log('codex-team: dagr not found; set DAGR_BIN or install dagr')
      }
      return
    }
    const dir = `${root.replace(/\/+$/, '')}/.crew/plans`
    if (!await io.exists(dir)) return
    const entries = await io.list(dir)
    const active = entries.filter(entry => entry.kind === 'file' && !entry.isLink && entry.name.endsWith('.md'))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))[0]
    if (!active) return
    const plan = parsePlan(await io.read(`${dir}/${active.name}`), active.name.slice(0, -3))
    const out = `${root.replace(/\/+$/, '')}/.dagr/run.json`
    const timesPath = `${root.replace(/\/+$/, '')}/.dagr/times.json`
    const rawTimes = await io.exists(timesPath) ? await io.read(timesPath) : undefined
    let times: Times = {}
    if (rawTimes !== undefined) {
      const parsed: unknown = JSON.parse(rawTimes)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.values(parsed).some(value => typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) throw new Error()
      times = parsed as Times
    }
    const agents = await listAgents(io.run)
    if (typeof agents === 'string') throw new Error()
    const built = buildDagr(plan, times, { now: new Date(await io.now()).toISOString(), agents: agents.filter(agent => agent.workspace_id === env.HERDR_WORKSPACE_ID)
      .map(agent => ({ ...agent, name: logicalName(agent.name, env.HERDR_WORKSPACE_ID!) })), pane: env.HERDR_PANE_ID })
    await io.write(`${out}.tmp`, `${JSON.stringify(built.document, null, 2)}\n`)
    const check = await io.run([binary, 'check', `${out}.tmp`, '--strict', '--json'])
    failure = 'validation failed'
    if (check.exitCode !== 0 || check.isStdoutTruncated) throw new Error()
    const findings: unknown = JSON.parse(check.stdout)
    if (!Array.isArray(findings) || findings.length !== 0) throw new Error()
    failure = 'publication failed'
    // Persist observations before publishing: even a failed rename retains their first-seen times.
    await io.write(timesPath, `${JSON.stringify(built.times)}\n`)
    const moved = await io.run(['mv', `${out}.tmp`, out])
    if (moved.exitCode !== 0) throw new Error()
  } catch (error) {
    io.log(`codex-team: dagr not published (${error instanceof PlanError ? error.message : failure})`)
  }
}

/** Only successful plan Write/Edit calls trigger a refresh; normalize relative paths against the session root. */
export function isPlanFile(path: string, root: string): boolean {
  const absolute = path.startsWith('/') ? path : `${root}/${path}`
  const parts: string[] = []
  for (const part of absolute.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return `/${parts.join('/')}`.startsWith(`${root.replace(/\/+$/, '')}/.crew/plans/`)
}
