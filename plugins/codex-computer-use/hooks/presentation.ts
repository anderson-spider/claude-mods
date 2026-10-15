import type { CodexAsking } from '../types'
import type { CallResult, ContentBlock, Failure, ForgetReply, ReleaseReply, ResetReply, SettingsReply, StatusReply } from './model'
import { LEASE_MINUTES } from './routing'

// Everything the model and the person are told: helper replies, the bridge's
// refusals, the `/codex-cu` command texts and the approval band's wording. Pure.

export type ToolAnswer = { result: string | ContentBlock[]; isError?: true }

/** A tool answer that tells the model the call did not happen. */
export const refusal = (text: string) => ({ result: text, isError: true as const })

const withNotes = (text: string, notes: readonly string[] | undefined) =>
  notes === undefined || notes.length === 0 ? text : `${notes.join('\n')}\n\n${text}`

/** The model-facing answer for a `/call` reply that needs no person. */
export const toAnswer = (reply: CallResult): ToolAnswer => {
  switch (reply.status) {
    case 'ok': {
      const blocks = reply.content.filter(block => block.type === 'text' || block.type === 'image')
      const notes = reply.notes ?? []
      const result: ContentBlock[] = notes.length === 0 ? blocks : [{ type: 'text', text: notes.join('\n') }, ...blocks]
      const answer = result.every(block => block.type === 'text') ? result.map(block => block.text ?? '').join('\n') : result

      return reply.isError ? { result: answer, isError: true } : { result: answer }
    }
    case 'denied':
      return {
        result: `The person did not allow Codex computer use to use ${reply.app.displayName} in this session. Do not use ${reply.app.displayName} through any other route; tell the person.`,
        isError: true,
      }
    case 'busy':
      return {
        result:
          `${reply.app.displayName} is in use by another Claude session or subagent (${reply.owner}${typeof reply.idleSeconds === 'number' ? `, last call ${reply.idleSeconds}s ago` : ''}). ` +
          `Work in a different app, or wait and retry: the app is freed ${LEASE_MINUTES} minutes after that caller's last call, or when it resets or ends. Do not take the app over or reach it another way.`,
        isError: true,
      }
    case 'full':
      return { result: `codex-cu: ${reply.message} Retry in a moment.`, isError: true }
    case 'needs_approval':
      return { result: `${reply.app.displayName} needs the person's approval.`, isError: true }
    case 'unreachable':
      return {
        result: withNotes(
          `The codex-cu helper is not running and could not be started. Tell the person to check that the ChatGPT app with Codex computer use is installed, then to install or restart the helper with: ${INSTALL_HELPER}. Do not run it yourself and do not fall back to another desktop-control route.`,
          [reply.message],
        ),
        isError: true,
      }
    case 'error':
      return { result: withNotes(`codex-cu: ${reply.message}`, reply.notes), isError: true }
  }
}

/** What `/codex-cu forget <app>` tells the person. */
export const forgetText = (app: string, reply: ForgetReply | Failure) => {
  if (reply.status !== 'ok' || !('bundleId' in reply)) {
    return `codex-cu: could not forget ${app}: ${'message' in reply ? reply.message : JSON.stringify(reply)}`
  }

  const codex = { removed: 'removed', absent: 'was not there', missing: 'no file found' }[reply.codex ?? 'missing']

  return [
    `codex-cu: ${app} (${reply.bundleId}) is no longer always allowed; its next use asks again.`,
    `  helper list: ${reply.helper === true ? 'removed' : 'was not there'}`,
    `  Codex ComputerUseAppApprovals.json: ${codex}`,
  ].join('\n')
}

/** The one-step helper install (also restarts it), as the plugin README gives it. */
export const INSTALL_HELPER =
  'curl -fsSL https://raw.githubusercontent.com/anderson-spider/claude-mods/main/scripts/bootstrap.sh | sh -s -- --only codex-computer-use'

/** What `/codex-cu status` tells the person. */
export const statusReport = (enabled: boolean, reply: StatusReply | Failure): string => {
  const lines = [`Route: ${enabled ? 'Codex computer use (on)' : "Claude's own computer use (off)"}`]

  if (reply.status === 'unreachable' || reply.status === 'error') {
    lines.push(`Helper: not reachable (${reply.message})`)
    if (reply.status === 'unreachable') lines.push(`Install or restart it: ${INSTALL_HELPER}`)
  } else {
    lines.push(`Helper: ${reply.version ?? '?'} running, ${reply.callers?.length ?? 0} Codex session(s)`)
    lines.push(`Auto-approve: ${reply.settings?.autoApprove === true ? 'on (no questions)' : 'off (asks first)'}`)

    for (const caller of reply.callers ?? []) {
      lines.push(`  ${caller.caller}: ${caller.apps.length === 0 ? 'no apps' : caller.apps.join(', ')}`)
    }
  }

  return lines.join('\n')
}

