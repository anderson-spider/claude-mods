import type { CallResult, ContentBlock, Failure, Reply, StatusReply } from './model'
import { LEASE_MINUTES } from './routing'

// What the model and the person are told about a helper reply. Pure.

export type ToolAnswer = { result: string | ContentBlock[]; isError?: true }

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
          'The codex-cu helper is not running and could not be started. Check that the ChatGPT app with Codex computer use is installed, then run the plugin\'s helper/install.sh (once installed, also at ~/.claude/mcp/codex-cu/install.sh). Do not fall back to another desktop-control route.',
          [reply.message],
        ),
        isError: true,
      }
    case 'error':
      return { result: withNotes(`codex-cu: ${reply.message}`, reply.notes), isError: true }
  }
}

/** What `/codex-cu forget <app>` tells the person. */
export const forgetText = (app: string, reply: Reply) => {
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

/** What `/codex-cu status` tells the person. */
export const statusReport = (enabled: boolean, reply: StatusReply | Failure): string => {
  const lines = [`Route: ${enabled ? 'Codex computer use (on)' : "Claude's own computer use (off)"}`]

  if (reply.status === 'unreachable' || reply.status === 'error') {
    lines.push(`Helper: not reachable (${reply.message})`)
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
