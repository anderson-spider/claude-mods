export function authorizedRoot(sessionCwd: string, gitTopLevel: string | undefined): string {
  return gitTopLevel ?? sessionCwd
}
