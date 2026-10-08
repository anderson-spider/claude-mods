import { ENGINES } from './engines'
import type { Engine, Kind, LoopRequest, Request } from './model'

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

/** An engine input: absent is Codex (left unset), a name that is not an engine is the error to answer. */
function engineOf(value: unknown, name: string): { engine?: Engine; error?: string } {
  if (value === undefined) return {}
  const engine = ENGINES.find(known => known === value)
  return engine ? { engine } : { error: `Give ${name} as one of: ${ENGINES.join(', ')}.` }
}

/** Reads a tool call's input into a request, or the error to answer. */
export function requestOf(kind: Kind, e: Record<string, unknown>): Request | string {
  const { engine, error } = engineOf(e.engine, 'engine')
  if (error) return error
  const task = text(e.task) ?? ''
  if (kind === 'execute' && !task) return 'Give a non-empty task.'
  const files = Array.isArray(e.files) ? e.files.filter((f): f is string => typeof f === 'string' && f.trim() !== '').map(f => f.trim()) : []
  const target = text(e.target)
  const focus = text(e.focus)
  return { kind, task, files, ...(target ? { target } : {}), ...(focus ? { focus } : {}), ...(engine ? { engine } : {}) }
}

/** Reads the loop input with the same task and file rules as execute; the engines are the dev's and the QA's. */
export function loopOf(e: Record<string, unknown>): LoopRequest | string {
  const request = requestOf('execute', { ...e, engine: undefined })
  if (typeof request === 'string') return request
  const dev = engineOf(e.devEngine, 'devEngine')
  const qa = engineOf(e.qaEngine, 'qaEngine')
  if (dev.error || qa.error) return (dev.error ?? qa.error)!
  const maxRounds = e.maxRounds === undefined ? 3 : e.maxRounds
  if (typeof maxRounds !== 'number' || !Number.isInteger(maxRounds) || maxRounds < 1) return 'Give maxRounds as an integer at least 1.'
  return { task: request.task, files: request.files, maxRounds, ...(dev.engine ? { devEngine: dev.engine } : {}), ...(qa.engine ? { qaEngine: qa.engine } : {}) }
}
