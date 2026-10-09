// Runs: colored pieces of a terminal row, measured in cells (never characters: ⚡ takes two).
import { cellWidth } from '../theme'

export type Run = { text: string; color?: string; dim?: boolean; bold?: boolean }

export const DIM = '#7B8190'
export const TEXT = '#d6d9de'

export const run = (text: string, color?: string, o: { dim?: boolean; bold?: boolean } = {}): Run => ({ text, ...(color ? { color } : {}), ...(o.dim ? { dim: true } : {}), ...(o.bold ? { bold: true } : {}) })
export const dot = (): Run => run(' · ', DIM)
export const width = (runs: Run[]): number => runs.reduce((n, r) => n + cellWidth(r.text), 0)

/** Right-pads with spaces to `cells`. */
export function padRuns(runs: Run[], cells: number): Run[] {
  const fill = cells - width(runs)
  return fill > 0 ? [...runs, run(' '.repeat(fill))] : runs
}

/**
 * A part of a row that may give way: `drop` is its priority (the lowest goes first), `alt` a
 * shorter form tried before the part is dropped, `keep` a part that is shortened but never dropped.
 */
export type Part = { runs: Run[]; drop: number; keep?: boolean; alt?: Run[] }

/** Joins the parts with " · " and, while the row is wider than `room`, shortens or drops the cheapest part. */
export function fit(parts: Part[], room: number): Run[] {
  const list = parts.filter(p => p.runs.length > 0).map(p => ({ ...p }))
  const total = () => list.reduce((n, p, i) => n + width(p.runs) + (i ? 3 : 0), 0)
  while (total() > room) {
    const cand = list.filter(p => p.alt || !p.keep).sort((a, b) => a.drop - b.drop)[0]
    if (!cand) break
    if (cand.alt) { cand.runs = cand.alt; cand.alt = undefined } else list.splice(list.indexOf(cand), 1)
  }
  const out: Run[] = []
  list.forEach((p, i) => { if (i) out.push(dot()); out.push(...p.runs) })
  return out
}
