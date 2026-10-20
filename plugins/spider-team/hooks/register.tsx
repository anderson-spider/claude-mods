import { atom, read, update } from 'claude-code'
import type { Hook, McpToolInputs, Register, RenderElement, Timer } from 'claude-code'
import type { SpiderAgent, SpiderMain, SpiderPanel, SpiderPhase, SpiderRun } from '../types'
import { agentEnded, agentStepped, missedEndings, answeredModel, resumed, roleAgents, spawned, stepReported, toolName, toolUsed } from './agents'
import { configOf } from './config'
import type { SpiderConfig } from './config'
import { langOf, t } from './i18n'
import type { Lang } from './i18n'
import { ZERO, mainBusy, mainIdle, mainUsed } from './metrics'
import { terminalLines } from './cards'
import { TIMELINE_MS, paneModel } from './pane'
import { allOf, type SchemaFor } from './schema'
import { applyProgress, bindWorker, isOver, workerEnded } from './state'
import type { Piece, Style } from './text'
import { STATE_SHAPE, pruned, restorable, savedKey, toSave } from './saved'
import { svgOf } from './svg'
import { refusedIn, refusal } from './git-guard'
import { briefed, taskIdOf, tierOf } from './tiers'

type Dollar = Parameters<Hook<'session.start'>>[0]

/** A reload whose code names another shape (hooks/saved.ts) drops what the older code wrote. */
const SHAPED = { shape: STATE_SHAPE }
const runAtom = atom({ plugin: 'spider-team', key: 'run' } as const, null as SpiderRun | null, SHAPED)
const agentsAtom = atom({ plugin: 'spider-team', key: 'agents' } as const, [] as SpiderAgent[], SHAPED)
const mainAtom = atom({ plugin: 'spider-team', key: 'main' } as const, { usage: ZERO } as SpiderMain, SHAPED)
const panelAtom = atom({ plugin: 'spider-team', key: 'panel' } as const, { open: false } as SpiderPanel, SHAPED)
const nowAtom = atom({ plugin: 'spider-team', key: 'now' } as const, 0, SHAPED)

const PANE = 'spider-agents'
/** The narrowest pane the layout is drawn for; a narrower one truncates it. */
const PANE_MIN_COLUMNS = 20
/** The most characters an `Svg` source may hold. */
const SVG_MAX = 131_072
/** How much of an error message a debug line keeps. */
const ERROR_MAX = 200
const PHASES = allOf<SpiderPhase>()('understand', 'plan', 'investigate', 'execute', 'review', 'verify', 'complete', 'cancelled', 'failed')

// Objects, which SchemaFor does not type (their McpToolInputs entries are `unknown`): state.ts checks what arrives.
const TASKS_SCHEMA = {
  description: 'The whole plan. Ids you keep keep their state; dropped ids are cancelled.',
  type: 'array',
  items: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'T1, T2...' },
      title: { type: 'string' },
      owner: { type: 'string', enum: ['main', 'planner', 'worker', 'researcher', 'reviewer'] },
      after: { type: 'array', items: { type: 'string' }, description: 'Ids that must be accepted first.' },
      criteria: { type: 'string', description: 'Acceptance criteria.' },
    },
    required: ['id', 'title', 'owner'],
  },
}

const TASK_SCHEMA = {
  description: 'One task moved: pending, running, reviewing, completed (accepted after review), failed or cancelled.',
  type: 'object',
  properties: {
    id: { type: 'string' },
    state: { type: 'string', enum: ['pending', 'running', 'reviewing', 'completed', 'failed', 'cancelled'] },
    evidence: { type: 'string', description: 'What verified it.' },
    error: { type: 'string', description: 'What went wrong.' },
  },
  required: ['id', 'state'],
}

type Ending = { reason: string; now: number; usage?: unknown }

/** What the module keeps between events: the options, the language, the clock's timer and endings heard before their spawn. */
type Held = { config: SpiderConfig; invalid: string[]; lang: Lang; ticker?: Timer; early: Map<string, Ending>; restoredFor?: string; saving: Promise<void> }

/** Engine forks and untracked agent types end without a tracked spawn too, so only the latest few endings wait for one. */
const EARLY_MAX = 20

/** Theme keys only, so the pane follows the person's Claude Code theme. */
const PAINT: Record<Style, { color?: string; backgroundColor?: string; weight?: 'bold'; dimColor?: boolean }> = {
  plain: {},
  title: { weight: 'bold' },
  dim: { dimColor: true },
  ok: { color: 'success' },
  warn: { color: 'warning' },
  error: { color: 'error', weight: 'bold' },
  bar: { color: 'claude' },
  barEmpty: { color: 'subtle' },
  badge: { color: 'inverseText', backgroundColor: 'claude', weight: 'bold' },
}

