import type { EditContext, Verdict } from './decisions'

// tool.call flattens the tool's input fields onto the event.
export type GateEvent = { tool: string; agentId?: string; [field: string]: unknown }
export type GateEnv = { root: string; home: string; scratchpad?: string }

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
  if (typeof raw === 'string' && raw !== '') {
    const absolute = normalize(raw.startsWith('/') ? raw : root + '/' + raw)
    const exemptions = [normalize(root + '/.pantheon'), normalize(env.home + '/.claude')]
    if (env.scratchpad) exemptions.push(normalize(env.scratchpad))
    if (exemptions.some(dir => within(absolute, dir))) return { skip: true, why: 'Exempt path.' }
    path = within(absolute, root) ? absolute.slice(root === '/' ? 1 : root.length + 1) : absolute
  }

  let linesAdded: number | undefined
  let linesRemoved: number | undefined
  if (e.tool === 'Edit') {
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

export function gateMessage(v: Verdict, ctx: EditContext, roles: { executor: boolean; designer: boolean }): string {
  const source = v.source === 'jev' ? `jev (score ${v.score ?? 'unknown'})` : 'rules'
  if (v.action === 'allow') return `Allowed by ${source}.`
  const decision = v.action === 'deny' ? 'Denied' : 'Ask the person before proceeding'
  const destinations = [roles.executor ? 'delegate to the executor' : 'ask the person to handle implementation']
  if (['.tsx', '.jsx', '.css', '.scss', '.svelte', '.vue', '.html'].includes(extension(ctx.path).toLowerCase())) {
    destinations.push(roles.designer ? 'delegate UI work to the designer' : 'ask the person to handle UI work')
  }
  return `${decision} by ${source}.\nPlease ${destinations.join('; ')}; the main session should not edit it itself.`
}
