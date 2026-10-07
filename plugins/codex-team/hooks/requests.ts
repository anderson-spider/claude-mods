import type { Kind, LoopRequest, Request } from './model'

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

/** Reads a tool call's input into a request, or the error to answer. */
export function requestOf(kind: Kind, e: Record<string, unknown>): Request | string {
  const task = text(e.task) ?? ''
  if (kind === 'execute' && !task) return 'Give a non-empty task.'
  const files = Array.isArray(e.files) ? e.files.filter((f): f is string => typeof f === 'string' && f.trim() !== '').map(f => f.trim()) : []
  const target = text(e.target)
  const focus = text(e.focus)
  return { kind, task, files, ...(target ? { target } : {}), ...(focus ? { focus } : {}) }
}

/** Reads the loop input with the same task and file rules as execute. */
export function loopOf(e: Record<string, unknown>): LoopRequest | string {
  const request = requestOf('execute', e)
  if (typeof request === 'string') return request
  const maxRounds = e.maxRounds === undefined ? 3 : e.maxRounds
  if (typeof maxRounds !== 'number' || !Number.isInteger(maxRounds) || maxRounds < 1) return 'Give maxRounds as an integer at least 1.'
  return { task: request.task, files: request.files, maxRounds }
}
