export type RunResult = { exitCode: number; stdout: string; stderr: string }

/** What the modules need from the host; `register.tsx` owns `$` and hands it over this way. */
export type Probe = {
  run: (argv: readonly string[], init?: { cwd?: string; timeoutMs?: number }) => Promise<RunResult>
  /** The text of a file; `undefined` when it cannot be read. */
  read: (path: string) => Promise<string | undefined>
  /** The names in a directory; empty when it cannot be listed. */
  list: (path: string) => Promise<string[]>
  home: () => Promise<string | undefined>
}
