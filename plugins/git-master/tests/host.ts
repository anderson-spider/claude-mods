// The host fake the plugin's tests share: records the agents the plugin registers.
import type { On } from 'claude-code'

export type Registered = { name: string; description: string; prompt: string; model?: string; effort?: string; tools?: readonly string[] }

/** A host that records each registered agent. */
export function world(on: On) {
  const agents: Registered[] = []
  on('agent.register', (_$, e) => (agents.push(e as unknown as Registered), { value: undefined }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  return { agents }
}

/** Starts the session, so the plugin registers its agent. */
export async function started($: { session: { start: (e: never) => Promise<unknown> } }): Promise<void> {
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true } as never)
}
