import type { Herdr } from './model'

/** Pane ids restart after a server restart, so both parts of the identity must match. */
export async function owns(herdr: Pick<Herdr, 'list'>, agent: string, pane: string): Promise<boolean> {
  return (await herdr.list()).some(entry => entry.name === agent && entry.pane === pane)
}
