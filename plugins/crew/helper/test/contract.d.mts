export const contract: {
  routes: Readonly<Record<string, string>>
  replies: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>
  startRequest: readonly string[]
  roles: readonly string[]
  label: string
  callers: readonly { agent: string; caller: string }[]
  maxPart: number
  notCallers: readonly string[]
  home: readonly string[]
  socketUnderHome: string
  examples: { pollOk: Record<string, unknown>; status: Record<string, unknown> }
}
