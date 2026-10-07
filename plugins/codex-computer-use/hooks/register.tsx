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
import { BRIDGE, isOwnDesktopTool, limitMs, parseCommand } from './routing'

type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
type Slot = { id: string; choice: Choice | null }

const PLUGIN = 'codex-computer-use'
const TOOL = `mcp__${PLUGIN}__${BRIDGE}`
const COMMAND = 'codex-cu'
// Waiting inside a `$` call does not use up the hook's time; `$.clock.sleep` would.
const POLL = ['sleep', '0.25']
// How many polls `helper()` makes for the helper launchd was asked to start.
const HELPER_RETRIES = 20
// The `approvalMinutes` setting, refreshed by each register.
let askLimitMs = limitMs(undefined, 5)

const ref = { plugin: 'codex-computer-use', key: 'asking' } as const
const asking = atom(ref, null)

// Reads of `$.state` in a dispatch see a single moment, so the answer the hook
// waits for travels here and the state holds only what the band draws.
let waiting: Slot | undefined

const probe = ($: EngineInterface): Probe => ({
  fetch: (url, init) => $.http.fetch(url, init),
  run: (argv, init) => $.process.run(argv, init),
})

const isEnabled = async ($: EngineInterface) => (await $.store.get('enabled')) !== false

const choose = (choice: Choice) => {
  if (waiting?.choice === null) {
    waiting.choice = choice
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

/** Holds the bridge call until the person answers; never rejects, so a failure is never an approval. */
const ask = async ($: EngineInterface, question: CodexAsking, signal: AbortSignal): Promise<Choice | 'aborted' | 'timeout'> => {
  const slot: Slot = { id: question.id, choice: null }
  const deadline = Date.now() + askLimitMs

  try {
    // One question at a time: a second caller waits for the first to be answered.
    while (waiting !== undefined) {
      if (signal.aborted) {
        return 'aborted'
      }

      await $.process.run(POLL)
    }

    waiting = slot
    await $.state.set(ref, question)

    while (slot.choice === null && !signal.aborted && Date.now() < deadline) {
      await $.process.run(POLL)
    }

    return slot.choice ?? (signal.aborted ? 'aborted' : 'timeout')
  } catch {
    return 'aborted'
  } finally {
    if (waiting === slot) {
      waiting = undefined
      await $.state.set(ref, null).catch(() => undefined)
    }
  }
}

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

export const register: Register = (on, options) => {
  askLimitMs = limitMs(options?.approvalMinutes, 5)

  // A reload in the middle of a question would leave the band stuck.
  on('session.start', async ($, e, next) => {
    waiting = undefined
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

    switch (command.kind) {
      case 'on':
      case 'off':
        // prompt.compose runs at every render, so the next request already sees the switch.
        await $.store.set('enabled', command.kind === 'on')

        return {
          text:
            command.kind === 'on'
              ? 'codex-cu on: desktop apps go through Codex computer use; Claude’s own computer use is blocked.'
              : 'codex-cu off: Claude’s own desktop computer use is back; the Codex bridge refuses calls.',
        }
      case 'auto-approve': {
        const reply = await helper($, ROUTES.settings, { autoApprove: command.isOn })

        return {
          text:
            reply.status === 'unreachable' || reply.status === 'error'
              ? `codex-cu: could not reach the helper (${reply.message}).`
              : command.isOn
                ? 'codex-cu auto-approve on: apps are used without asking (organization and safety blocks still apply).'
                : 'codex-cu auto-approve off: a new app asks first.',
        }
      }
      case 'forget': {
        const caller = callerOf(await $.session.id())
        const reply = await helper($, ROUTES.release, { caller })

        return { text: reply.status === 'ok' ? 'codex-cu: this session’s Codex sessions ended and its app answers were dropped.' : `codex-cu: ${JSON.stringify(reply)}` }
      }
      case 'forget-app': {
        const reply = await helper($, ROUTES.forget, { app: command.app })

        return { text: forgetText(command.app, reply) }
      }
      case 'status':
        return { text: await statusText($) }
      case 'help':
        return { text: HELP }
    }
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
      ask: (question, signal) => ask($, question, signal),
      limitMs: askLimitMs,
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
