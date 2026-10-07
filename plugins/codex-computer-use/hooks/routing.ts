import type { ContentBlock, Reply } from './helper'

// What goes where: the model's own desktop computer-use tools are refused
// while the mod is on, browsers and purpose-built tools are left alone, and
// native app control goes through the bridge tool. Pure.

export const BRIDGE = 'codex_cu'
/** How long an app stays with the caller that last used it; the helper's LEASE_MS. */
export const LEASE_MINUTES = 2

/**
 * Claude's own desktop control: the desktop app's computer-use server, the
 * remote-devices computer tools and the switch that turns them on. The
 * remote-devices browser (`mcp__remote-devices__Claude_Browser__*`) is not one.
 */
const OWN_DESKTOP = /^(mcp__computer-use__|mcp__remote-devices__computer|enable__mcp__remote-devices__computer)/

export const isOwnDesktopTool = (tool: string) => OWN_DESKTOP.test(tool)

export const denyOwn = (bridge: string) =>
  `codex-computer-use is on: desktop apps on this Mac are controlled through Codex computer use, not this tool. ` +
  `Call ${bridge} instead (its first call in a session is \`await cua.getState();\` or \`let app = await cua.getApp("<App>");\`). ` +
  `If the bridge fails, report the error to the person; do not fall back to another desktop-control route. The person can type /codex-cu off to restore this tool.`

export const PROMPT = (bridge: string) =>
  [
    '# Desktop apps through Codex computer use (codex-computer-use mod)',
    '',
    `When the person asks you to do something in a native app on this Mac (Calculator, TextEdit, Finder, System apps...), use the \`${bridge}\` tool. It runs JavaScript in a persistent Codex computer-use session (one per Claude session or subagent) that clicks and types inside apps in the background, without moving the person's mouse. Your own desktop computer-use tools are blocked while this mod is on.`,
    '',
    '- The first call in a new or reset session must be exactly one documented entry call and nothing else: `await cua.getState();` for an inventory, or `let app = await cua.getApp("Calculator");` for one app. Its result carries the API documentation and the app\'s UI state: read it before calling any other method, and use only the methods it documents. Do not guess the API.',
    '- Variables persist between calls (`app` above stays bound); pass `reset: true` to start over.',
    '- Prefer element indices from the accessibility tree (`app.click(12)`, `app.setValue(9, "text")`) over coordinates, and keyboard shortcuts (`app.pressKey("cmd+t")`) where the app has them.',
    '- Batch deterministic steps in one call and end it with `await app.getAXState()`, which returns a diff of what changed. Re-read indices after every action; never reuse stale ones. Ask for `{ disableDiffing: true }` only when you need the full tree.',
    '- Return only what you need: read with `{ emit: false }` (e.g. `const t = await app.getAXState({ emit: false, disableDiffing: true })`) and print just the relevant lines with `nodeRepl.write(...)`.',
    '- After an error or a surprise, read the state before retrying: an action can fail yet still apply, and a dialog may have opened. Answer a dialog that would change the person\'s settings or data with its least-change option (Not Now, Cancel) unless the task calls for it.',
    '- The app works in the background and stays behind other windows. To bring it to the front (when the person wants to watch, or to show a result), raise its window with `performSecondaryAction(<window index>, "Raise")` and say where the result is. Leave apps as you found them (close windows you opened) unless the task says otherwise.',
    `- The first use of an app asks the person (this session / always / no). A "no" or an organization/safety block is final for that app: tell the person and do not try another route to it (AppleScript, osascript, System Events, keyboard tools).`,
    `- Other Claude sessions and subagents may use Codex at the same time, each in its own session. An app one of them is driving belongs to it until ${LEASE_MINUTES} minutes after its last call: if an app is "in use by another session", work in a different app or wait and retry. Never fight over an app.`,
    '- Browsers, web pages, CLIs and purpose-built tools or APIs are not affected; prefer them when they fit. Never ask the bridge to type passwords or payment details.',
    '- Apps show whatever is on screen: do not repeat private content you see unless the task needs it.',
  ].join('\n')

