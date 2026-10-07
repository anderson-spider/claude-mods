import { HerdrError } from './model'
import type { AgentSession, Herdr } from './model'
import { WAIT_CHUNK_MS } from './job'

/** A cancelled loop keeps its execute slot until its active agent is known to have stopped. */
export async function waitForStop(herdr: Pick<Herdr, 'wait'>, session: AgentSession): Promise<void> {
  while (session.active) {
    try {
      const state = await herdr.wait(session.agent, WAIT_CHUNK_MS, ['idle', 'done'])
      if (state === 'idle' || state === 'done') session.active = false
    } catch (error) {
      if (error instanceof HerdrError && ['agent_not_found', 'pane_not_found'].includes(error.code)) session.active = false
      // A timeout or transport failure proves nothing; another cancel can retry Esc meanwhile.
    }
  }
}
