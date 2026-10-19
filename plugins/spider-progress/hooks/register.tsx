import { atom, read, update } from 'claude-code'
import type { Hook, McpToolInputs, Register, RenderElement, Timer } from 'claude-code'
import type { SpiderAgent, SpiderMain, SpiderPanel, SpiderPhase, SpiderRun } from '../types'
import { agentEnded, agentStepped, agentsOfRun, answeredModel, resumed, spawned, stepReported } from './agents'
import { bandLines } from './band'
import { configOf } from './config'
import type { SpiderConfig } from './config'
import { langOf, t } from './i18n'
import type { Lang } from './i18n'
import { ZERO, mainUsed } from './metrics'
import { paneLines } from './pane'
import { allOf, type SchemaFor } from './schema'
import { applyProgress, bindWorker, isOver, workerEnded } from './state'
import type { Piece, Style } from './text'
import { briefed, taskIdOf } from './tiers'

type Dollar = Parameters<Hook<'session.start'>>[0]

const runAtom = atom({ plugin: 'spider-progress', key: 'run' } as const, null as SpiderRun | null)
const agentsAtom = atom({ plugin: 'spider-progress', key: 'agents' } as const, [] as SpiderAgent[])
const mainAtom = atom({ plugin: 'spider-progress', key: 'main' } as const, { usage: ZERO } as SpiderMain)
const panelAtom = atom({ plugin: 'spider-progress', key: 'panel' } as const, { open: false, compact: false } as SpiderPanel)
const nowAtom = atom({ plugin: 'spider-progress', key: 'now' } as const, 0)

const PANE = 'spider-agents'
/** The narrowest pane the layout is drawn for; a narrower one truncates it. */
const PANE_MIN_COLUMNS = 20
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
type Held = { config: SpiderConfig; invalid: string[]; lang: Lang; ticker?: Timer; early: Map<string, Ending> }

/** Engine forks end without a spawn too, so only the latest few endings wait for one. */
const EARLY_MAX = 20

/** Theme keys only, so the band and the pane follow the person's Claude Code theme. */
const PAINT: Record<Style, { color?: string; bold?: boolean; dimColor?: boolean }> = {
  plain: {},
  title: { bold: true },
  dim: { dimColor: true },
  accent: { color: 'claude' },
  ok: { color: 'success' },
  warn: { color: 'warning' },
  error: { color: 'error', bold: true },
  bar: { color: 'claude' },
  barEmpty: { color: 'subtle' },
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, ERROR_MAX)

/** One debug line, with the error's message when there is one; reporting never throws. */
function debug($: Dollar, text: string, error?: unknown): void {
  try { $.ui.log(error === undefined ? text : `${text}: ${messageOf(error)}`, { to: 'debug' }) } catch { /* Reporting cannot change the observed result. */ }
}