/** Use minutes to one decimal, or seconds to one decimal for waits under a minute. */
export const approvalWaitText = (ms: number): string => {
  const unit = ms < 60_000 ? 'second' : 'minute'
  const amount = Number((ms / (unit === 'second' ? 1000 : 60_000)).toFixed(1))

  return ` within ${amount} ${unit}${amount === 1 ? '' : 's'}`
}

/** The help and synopsis of each `/codex-cu` usage; hooks/commands.ts lists them. */
export const COMMAND_TEXT = {
  on: { help: '/codex-cu on            use Codex for native apps (default)', synopsis: 'on' },
  off: { help: '/codex-cu off           restore Claude\'s desktop tools', synopsis: 'off' },
  status: { help: '/codex-cu status        show route, helper and app owners', synopsis: 'status' },
  'auto-approve': { help: '/codex-cu auto-approve on|off   skip (on) or ask (off) for new apps', synopsis: 'auto-approve on|off' },
  forget: { help: '/codex-cu forget        clear this session\'s app answers', synopsis: 'forget [app]' },
  'forget-app': { help: '/codex-cu forget <app>  remove always-allow from helper and Codex; ask again' },
} as const

/** The `/codex-cu help` text: one line per usage. */
export const helpText = (lines: readonly string[]) => lines.join('\n')

/** The description `$.command.register` shows: the synopses, in order. */
export const commandDescription = (synopses: readonly string[]) => `Codex computer use: ${synopses.join(' | ')}`

/** What `/codex-cu on` and `/codex-cu off` tell the person. */
export const routeText = (isOn: boolean) =>
  isOn
    ? 'codex-cu on: desktop apps go through Codex computer use; Claude’s own computer use is blocked.'
    : 'codex-cu off: Claude’s own desktop computer use is back; the Codex bridge refuses calls.'

/** What `/codex-cu auto-approve on|off` tells the person. */
export const autoApproveText = (isOn: boolean, reply: SettingsReply | Failure) =>
  reply.status === 'unreachable' || reply.status === 'error'
    ? `codex-cu: could not reach the helper (${reply.message}).`
    : isOn
      ? 'codex-cu auto-approve on: apps are used without asking (organization and safety blocks still apply).'
      : 'codex-cu auto-approve off: a new app asks first.'

/** What `/codex-cu forget` tells the person. */
export const releaseText = (reply: ReleaseReply | Failure) =>
  reply.status === 'ok' ? 'codex-cu: this session’s Codex sessions ended and its app answers were dropped.' : `codex-cu: ${JSON.stringify(reply)}`

/** What the model is told when the bridge is called while the mod is off. */
export const BRIDGE_OFF =
  'codex-computer-use is off (/codex-cu off): use the default desktop route, or ask the person to type /codex-cu on.'

/**
 * What the model is told when Claude's own desktop tool was refused without a check of the switch:
 * the guard ran in place of a hook that could not run (a re-entry), so it cannot say the mod is on.
 */
export const UNCHECKED_OWN =
  "codex-computer-use could not check whether it is on from inside another tool call, so Claude's own desktop tool was refused. Try it again from a normal turn; the person can type /codex-cu off to restore this tool."

/** What the model is told after it asked to reset its Codex session. */
export const resetText = (reply: ResetReply) => reply.message ?? 'reset'

/** What the model is told when the person did not answer an approval question in time or at all. */
export const unansweredText = (displayName: string, outcome: 'aborted' | 'timeout', limitMs: number) =>
  `The person did not answer whether Codex may use ${displayName}${outcome === 'timeout' ? approvalWaitText(limitMs) : ''}; nothing was done with it.`

/** What the model is told when one call kept needing approvals. */
export const TOO_MANY_ROUNDS = 'codex-cu: too many approval rounds for one call.'

/** What the model is told when the bridge itself threw. */
export const bridgeFailedText = (error: unknown) => `codex-cu: the bridge failed: ${error instanceof Error ? error.message : String(error)}`

/** Who the approval question names as the asker. */
export const askerText = (agentId: string | undefined) => (agentId === undefined ? 'main session' : `subagent ${agentId}`)

/** The approval band: heading, sentence, the three buttons and the hint beside them. */
export const askTitle = (now: Pick<CodexAsking, 'displayName'>) => `Codex computer use · Allow “${now.displayName}”?`
export const askBody = (now: Pick<CodexAsking, 'displayName' | 'who'>) =>
  `Asked by the ${now.who}. Codex will see what ${now.displayName} shows and can click and type in it.`
export const ASK_LABELS = { session: 'This session', always: 'Always', deny: 'No' } as const
export const ASK_HINT = '/codex-cu auto-approve on stops asking'
