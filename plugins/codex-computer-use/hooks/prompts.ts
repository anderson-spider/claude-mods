import { LEASE_MINUTES } from './routing'

// The texts the model and the person read: the system prompt section, the
// bridge tool's declaration, the deny text and the command help. Pure.

export const denyOwn = (bridge: string) =>
  `codex-computer-use is on: desktop apps on this Mac are controlled through ${bridge}, not this tool. ` +
  `If it fails, report the error to the person; do not fall back to another desktop-control route. The person can type /codex-cu off to restore this tool.`

export const PROMPT = (bridge: string) =>
  [
    '# Desktop apps through Codex computer use (codex-computer-use mod)',
    '',
    `For anything in a native app on this Mac (Calculator, TextEdit, Finder, System apps...), use \`${bridge}\`: a persistent Codex computer-use session per Claude session or subagent that works in the background without moving the person's mouse. Your own desktop computer-use tools are blocked while this mod is on. Follow the tool's first-call rule.`,
    '',
    '- Prefer accessibility-tree indices over coordinates, and keyboard shortcuts where the app has them. Re-read indices after every action; never reuse stale ones.',
    '- Batch deterministic steps in one call and end it with `await app.getAXState()` (a diff of what changed). Read with `{ emit: false }` and print only the relevant lines.',
    '- After an error or surprise, read the state before retrying: an action can fail yet still apply, and a dialog may have opened. Answer a dialog that would change settings or data with its least-change option (Not Now, Cancel) unless the task calls for it.',
    '- Apps stay behind other windows. To show a result, raise the window with `performSecondaryAction(<window index>, "Raise")` and say where it is. Close windows you opened unless the task says otherwise.',
    '- A "no" or an organization/safety block on an app is final: tell the person and try no other route to it (AppleScript, osascript, System Events, keyboard tools).',
    `- Other sessions may be driving an app; it is theirs until ${LEASE_MINUTES} minutes after their last call. If it is "in use by another session", work in another app or wait and retry.`,
    '- Browsers, web pages, CLIs and purpose-built tools or APIs are not affected; prefer them when they fit. Never type passwords or payment details, and do not repeat private screen content unless the task needs it.',
  ].join('\n')

export const DESCRIPTION = [
  'Control native macOS apps through Codex computer use (background clicks and typing, no mouse takeover).',
  'Runs `code` (JavaScript with top-level await) in a persistent cua_repl session owned by this caller.',
  'First call of a new or reset session: one entry call only, `await cua.getState();` or `let app = await cua.getApp("<App name or bundle id>");`; read the documentation it returns before anything else.',
  'An app used for the first time asks the person; a refusal is final; a busy app frees when its lease ends.',
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

export const HELP = [
  '/codex-cu on            route desktop apps through Codex computer use (default)',
  '/codex-cu off           restore Claude\'s own desktop computer use',
  '/codex-cu status        show the route, the helper and the apps in use',
  '/codex-cu auto-approve on|off   stop (on) or resume (off) asking before a new app is used',
  '/codex-cu forget        drop this session\'s app answers (this session / no)',
  '/codex-cu forget <app>  take <app> off "always allow" (the helper\'s list and Codex\'s own), so it asks again',
].join('\n')
