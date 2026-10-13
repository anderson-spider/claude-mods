import type { CodexCuInput } from '../types'
import { LEASE_MINUTES } from './routing'

export const denyOwn = (bridge: string) =>
  `codex-computer-use is on: use ${bridge} for native apps. Report bridge failures; do not switch desktop-control routes. ` +
  'The person can type /codex-cu off to restore this tool.'

export const PROMPT = (bridge: string) =>
  [
    '# Native apps',
    `Use \`${bridge}\` for native Mac apps; follow its first-call rule. Prefer browsers, CLIs and purpose-built APIs when they fit.`,
    '- Use fresh accessibility-tree indices and keyboard shortcuts; re-read after each action.',
    '- Batch deterministic steps, ending with `await app.getAXState()`. Read with `{ emit: false }` and print relevant lines only.',
    '- After errors or surprises, read state before retrying: an action may already have applied. Choose the least-change option for dialogs unless the task calls for a change.',
    '- To show a result, use `performSecondaryAction(<window index>, "Raise")` and name the window. Close windows you opened unless the task needs them.',
    '- On app refusal or an organization/safety block, report it and stop; never bypass it through another desktop-control route.',
    `- A busy app belongs to its caller until ${LEASE_MINUTES} minutes after their last call; use another app or wait before retrying.`,
    '- Leave passwords and payment details to the person; never type them. Share private screen content only when the task needs it.',
  ].join('\n')

export const DESCRIPTION = [
  'Control native macOS apps through Codex background clicks/typing without taking over the mouse.',
  'Runs JavaScript with top-level await in this caller\'s persistent cua_repl session.',
  'First call after start/reset: only `await cua.getState();` or `let app = await cua.getApp("<App name or bundle id>");`; read its API documentation before continuing.',
  'New apps ask the person; refusals are final and busy apps wait for their lease.',
].join(' ')

export const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    code: { type: 'string', description: 'JavaScript using the initialized `cua` API.' },
    title: { type: 'string', maxLength: 80, description: 'Action summary shown to the person.' },
    timeout_ms: { type: 'integer', minimum: 1000, maximum: 300000, description: 'Execution timeout in ms; default 30000.' },
    reset: { type: 'boolean', description: 'Reset this caller\'s session, variables and app ownership instead of running code.' },
  },
  additionalProperties: false,
} as const

// Compile-time: the schema's property names are exactly the tool input's keys (types/index.d.ts), so renaming one without the other fails tsc.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T
export type SchemaMatchesInput = Assert<Same<keyof typeof INPUT_SCHEMA.properties, keyof CodexCuInput>>
