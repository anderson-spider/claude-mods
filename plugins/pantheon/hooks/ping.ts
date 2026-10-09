import { ROLES } from './defaults'
import { seatDisabled } from './roles'
import type { Engine, PantheonConfig } from './types'

export type PingResult = {
  name: string
  engine: Engine
  model?: string
  state: 'ok' | 'fail' | 'pending' | 'off'
  ms?: number
  detail?: string
}

export type PingTarget = { name: string; engine: Engine; model?: string; off: boolean; valid: boolean }

const SAFE_NAME = /^[A-Za-z0-9_-]+$/

/** Every role and council seat with its engine and model; `off` when disabled. */
export function pingTargets(config: PantheonConfig): PingTarget[] {
  return [
    ...ROLES.map(role => ({
      name: role,
      engine: config.agents[role].engine,
      model: config.agents[role].model,
      off: config.disabledAgents.includes(role),
      valid: true,
    })),
    ...Object.entries(config.council.seats).sort(([a], [b]) => a.localeCompare(b)).map(([seat, cfg]) => ({
      name: `councillor:${seat}`,
      engine: cfg.engine,
      model: cfg.model,
      off: seatDisabled(config, seat),
      valid: SAFE_NAME.test(seat),
    })),
  ]
}

const safeName = (name: string): boolean => SAFE_NAME.test(name.replace(/^councillor:/, ''))

const agentType = (name: string): string => `pantheon:${name.replace(/^councillor:/, 'councillor-')}`

/** Prompt asking the main session to ping each native agent with no tools and report who answered. */
export function pingPrompt(all: string[]): string {
  const names = all.filter(safeName)
  return [
    'Ping these Pantheon native agents. Call each one through the Agent tool, in parallel, with the prompt "Reply with exactly `pong <name>`. Use no tools.":',
    ...names.map(name => `- ${agentType(name)}: expect \`pong ${name}\``),
    'Then report which agents answered with the expected pong and which did not, with the error for each failure. Do nothing else.',
  ].join('\n')
}
