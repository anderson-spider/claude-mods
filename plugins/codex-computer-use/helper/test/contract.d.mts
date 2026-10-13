export const contract: {
  routes: Readonly<Record<string, string>>
  replies: {
    ok: Readonly<Record<string, readonly string[]>>
    held: Readonly<Record<string, readonly string[]>>
  }
  choices: readonly string[]
  leaseMinutes: number
  label: string
  callers: readonly { session: string; agent?: string; caller: string }[]
  maxPart: number
  notCallers: readonly string[]
  home: readonly string[]
  socketUnderHome: string
}