/** A piece's paint: its style's, in its tone's colour when it has one. */
const paint = (piece: Piece) => (piece.tone ? { ...PAINT[piece.style], color: piece.tone, dimColor: undefined } : PAINT[piece.style])

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, ERROR_MAX)

/** One debug line, with the error's message when there is one; reporting never throws. */
function debug($: Dollar, text: string, error?: unknown): void {
  try { $.ui.log(error === undefined ? text : `${text}: ${messageOf(error)}`, { to: 'debug' }) } catch { /* Reporting cannot change the observed result. */ }
}

/** Observation never changes what the host answered: a failure is one debug line. */
async function observe($: Dollar, action: () => Promise<void>): Promise<void> {
  try { await action() } catch (error) {
    debug($, 'spider-team: observation failed', error)
  }
}

async function openPane($: Dollar, held: Held, focus: boolean): Promise<string> {
  const opened = await $.ui.open({ id: PANE, title: t(held.lang).pane.title, ...(focus ? { focus: true as const } : {}) })
  return opened.isPlaced ? t(held.lang).command.opened : `${t(held.lang).command.waits} ${opened.reason}`
}

async function closePane($: Dollar, held: Held): Promise<string> {
  await $.ui.close({ id: PANE })
  return t(held.lang).command.closed
}

const isOpen = async ($: Dollar) => (await $.ui.panes()).some(pane => pane.id === PANE)
const togglePane = async ($: Dollar, held: Held) => ((await isOpen($)) ? closePane($, held) : openPane($, held, true))

/** The window Main's context fills, as the host measures it; anything but a positive count leaves it unknown. */
async function readWindow($: Dollar): Promise<void> {
  const window = (await $.session.usage({ breakdown: 'summary' })).context.breakdown?.rawMaxTokens
  if (typeof window === 'number' && window > 0) await update($, mainAtom, main => ({ ...main, contextWindow: window }))
}

async function readLanguage($: Dollar, held: Held): Promise<void> {
  const settings = (await $.settings.read()) as { language?: unknown }
  const [LC_ALL, LC_MESSAGES, LANG] = await Promise.all([$.env.get('LC_ALL'), $.env.get('LC_MESSAGES'), $.env.get('LANG')])
  held.lang = langOf(held.config.language, typeof settings.language === 'string' ? settings.language : undefined, { LC_ALL, LC_MESSAGES, LANG })
}

/** Durations, spinners and the timeline move once a second, only while an agent runs or Main's turn does. */
function ensureTicker($: Dollar, held: Held): void {
  if (held.ticker) return
  held.ticker = $.clock.every(1_000, () => void observe($, async () => {
    const [agents, main] = await Promise.all([read($, agentsAtom), read($, mainAtom)])
    if (!agents.some(agent => agent.status === 'running') && main.busySince === undefined) return
    const time = await $.clock.now()
    await update($, nowAtom, () => time)
  }))
}

/**
 * The open run written to the store under this session, or its entry removed once the run closes or goes. Saves run one
 * after another, each reading the run when its turn comes, so a slow one never writes back a run a later change closed.
 */
function saveRun($: Dollar, held: Held): Promise<void> {
  const save = async () => {
    const [id, run, now] = await Promise.all([$.session.id(), read($, runAtom), $.clock.now()])
    const saved = toSave(run, now)
    if (saved) await $.store.set(savedKey(id), saved)
    else await $.store.delete(savedKey(id))
  }
  held.saving = held.saving.then(save, save)
  return held.saving
}

/**
 * Once per session id: with no run in memory, the open run the store kept for this session (a restarted app, a resumed
 * session) comes back; then stale and surplus entries are pruned.
 */
async function restoreRun($: Dollar, held: Held): Promise<void> {
  const id = await $.session.id()
  if (held.restoredFor === id) return
  const now = await $.clock.now()
  if (!(await read($, runAtom))) {
    const run = restorable(await $.store.get(savedKey(id)), now)
    if (run) await update($, runAtom, current => current ?? run)
  }
  // Marked once read, so a failed read is tried again on the next chance.
  held.restoredFor = id
  const keys = await $.store.keys()
  const entries = await Promise.all(keys.map(async key => [key, await $.store.get(key)] as [string, unknown]))
  for (const key of pruned(entries, now)) await $.store.delete(key)
}

