export const contract: {
  callers: readonly { session: string; agent?: string; caller: string }[]
  maxPart: number
  notCallers: readonly string[]
  home: readonly string[]
  socketUnderHome: string
}
