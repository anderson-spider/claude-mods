const aliases = new Set(['opus', 'sonnet', 'haiku', 'fable', 'opusplan', 'default', 'inherit'])

export function isClaudeModel(model: string): boolean {
  return /claude/i.test(model) || aliases.has(model.replace(/\[[^\]]*\]$/, ''))
}