/** `/spider-agents clear`: the run, the agents and Main's usage and turns forgotten, and this session's saved run removed. */
async function clearAll($: Dollar, held: Held): Promise<string> {
  const id = await $.session.id()
  held.early.clear()
  held.restoredFor = id
  await update($, runAtom, () => null)
  await update($, agentsAtom, () => [])
  await update($, mainAtom, () => ({ usage: ZERO }))
  await saveRun($, held)
  return t(held.lang).command.cleared
}

async function reset($: Dollar, held: Held): Promise<void> {
  held.early.clear()
  held.restoredFor = undefined
  await update($, runAtom, () => null)
  await update($, agentsAtom, () => [])
  await update($, mainAtom, () => ({ usage: ZERO }))
  await update($, panelAtom, () => ({ open: false }))
}

/** An agent's turn ended: its row ends, and a worker's task moves as its ending says. */
async function endAgent($: Dollar, held: Held, agentId: string, ending: Ending): Promise<void> {
  await update($, agentsAtom, list => agentEnded(list, agentId, ending.reason, ending.now, ending.usage))
  const taskId = (await read($, agentsAtom)).find(agent => agent.agentId === agentId)?.taskId
  if (taskId) {
    await update($, runAtom, run => (run && !isOver(run) ? workerEnded(run, taskId, agentId, ending.reason === 'answer', `the worker ended: ${ending.reason}`) : run))
    await observe($, () => saveRun($, held))
  }
}