export const DESCRIPTION = [
  'Control native macOS apps through Codex computer use (background clicks and typing, no mouse takeover).',
  'Runs `code` (JavaScript with top-level await) in a persistent cua_repl session owned by this caller.',
  'First call of a new or reset session: one entry call only, `await cua.getState();` or `let app = await cua.getApp("<App name or bundle id>");`; read the documentation it returns before anything else.',
  'Then e.g. `await app.typeText("25*4=")`, `await app.getAXState()`, `await app.click(<index>)`, as the documentation shows.',
  'An app used for the first time asks the person; a refusal or a busy app is final.',
].join(' ')

export const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string', description: 'JavaScript to run with the initialized `cua` API.' },
    title: { type: 'string', maxLength: 80, description: 'Short description of what the code does, shown to the person.' },
    timeout_ms: { type: 'integer', minimum: 1000, maximum: 300000, description: 'Execution timeout; 30000 when omitted.' },
    reset: { type: 'boolean', description: 'Discard this caller\'s Codex session (variables and app ownership) instead of running code.' },
  },
  additionalProperties: false,
} as const

export type Command =
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'status' }
  | { kind: 'auto-approve'; isOn: boolean }
  | { kind: 'forget' }
  | { kind: 'forget-app'; app: string }
  | { kind: 'help' }

/** `/codex-cu on|off|status|forget [app]|auto-approve on|off`. */
export const parseCommand = (args: string): Command => {
  const words = args.trim().toLowerCase().split(/\s+/).filter(word => word !== '')

  switch (words[0]) {
    case 'forget': {
      // The app keeps its spelling: "TextEdit", "/Applications/Foo Bar.app", "com.apple.grapher".
      const app = args.trim().slice('forget'.length).trim()

      return app === '' ? { kind: 'forget' } : { kind: 'forget-app', app }
    }
    case 'on':
    case 'off':
    case 'status':
      return words.length === 1 ? { kind: words[0] } : { kind: 'help' }
    case 'auto-approve':
      return words[1] === 'on' || words[1] === 'off' ? { kind: 'auto-approve', isOn: words[1] === 'on' } : { kind: 'help' }
    case undefined:
      return { kind: 'status' }
    default:
      return { kind: 'help' }
  }
}

export const HELP = [
  '/codex-cu on            route desktop apps through Codex computer use (default)',
  '/codex-cu off           restore Claude\'s own desktop computer use',
  '/codex-cu status        show the route, the helper and the apps in use',
  '/codex-cu auto-approve on|off   stop (on) or resume (off) asking before a new app is used',
  '/codex-cu forget        drop this session\'s app answers (this session / no)',
  '/codex-cu forget <app>  take <app> off "always allow" (the helper\'s list and Codex\'s own), so it asks again',
].join('\n')

export type ToolAnswer = { result: string | ContentBlock[]; isError?: true }

const withNotes = (text: string, notes: readonly string[] | undefined) =>
  notes === undefined || notes.length === 0 ? text : `${notes.join('\n')}\n\n${text}`

/** The model-facing answer for a helper reply that needs no person. */
export const toAnswer = (reply: Reply): ToolAnswer => {
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
export const forgetText = (
  app: string,
  reply: Reply & { bundleId?: string; helper?: boolean; codex?: 'removed' | 'absent' | 'missing' },
) => {
  if (reply.status !== 'ok' || reply.bundleId === undefined) {
    return `codex-cu: could not forget ${app}: ${'message' in reply ? reply.message : JSON.stringify(reply)}`
  }

  const codex = { removed: 'removed', absent: 'was not there', missing: 'no file found' }[reply.codex ?? 'missing']

  return [
    `codex-cu: ${app} (${reply.bundleId}) is no longer always allowed; its next use asks again.`,
    `  helper list: ${reply.helper === true ? 'removed' : 'was not there'}`,
    `  Codex ComputerUseAppApprovals.json: ${codex}`,
  ].join('\n')
}

/** A time limit setting in minutes as milliseconds: the default when it is not a positive number, 24 h at most. */
export const limitMs = (raw: unknown, defaultMinutes: number): number => {
  const minutes = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw

  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
    return Math.round(defaultMinutes * 60_000)
  }

  return Math.round(Math.min(minutes, 24 * 60) * 60_000)
}

export type StatusReply = Reply & {
  version?: string
  callers?: { caller: string; apps: string[] }[]
  settings?: { autoApprove: boolean; always: string[] }
}

/** What `/codex-cu status` tells the person. */
export const statusReport = (enabled: boolean, reply: StatusReply): string => {
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
