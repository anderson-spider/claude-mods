import { HerdrError } from './model'
import { owns } from './identity'
import type { Herdr } from './model'

/** One row of agent panes below the lead, shared by every job and loop of the session. */
export function createPaneLayout() {
  let last: string | undefined
  let tail: Promise<unknown> = Promise.resolve()
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task)
    tail = run.catch(() => undefined)
    return run
  }

  return {
    open(herdr: Pick<Herdr, 'split'>): Promise<string> {
      return serial(async () => {
        let pane: string
        if (last) {
          try {
            pane = await herdr.split('right', last)
          } catch (error) {
            if (!(error instanceof HerdrError) || error.code !== 'pane_not_found') throw error
            last = undefined
            pane = await herdr.split('down')
          }
        } else {
          pane = await herdr.split('down')
        }
        last = pane
        return pane
      })
    },

    close(herdr: Pick<Herdr, 'close' | 'list'>, pane: string, agent: string): Promise<'closed' | 'skipped'> {
      // Closing and opening share the queue so a split cannot target a pane being closed.
      return serial(async () => {
        try {
          if (!await owns(herdr, agent, pane).catch(() => false)) return 'skipped'
          await herdr.close(pane)
          return 'closed'
        } finally {
          if (last === pane) last = undefined
        }
      })
    },
  }
}