/** Observation never changes what the host answered: a failure is one debug line. */
async function observe($: Dollar, action: () => Promise<void>): Promise<void> {
  try { await action() } catch (error) {
    debug($, 'spider-progress: observation failed', error)
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

/** Durations and spinners move once a second, only while an agent runs. */
function ensureTicker($: Dollar, held: Held): void {
  if (held.ticker) return
  held.ticker = $.clock.every(1_000, () => void observe($, async () => {
    if (!(await read($, agentsAtom)).some(agent => agent.status === 'running')) return
    const time = await $.clock.now()
    await update($, nowAtom, () => time)
  }))
}

async function reset($: Dollar, held: Held): Promise<void> {
  held.early.clear()
  await update($, runAtom, () => null)
  await update($, agentsAtom, () => [])
  await update($, mainAtom, () => ({ usage: ZERO }))
  await update($, panelAtom, () => ({ open: false, compact: held.config.compactMode }))
}

/** An agent's turn ended: its row ends, and a worker's task moves as its ending says. */
async function endAgent($: Dollar, agentId: string, ending: Ending): Promise<void> {
  await update($, agentsAtom, list => agentEnded(list, agentId, ending.reason, ending.now, ending.usage))
  const taskId = (await read($, agentsAtom)).find(agent => agent.agentId === agentId)?.taskId
  if (taskId) await update($, runAtom, run => (run && !isOver(run) ? workerEnded(run, taskId, agentId, ending.reason === 'answer', `the worker ended: ${ending.reason}`) : run))
}

export const register: Register = (on, options) => {
  const held: Held = { ...configOf((options ?? {}) as Record<string, unknown>), lang: 'en', early: new Map() }

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
      } satisfies SchemaFor<McpToolInputs['mcp__spider-progress__progress']>,
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
      } satisfies SchemaFor<McpToolInputs['mcp__spider-progress__step']>,
    })
    await $.command.register({ name: PANE, description: 'Toggle the spider agents pane (open or close it)', argumentHint: '[open|close]' })
    // Each step on its own, so an unreadable language or state never leaves the session without its clock.
    await observe($, () => readLanguage($, held))
    if (held.invalid.length) debug($, `spider-progress: invalid options fall back to defaults: ${held.invalid.join(', ')}`)
    await observe($, () => reset($, held))
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

  on('tool.call', { tool: 'mcp__spider-progress__progress' }, async ($, e) => {
    if ((e as { agentId?: string }).agentId !== undefined) return { result: 'refused: only the main session reports the run' }
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
      if (isNew && held.config.autoOpen === 'team') await observe($, async () => { await openPane($, held, false) })
      return { result: text }
    } catch (error) {
      debug($, 'spider-progress: progress failed', error)
      return { result: 'error: the run could not be updated; go on with the work' }
    }
  })

  on('tool.call', { tool: 'mcp__spider-progress__step' }, async ($, e) => {
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
      debug($, 'spider-progress: step failed', error)
      return { result: 'error: the step could not be recorded; go on with the work' }
    }
  })

  // A spider-team worker's brief gets the step request appended; every spawned agent is tracked, and one whose brief
  // names a task starts that task. A resume keeps its prompt (the host ignores a rewrite) and runs its agent again.
  // autoOpen any opens the pane when an agent starts with none running, so a pane closed mid-work stays closed.
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
      await update($, agentsAtom, list => {
        idle = !list.some(agent => agent.status === 'running')
        return e.resume && list.some(agent => agent.agentId === agentId) ? resumed(list, agentId, now) : spawned(list, { agentId, type: e.subagentType, model: result.model, prompt: e.prompt, now }, held.config.historyLimit)
      })
      const taskId = taskIdOf(e.prompt)
      if (taskId) await update($, runAtom, run => (run && !isOver(run) ? bindWorker(run, taskId, agentId) : run))
      const early = held.early.get(agentId)
      // An ending heard before this start belongs to an earlier turn of the agent.
      if (early) { held.early.delete(agentId); if (early.now >= now) await endAgent($, agentId, early) }
      if (held.config.autoOpen === 'any' && idle) await openPane($, held, false)
    })
    return result
  }).catch(($, e, next) => {
    debug($, `spider-progress: spawn hook failed: ${next.error.message ?? next.error.kind}`)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const answer = yield* next(e)
    void observe($, async () => {
      const now = await $.clock.now()
      if (e.agentId !== undefined) {
        const agentId = e.agentId
        await update($, agentsAtom, list => agentStepped(list, agentId, { model: e.model, ...(typeof e.effort === 'string' ? { effort: e.effort } : {}), usage: answer.usage }, now))
        return
      }
      const model = answeredModel(answer.usage, e.model)
      await update($, mainAtom, main => mainUsed(main, model, answer.usage))
    })
    return answer
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    void observe($, async () => {
      if (e.agentId === undefined) return readWindow($)
      const agentId = e.agentId
      const ending: Ending = { reason: e.reason, now: await $.clock.now(), usage: (e as { usage?: unknown }).usage }
      if ((await read($, agentsAtom)).some(agent => agent.agentId === agentId && agent.status === 'running')) return endAgent($, agentId, ending)
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
    return { text: t(held.lang).command.usage }
  })

  // Reads prepared atoms only; a survey keeps the band, a failure draws nothing of ours, and what draws beneath stays.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    try {
      const [run, agents, panel, now] = await Promise.all([read($, runAtom), read($, agentsAtom), read($, panelAtom), read($, nowAtom)])
      if (!run || panel.dismissedRunId === run.runId) return below
      const { Box, Text, Button } = $.ui.resolve(e)
      const ours = agentsOfRun(run, agents)
      const running = ours.filter(agent => agent.status === 'running').length
      const lines = bandLines({ run, running, agents: ours.length, columns: e.props.bodyColumns, lang: held.lang, frame: Math.floor(now / 1000), animations: held.config.animations })
      const text = (line: Piece[], key: string) => <Text key={key} wrap="truncate-end">{line.map((piece, i) => <Text key={`${key}-${i}`} {...PAINT[piece.style]}>{piece.text}</Text>)}</Text>
      const dismiss = () => void observe($, async () => { await update($, panelAtom, current => ({ ...current, dismissedRunId: run.runId })) })
      const drawn = <Box flexDirection="column" width={e.props.bodyColumns}>
        {text(lines[0]!, 'title')}
        {text(lines[1]!, 'bar')}
        <Box flexDirection="row">
          {text(lines[2]!, 'status')}
          <Box flexGrow={1} />
          <Button key="spider-pane" plain label={`×${ours.length}`} onPress={() => void observe($, async () => { await togglePane($, held) })} />
          <Text> </Text>
          <Button key="spider-dismiss" plain label="✕" onPress={dismiss} />
        </Box>
      </Box>
      return <Box flexDirection="column">{drawn}{below}</Box>
    } catch (error) {
      debug($, 'spider-progress: band render failed', error)
      return below
    }
  })

  // A failure draws one dim line instead of failing the pane.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    try {
      const [run, agents, main, panel, now] = await Promise.all([read($, runAtom), read($, agentsAtom), read($, mainAtom), read($, panelAtom), read($, nowAtom)])
      const { Box, Text, Button } = $.ui.resolve(e)
      const s = t(held.lang)
      const lines = paneLines({ run, agents, main, config: held.config, compact: panel.compact, columns: Math.max(PANE_MIN_COLUMNS, e.props.bodyColumns), lang: held.lang, now: now || (await $.clock.now()), frame: Math.floor(now / 1000) })
      const flip = () => void observe($, async () => { await update($, panelAtom, current => ({ ...current, compact: !current.compact })) })
      return <Box flexDirection="column">
        <Button key="spider-compact" plain hotkey="c" label={panel.compact ? s.pane.expanded : s.pane.compact} onPress={flip} />
        {lines.map((line, i) => <Text key={`line-${i}`} wrap="truncate-end">{line.length ? line.map((piece, j) => <Text key={`p-${i}-${j}`} {...PAINT[piece.style]}>{piece.text}</Text>) : ' '}</Text>)}
      </Box>
    } catch (error) {
      debug($, 'spider-progress: pane render failed', error)
      return { type: 'Text', props: { dimColor: true }, children: [t(held.lang).na] } satisfies RenderElement
    }
  })
}
