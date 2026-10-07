import type { Herdr } from './model'

/**
 * Pane ids restart after a server restart, so the agent name and the pane must match, and the terminal too once known:
 * a reused pane id gets a new `terminal_id`. The socket path stays the same across a restart, so it tells nothing apart.
 */
export async function owns(herdr: Pick<Herdr, 'list'>, agent: string, pane: string, terminal?: string): Promise<boolean> {
  return (await herdr.list()).some(entry => entry.name === agent && entry.pane === pane && (terminal === undefined || entry.terminal === terminal))
}
