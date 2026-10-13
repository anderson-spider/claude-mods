import { atom, read } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement } from 'claude-code'

import type { CodexAsking } from '../types'
import { serve } from './bridge'
import { COMMAND_DESCRIPTION, HELP, parseCommand } from './commands'
import type { Command } from './commands'
import { POLL, callerOf, post, postStarting, socketOf } from './helper'
import type { Probe } from './helper'
import { ROUTES } from './model'
import type { Choice, Route, RouteReplies } from './model'
import { ASK_HINT, ASK_LABELS, askBody, askTitle, autoApproveText, bridgeFailedText, forgetText, refusal, releaseText, routeText, statusReport } from './presentation'
import { DESCRIPTION, INPUT_SCHEMA, PROMPT, denyOwn } from './prompts'
import { holdQuestion } from './question'
import type { QuestionHost, Waiting } from './question'
import { APPROVAL_MS, BRIDGE, TOOL, isOwnDesktopTool } from './routing'

type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
type Handlers = { [K in Command['kind']]: (command: Extract<Command, { kind: K }>) => Promise<{ text: string }> }

const PLUGIN = 'codex-computer-use'
const COMMAND = 'codex-cu'

const ref = { plugin: 'codex-computer-use', key: 'asking' } as const
const asking = atom(ref, null)

// Reads of `$.state` in a dispatch see a single moment, so the answer the hook
// waits for travels here and the state holds only what the band draws.
const waiting: Waiting = { current: undefined }

const probe = ($: EngineInterface): Probe => ({
  fetch: (url, init) => $.http.fetch(url, init),
  run: (argv, init) => $.process.run(argv, init),
})

const isEnabled = async ($: EngineInterface) => (await $.store.get('enabled')) !== false

const choose = (choice: Choice) => {
  if (waiting.current?.choice === null) {
    waiting.current.choice = choice
  }
}

/** Sends to the helper, starting it through launchd once if nothing listens. */
const helper = async <R extends Route>($: EngineInterface, route: R, body: unknown): Promise<RouteReplies[R]> =>
  postStarting(probe($), socketOf((await $.env.get('HOME')) ?? ''), route, body)

/** The release at session end: `post` never rejects, and a probe or home read that does is swallowed. */
const releaseOnce = async ($: EngineInterface, caller: string) => {
  try {
    await post(probe($), socketOf((await $.env.get('HOME')) ?? ''), ROUTES.release, { caller })
  } catch {
    // Nothing to do at exit.
  }
}

const questionHost = ($: EngineInterface): QuestionHost => ({
  now: () => $.clock.now(),
  wait: () => $.process.run(POLL),
  show: question => $.state.set(ref, question),
})

const draw = ({ Box, Text, Button }: Kit, now: CodexAsking): RenderElement => (
  <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
    <Text bold color="suggestion">
      {askTitle(now)}
    </Text>
    <Text dimColor wrap="truncate-end">
      {askBody(now)}
    </Text>
    <Box marginTop={1} gap={2}>
      <Button key="session" label={ASK_LABELS.session} hotkey="1" plain onPress={() => choose('session')} />
      {now.canAlways && <Button key="always" label={ASK_LABELS.always} hotkey="2" plain onPress={() => choose('always')} />}
      <Button key="deny" label={ASK_LABELS.deny} hotkey="3" plain autoFocus onPress={() => choose('deny')} />
      <Text dimColor>{ASK_HINT}</Text>
    </Box>
  </Box>
)

const statusText = async ($: EngineInterface) => {
  const enabled = await isEnabled($)
  const reply = await helper($, ROUTES.status, {})

  return statusReport(enabled, reply)
}

// prompt.compose runs at every render, so the next request already sees the switch.
const turn = async ($: EngineInterface, isOn: boolean, text: string) => {
  await $.store.set('enabled', isOn)

  return { text }
}

// One handler per command kind. `$` is only closed over: the engine rejects it as an argument to a computed call.
const commandsOf = ($: EngineInterface): Handlers => ({
  on: () => turn($, true, routeText(true)),
  off: () => turn($, false, routeText(false)),
  'auto-approve': async command => {
    const reply = await helper($, ROUTES.settings, { autoApprove: command.isOn })

    return { text: autoApproveText(command.isOn, reply) }
  },
  forget: async () => {
    const caller = callerOf(await $.session.id())
    const reply = await helper($, ROUTES.release, { caller })

    return { text: releaseText(reply) }
  },
  'forget-app': async command => {
    const reply = await helper($, ROUTES.forget, { app: command.app })

    return { text: forgetText(command.app, reply) }
  },
  status: async () => ({ text: await statusText($) }),
  help: async () => ({ text: HELP }),
})

/** Runs the handler for the command's kind; the generic ties each kind to its own command shape. */
const runCommand = <K extends Command['kind']>(handlers: Handlers, kind: K, command: Extract<Command, { kind: K }>) => handlers[kind](command)

/**
 * The guard's `.catch`: a hook that fails is skipped and the own desktop tool would run while the mod is on.
 * It has no matcher, so it sees every tool and re-checks. Named at top level so tests reach it.
 */
export function holdOwnDesktop<E extends { tool: string }, R>(_$: EngineInterface, e: E, next: ((e: E) => Promise<R>) & { called: boolean }) {
  if (next.called || e.tool === TOOL || !isOwnDesktopTool(e.tool)) {
    return next(e)
  }

  return { deny: denyOwn(TOOL) }
}

export const register: Register = on => {
  // A reload in the middle of a question would leave the band stuck.
  on('session.start', async ($, e, next) => {
    waiting.current = undefined
    await $.state.set(ref, null)
    const started = await next(e)
    await $.tool.register({ name: BRIDGE, description: DESCRIPTION, inputSchema: INPUT_SCHEMA })
    await $.command.register({ name: COMMAND, description: COMMAND_DESCRIPTION })

    return started
  })

  on('session.end', async ($, e, next) => {
    // One post, no kickstart or retry: session.end shares a 1.5 s budget, and a helper that is not running holds no session to release.
    await releaseOnce($, callerOf(e.sessionId))

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const command = parseCommand(e.args)

    return runCommand(commandsOf($), command.kind, command)
  })

  // The bridge is explained only while it is the route.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    if (!(await isEnabled($))) {
      return composed
    }

    return { sections: [...composed.sections, { id: `${PLUGIN}:route`, text: PROMPT(TOOL), scope: 'session' as const }] }
  })

  // Claude's own desktop control is refused while the mod is on, so a failing bridge cannot fall back silently.
  on('tool.call', async ($, e, next) => {
    if (e.tool === TOOL || !isOwnDesktopTool(e.tool)) {
      return next(e)
    }

    // A failed read of the switch fails the hook; its `.catch` below keeps the own tool blocked.
    return (await isEnabled($)) ? { deny: denyOwn(TOOL) } : next(e)
  }).catch(holdOwnDesktop)

  // The matcher stays a literal for the host's source analysis; tests/contract.test.ts pins it to TOOL.
  on('tool.call', { tool: 'mcp__codex-computer-use__codex_cu' }, ($, e, next) =>
    serve({
      enabled: () => isEnabled($),
      sessionId: () => $.session.id(),
      helper: (route, body) => helper($, route, body),
      ask: (question, signal) => holdQuestion(questionHost($), waiting, APPROVAL_MS, question, signal),
      limitMs: APPROVAL_MS,
    }, e, next.signal).catch((error: unknown) => refusal(bridgeFailedText(error))),
  )

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, asking)

    if (now === null || e.props.hasSurvey) {
      return next(e)
    }

    return draw($.ui.resolve(e), now)
  })
}
