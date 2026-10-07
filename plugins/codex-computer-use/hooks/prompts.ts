import { LEASE_MINUTES } from './routing'

// The texts the model and the person read: the system prompt section, the
// bridge tool's declaration, the deny text and the command help. Pure.

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

export const HELP = [
  '/codex-cu on            route desktop apps through Codex computer use (default)',
  '/codex-cu off           restore Claude\'s own desktop computer use',
  '/codex-cu status        show the route, the helper and the apps in use',
  '/codex-cu auto-approve on|off   stop (on) or resume (off) asking before a new app is used',
  '/codex-cu forget        drop this session\'s app answers (this session / no)',
  '/codex-cu forget <app>  take <app> off "always allow" (the helper\'s list and Codex\'s own), so it asks again',
].join('\n')
