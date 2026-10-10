import type { EditContext, Verdict } from './decisions'

// tool.call flattens the tool's input fields onto the event.
export type GateEvent = { tool: string; agentId?: string; [field: string]: unknown }
export type GateEnv = { root: string; home: string; uid?: string }

// Lexical normalization only: the pure module cannot resolve filesystem links.
const normalize = (path: string): string => {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return '/' + parts.join('/')
}

const within = (path: string, dir: string): boolean =>
  path === dir || path.startsWith(dir === '/' ? '/' : dir + '/')

const extension = (path: string): string => {
  const name = path.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot) : ''
}

const lines = (value: unknown): number | undefined => {
  if (typeof value !== 'string') return undefined
  if (value === '') return 0
  return value.split('\n').length - (value.endsWith('\n') ? 1 : 0)
}

export function gateContext(e: GateEvent, env: GateEnv):
  { skip: true; why: string } | { skip: false; ctx: EditContext } {
  if (e.agentId) return { skip: true, why: 'Subagent edit.' }
  if (!['Edit', 'Write', 'NotebookEdit'].includes(e.tool)) {
    return { skip: true, why: 'Tool is outside the gated set.' }
  }
  const raw = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
  const root = normalize(env.root)
  let path = ''
  // The flow's own files (state, snapshot, journal, ledger) are written by the controller, never by an edit: whatever the
  // size of the change, it is not one the rules can call trivial.
  let controllerFile = false
  if (typeof raw === 'string' && raw !== '') {
    const absolute = normalize(raw.startsWith('/') ? raw : root + '/' + raw)
    const claude = env.home ? normalize(env.home + '/.claude') : undefined
    const statePath = claude && within(absolute, claude) ? absolute.slice(claude.length + 1) : ''
    const scratch = absolute.match(/^\/(?:private\/)?tmp\/claude-(\d+)\/[^/]+\/[^/]+\/scratchpad(?:\/|$)/)
    controllerFile = within(absolute.toLowerCase(), normalize(root + '/.pantheon/flow').toLowerCase())
    // Only the plans are exempt from `.pantheon`: `.pantheon/flow/**` holds the approval and the state the flow trusts.
    if (within(absolute, normalize(root + '/.pantheon/plans'))
      || (claude && within(absolute, claude + '/plans'))
      || /^projects\/[^/]+\/memory(?:\/|$)/.test(statePath)
      || (env.uid !== undefined && /^\d+$/.test(env.uid) && scratch?.[1] === env.uid)) {
      return { skip: true, why: 'Exempt path.' }
    }
    path = within(absolute, root) ? absolute.slice(root === '/' ? 1 : root.length + 1) : absolute
  }

  let linesAdded: number | undefined
  let linesRemoved: number | undefined
  if (controllerFile) {
    // Unknown counts are what the rules answer with an ask (held for Proceed/Cancel, or denied without a surface).
  } else if (e.tool === 'Edit') {
    // replace_all's occurrence count is unknown; neither count can be inferred.
    if (e.replace_all !== true) {
      linesAdded = lines(e.new_string)
      linesRemoved = lines(e.old_string)
    }
  } else {
    linesAdded = lines(e.tool === 'Write' ? e.content : e.new_source)
    // The previous file or cell contents are unavailable to this pure function.
  }
  return { skip: false, ctx: { tool: e.tool, path, ext: extension(path), linesAdded, linesRemoved, files: 1 } }
}

export function gateMessage(v: Verdict, roles: { developer: boolean; ux: boolean }): string {
  if (v.action === 'allow') return 'Allowed by rules.'
  const decision = v.action === 'deny' ? 'Denied' : 'Ask the person before proceeding'
  // Code goes to developer and visual work to ux; a disabled role is replaced by a request for the person.
  const destinations = roles.developer
    ? [roles.ux ? 'delegate to developer (code) or ux (visual work)' : 'delegate to developer']
    : ['ask the person to handle implementation', ...(roles.ux ? ['delegate visual work to ux'] : [])]
  return `${decision} by rules.\nPlease ${destinations.join('; ')}; the main session should not edit it itself.`
}