export const register: Register = (on, options) => {
  const held: Held = { ...configOf((options ?? {}) as Record<string, unknown>), lang: 'en', early: new Map(), saving: Promise.resolve() }

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'progress',
      description: 'spider-team only, from the main session: publish the run. A title starts a run; tasks (id T1.., title, owner, after, criteria) replan it; phase moves it; task { id, state, evidence, error } moves one task after your review; finished or cancelled closes it. Each call is applied whole or refused with the reason.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The run title; a title other than the current run\'s starts a new run.' },
          phase: { type: 'string', enum: PHASES, description: 'The phase the run is in now.' },
          tasks: TASKS_SCHEMA,
          task: TASK_SCHEMA,
          finished: { type: 'boolean', description: 'The run is complete.' },
          cancelled: { type: 'boolean', description: 'The run is cancelled; open tasks are cancelled.' },
        },
      } satisfies SchemaFor<McpToolInputs['mcp__spider-team__progress']>,
    })
    await $.tool.register({
      name: 'step',
      description: 'From a subagent only: report your own progress as absolute counts, done 0 with your planned total first, then after each step.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'integer', description: 'Steps finished.' },
          total: { type: 'integer', description: 'Steps planned.' },
          note: { type: 'string', description: 'What you are on, in a few words.' },
        },
        required: ['done', 'total'],
      } satisfies SchemaFor<McpToolInputs['mcp__spider-team__step']>,
    })
    await $.command.register({ name: PANE, description: 'Toggle the spider agents pane (open or close it), or clear what it shows', argumentHint: '[open|close|clear]' })
    // Each step on its own, so an unreadable language or state never leaves the session without its clock.
    await observe($, () => readLanguage($, held))
    if (held.invalid.length) debug($, `spider-team: invalid options fall back to defaults: ${held.invalid.join(', ')}`)
    // It fires again on a reload of the plugin's code, whose state the host keeps: the run goes on, the agent types
    // older code tracked are dropped, and only the endings missed while the code reloaded are settled. A new session
    // starts empty; /clear and resume reset in session.end.
    await observe($, () => restoreRun($, held))
    await observe($, async () => {
      await update($, agentsAtom, roleAgents)
      const now = await $.clock.now()
      for (const missed of missedEndings(await read($, agentsAtom), await $.agent.list())) await endAgent($, held, missed.agentId, { reason: missed.reason, now })
    })
    await observe($, async () => {
      ensureTicker($, held)
      const time = await $.clock.now()
      await update($, nowAtom, () => time)
      await readWindow($)
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // A /clear or a resume goes on in this process with no session.start to start the clock again.
    if (e.reason !== 'clear' && String(e.reason) !== 'resume') {
      held.ticker?.cancel()
      held.ticker = undefined
    }
    await observe($, () => reset($, held))
    return next(e)
  })

  on('tool.call', { tool: 'mcp__spider-team__progress' }, async ($, e) => {
    if ((e as { agentId?: string }).agentId !== undefined) return { result: 'refused: only the main session reports the run' }
    await observe($, () => restoreRun($, held))
    try {
      const now = await $.clock.now()
      let text = ''
      let isNew = false
      await update($, runAtom, current => {
        const applied = applyProgress(current, e as unknown as Record<string, unknown>, { now, newRunId: () => `run-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}` })
        text = applied.text
        isNew = !!applied.run && applied.run.runId !== current?.runId
        return applied.run
      })
      await observe($, () => saveRun($, held))
      if (isNew && held.config.autoOpen === 'team') await observe($, async () => { await openPane($, held, false) })
      return { result: text }
    } catch (error) {
      debug($, 'spider-team: progress failed', error)
      return { result: 'error: the run could not be updated; go on with the work' }
    }
  })

  on('tool.call', { tool: 'mcp__spider-team__step' }, async ($, e) => {
    try {
      const now = await $.clock.now()
      let text = ''
      await update($, agentsAtom, list => {
        const reported = stepReported(list, (e as { agentId?: string }).agentId, e as unknown as Record<string, unknown>, now)
        text = reported.text
        return reported.list
      })
      return { result: text }
    } catch (error) {
      debug($, 'spider-team: step failed', error)
      return { result: 'error: the step could not be recorded; go on with the work' }
    }
  })

  // Every tool a subagent calls through this hook is its activity; the answer goes back unchanged, and a call that
  // throws is not counted. Tools hooks above this one answer never reach it.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const agentId = (e as { agentId?: string }).agentId
    const tool = (e as { tool: string }).tool
    if (agentId !== undefined && toolName(tool)) {
      const failed = result.deny !== undefined || result.isError === true
      void observe($, async () => {
        const now = await $.clock.now()
        await update($, agentsAtom, list => toolUsed(list, agentId, tool, failed, now))
      })
    }
    return result
  })

  // Only Main changes Git state or publishes: a spider-team agent's Bash call that names git, gh or glab outside their
  // read-only forms is refused before it runs. Main's calls and other agents' pass through. The agent's type comes from
  // the spawn this plugin tracked, else from the host's list. A guard that throws would let the tool run, so when the
  // lookup fails any subagent's call is checked the same way.
  const refusalOf = (e: { agentId?: string; command?: unknown }) => e.agentId !== undefined ? refusedIn(String(e.command ?? '')) : undefined
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const agentId = (e as { agentId?: string }).agentId
    const write = refusalOf(e as { agentId?: string; command?: unknown })
    if (agentId === undefined || write === undefined) return next(e)
    const tracked = (await read($, agentsAtom)).find(agent => agent.agentId === agentId)?.type
    const type = tracked ?? (await $.agent.list()).find(agent => agent.id === agentId)?.type
    return tierOf(type) ? { deny: refusal(write) } : next(e)
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    const write = refusalOf(e as { agentId?: string; command?: unknown })
    return write !== undefined ? { deny: refusal(write) } : next(e)
  })

  // A spider-team worker's brief gets the step request appended; every spider-team role agent is tracked, and one whose
  // brief names a task starts that task. Other agent types are left alone: the host reports no ending for some of them,
  // and their rows stayed running for good. A resume keeps its prompt (the host ignores a rewrite) and runs its agent
  // again. autoOpen any opens the pane when a role agent starts with none running, so a pane closed mid-work stays closed.
  on('agent.spawn', async ($, e, next) => {
    // The agent starts when its spawn is asked, not when the host answers; a clock failure is the observation's to log.
    const asked = $.clock.now()
    asked.catch(() => undefined)
    const result = await next(e.resume ? e : { ...e, prompt: briefed(e.prompt, e.subagentType) })
    if (result.deny || result.agentId === undefined) return result
    const agentId = result.agentId
    void observe($, async () => {
      const now = await asked
      let idle = false
      let tracked = false
      await update($, agentsAtom, list => {
        idle = !list.some(agent => agent.status === 'running')
        const after = e.resume && list.some(agent => agent.agentId === agentId) ? resumed(list, agentId, now) : spawned(list, { agentId, type: e.subagentType, model: result.model, prompt: e.prompt, now }, held.config.historyLimit)
        tracked = after.some(agent => agent.agentId === agentId)
        return after
      })
      if (!tracked) { held.early.delete(agentId); return }
      const taskId = taskIdOf(e.prompt)
      if (taskId) {
        await update($, runAtom, run => (run && !isOver(run) ? bindWorker(run, taskId, agentId) : run))
        await observe($, () => saveRun($, held))
      }
      const early = held.early.get(agentId)
      // An ending heard before this start belongs to an earlier turn of the agent.
      if (early) { held.early.delete(agentId); if (early.now >= now) await endAgent($, held, agentId, early) }
      if (held.config.autoOpen === 'any' && idle) await openPane($, held, false)
    })
    return result
  }).catch(($, e, next) => {
    debug($, `spider-team: spawn hook failed: ${next.error.message ?? next.error.kind}`)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // Main's turn is busy from when its request is asked; a clock failure is the observation's to log.
    const asked = $.clock.now()
    asked.catch(() => undefined)
    const answer = yield* next(e)
    void observe($, async () => {
      const now = await $.clock.now()
      if (e.agentId !== undefined) {
        const agentId = e.agentId
        await update($, agentsAtom, list => agentStepped(list, agentId, { model: e.model, ...(typeof e.effort === 'string' ? { effort: e.effort } : {}), usage: answer.usage }, now))
        return
      }
      const model = answeredModel(answer.usage, e.model)
      const effort = typeof e.effort === 'string' ? e.effort : undefined
      const since = await asked
      await update($, mainAtom, main => mainBusy(mainUsed(main, model, answer.usage), since, effort))
    })
    return answer
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    void observe($, async () => {
      if (e.agentId === undefined) {
        const now = await $.clock.now()
        await update($, mainAtom, main => mainIdle(main, now, now - TIMELINE_MS))
        await update($, nowAtom, () => now)
        await readWindow($)
        // A resume in this process fires no session.start: Main's first turn under the new id brings its run back.
        return restoreRun($, held)
      }
      const agentId = e.agentId
      const ending: Ending = { reason: e.reason, now: await $.clock.now(), usage: (e as { usage?: unknown }).usage }
      if ((await read($, agentsAtom)).some(agent => agent.agentId === agentId && agent.status === 'running')) return endAgent($, held, agentId, ending)
      // The spawn is recorded after the host answers it, so a quick failure can end the agent first, and a resumed agent
      // can end while its row still reads as ended: the spawn's observation applies the ending once the row runs.
      held.early.set(agentId, ending)
      for (const id of held.early.keys()) if (held.early.size > EARLY_MAX) held.early.delete(id)
    })
    return result
  })

  on('command.run', { command: PANE }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === '') return { text: await togglePane($, held) }
    if (arg === 'open') return { text: await openPane($, held, true) }
    if (arg === 'close') return { text: await closePane($, held) }
    if (arg === 'clear') return { text: await clearAll($, held) }
    return { text: t(held.lang).command.usage }
  })

  // A failure draws one dim line instead of failing the pane.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    try {
      const [run, agents, main, now] = await Promise.all([read($, runAtom), read($, agentsAtom), read($, mainAtom), read($, nowAtom)])
      const ui = $.ui.resolve(e)
      const { Box, Text } = ui
      const columns = Math.max(PANE_MIN_COLUMNS, e.props.bodyColumns)
      const model = paneModel({ run, agents, main, config: held.config, columns, lang: held.lang, now: now || (await $.clock.now()), frame: Math.floor(now / 1000), rows: e.props.scroll.bodyRows })
      // Lines are laid out in cells (the borders, the plan's tree, the timeline's buckets): `mono` keeps them aligned
      // on a surface whose body font is proportional, as the desktop's is; the terminal ignores it.
      const text = (line: Piece[], key: string) => <Text key={key} mono wrap="truncate-end">{line.length ? line.map((piece, i) => <Text key={`${key}-${i}`} {...paint(piece)}>{piece.text}</Text>) : ' '}</Text>
      // Only a graphical surface draws the cards as a picture; the terminal, which has no `Svg`, draws them as lines.
      if (e.surface === 'terminal' || !('Svg' in ui)) return <Box flexDirection="column" width={columns}>{terminalLines(model, columns).map((line, i) => text(line, `line-${i}`))}</Box>
      const drawing = svgOf(model, columns)
      // A drawing past the host's limit falls back to the terminal's lines.
      if (drawing.source.length > SVG_MAX) return <Box flexDirection="column" width={columns}>{terminalLines(model, columns).map((line, i) => text(line, `line-${i}`))}</Box>
      return <Box flexDirection="column" width={columns} gap={1}>
        {text(model.header, 'header')}
        <ui.Svg key="cards" source={drawing.source} alt={t(held.lang).pane.title} {...(drawing.moving ? { isInteractive: true } : {})} />
        {text(model.footer, 'footer')}
      </Box>
    } catch (error) {
      debug($, 'spider-team: pane render failed', error)
      return { type: 'Text', props: { dimColor: true }, children: [t(held.lang).na] } satisfies RenderElement
    }
  })
}
