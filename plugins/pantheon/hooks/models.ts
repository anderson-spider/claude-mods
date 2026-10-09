import type { Engine } from './types'

const aliases = new Set(['opus', 'sonnet', 'haiku', 'fable', 'opusplan', 'default', 'inherit'])

export function isClaudeModel(model: string): boolean {
  return /claude/i.test(model) || aliases.has(model.replace(/\[[^\]]*\]$/, ''))
}

export function modelMismatch(engine: Engine, model: string | undefined): string | undefined {
  if (model === undefined) return undefined
  const claude = isClaudeModel(model)
  if (engine === 'claude' && !claude) return `"${model}" is not a Claude model (engine claude)`
  if (engine === 'codex' && claude) return `"${model}" is a Claude model (engine codex)`
  return undefined
}
