import { atom, read } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement } from 'claude-code'

import type { CodexAsking } from '../types'
import { serve } from './bridge'
import type { BridgeInput } from './bridge'
import { callerOf, kickstart, post, socketOf } from './helper'
import type { Probe } from './helper'
import { ROUTES } from './model'
import type { Choice, Failure, Reply, StatusReply } from './model'
import { forgetText, statusReport } from './presentation'
import { DESCRIPTION, HELP, INPUT_SCHEMA, PROMPT, denyOwn } from './prompts'
import { holdQuestion } from './question'
import type { QuestionHost, Waiting } from './question'
import { APPROVAL_MS, BRIDGE, isOwnDesktopTool, parseCommand } from './routing'
import type { Command } from './routing'

type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
type Handlers = { [K in Command['kind']]: (command: Extract<Command, { kind: K }>) => Promise<{ text: string }> }

const PLUGIN = 'codex-computer-use'
const TOOL = `mcp__${PLUGIN}__${BRIDGE}`
const COMMAND = 'codex-cu'
// Waiting inside a `$` call does not use up the hook's time; `$.clock.sleep` would.
const POLL = ['sleep', '0.25']
// How many polls `helper()` makes for the helper launchd was asked to start.
const HELPER_RETRIES = 20

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
const helper = async ($: EngineInterface, route: string, body: unknown): Promise<Reply> => {
  const host = probe($)
  const socket = socketOf((await $.env.get('HOME')) ?? '')
  const first = await post(host, socket, route, body)

  if (first.status !== 'unreachable' || !(await kickstart(host))) {
    return first
  }

  for (let i = 0; i < HELPER_RETRIES; i++) {
    await $.process.run(POLL)
    const again = await post(host, socket, route, body)

    if (again.status !== 'unreachable') {
      return again
    }
  }

  return first
}

const questionHost = ($: EngineInterface): QuestionHost => ({
  now: () => $.clock.now(),
  wait: () => $.process.run(POLL),
  show: question => $.state.set(ref, question),
})

const draw = ({ Box, Text, Button }: Kit, now: CodexAsking): RenderElement => (
  <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
    <Text bold color="suggestion">
      Codex computer use · Allow “{now.displayName}”?
    </Text>
    <Text dimColor wrap="truncate-end">
      {`Asked by the ${now.who}. Codex will see what ${now.displayName} shows and can click and type in it.`}
    </Text>
    <Box marginTop={1} gap={2}>
      <Button key="session" label="This session" hotkey="1" plain onPress={() => choose('session')} />
      {now.canAlways && <Button key="always" label="Always" hotkey="2" plain onPress={() => choose('always')} />}
      <Button key="deny" label="No" hotkey="3" plain autoFocus onPress={() => choose('deny')} />
      <Text dimColor>/codex-cu auto-approve on stops asking</Text>
    </Box>
  </Box>
)

const statusText = async ($: EngineInterface) => {
  const enabled = await isEnabled($)
  // `/status` answers the helper's own report, or a failure.
  const reply = (await helper($, ROUTES.status, {})) as StatusReply | Failure

  return statusReport(enabled, reply)
}

// prompt.compose runs at every render, so the next request already sees the switch.
const turn = async ($: EngineInterface, isOn: boolean, text: string) => {
  await $.store.set('enabled', isOn)

  return { text }
}

// One handler per command kind. `$` is only closed over: the engine rejects it as an argument to a computed call.
const commandsOf = ($: EngineInterface): Handlers => ({
  on: () => turn($, true, 'codex-cu on: desktop apps go through Codex computer use; Claude’s own computer use is blocked.'),
  off: () => turn($, false, 'codex-cu off: Claude’s own desktop computer use is back; the Codex bridge refuses calls.'),
  'auto-approve': async command => {
    const reply = await helper($, ROUTES.settings, { autoApprove: command.isOn })

    return {
      text:
        reply.status === 'unreachable' || reply.status === 'error'
          ? `codex-cu: could not reach the helper (${reply.message}).`
          : command.isOn
            ? 'codex-cu auto-approve on: apps are used without asking (organization and safety blocks still apply).'
            : 'codex-cu auto-approve off: a new app asks first.',
    }
  },
  forget: async () => {
    const caller = callerOf(await $.session.id())
    const reply = await helper($, ROUTES.release, { caller })

    return { text: reply.status === 'ok' ? 'codex-cu: this session’s Codex sessions ended and its app answers were dropped.' : `codex-cu: ${JSON.stringify(reply)}` }
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

export const register: Register = on => {
  // A reload in the middle of a question would leave the band stuck.
  on('session.start', async ($, e, next) => {
    waiting.current = undefined
    await $.state.set(ref, null)
    const started = await next(e)
    await $.tool.register({ name: BRIDGE, description: DESCRIPTION, inputSchema: INPUT_SCHEMA })
    await $.command.register({ name: COMMAND, description: 'Codex computer use: on | off | status | auto-approve on|off | forget [app]' })

    return started
  })

  on('session.end', async ($, e, next) => {
    await helper($, ROUTES.release, { caller: callerOf(e.sessionId) }).catch(() => undefined)

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

    // Fails closed: when the switch cannot be read, the own tool stays blocked.
    const enabled = await isEnabled($).catch(() => true)

    return enabled ? { deny: denyOwn(TOOL) } : next(e)
  })

  on('tool.call', { tool: TOOL }, ($, e, next) =>
    serve({
      enabled: () => isEnabled($),
      sessionId: () => $.session.id(),
      helper: (route, body) => helper($, route, body),
      ask: (question, signal) => holdQuestion(questionHost($), waiting, APPROVAL_MS, question, signal),
      limitMs: APPROVAL_MS,
    }, e as unknown as BridgeInput, next.signal).catch((error: unknown) => ({
      result: `codex-cu: the bridge failed: ${error instanceof Error ? error.message : String(error)}`,
      isError: true as const,
    })),
  )

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, asking)

    if (now === null || e.props.hasSurvey) {
      return next(e)
    }

    return draw($.ui.resolve(e), now)
  })
}
