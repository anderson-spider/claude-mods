// The login window: the same Chromium build the daemon drives, launched as a plain app on the profile, with no
// automation flag and no debugging port, so sign-in providers see an ordinary browser. The person signs in and quits
// it (on macOS closing the window leaves the app running, holding the profile); the daemon then runs headless on the
// cookies it left.
export const LOGIN_URL = 'https://chatgpt.com/auth/login'

/** The `.app` bundle that holds a macOS executable path, or undefined outside one. */
export const appOf = executable => /^(.*?\.app)\//.exec(executable)?.[1]

/**
 * The command that opens the window: on macOS through `open`, so it is a foreground app of its own; elsewhere the
 * executable itself, with the plaintext password store Playwright gives the daemon on Linux.
 */
export function windowCommand(executable, profile, platform) {
  const args = [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check']
  const app = platform === 'darwin' ? appOf(executable) : undefined
  if (app) return ['open', '-n', '-a', app, '--args', ...args, LOGIN_URL]
  return [executable, ...args, ...(platform === 'linux' ? ['--password-store=basic'] : []), LOGIN_URL]
}

/**
 * Marks the login (so a `start` from another session keeps away from the profile), stops the daemon, installs what
 * is missing, then opens the window. Answers `{ status: 'opened' }`, or `{ status: 'error', message }`.
 */
export async function login({ paths, mark, stopDaemon, missing, install, openWindow }) {
  mark()
  if (!(await stopDaemon())) return { status: 'error', message: 'the running helper did not stop' }
  const lacking = missing(paths)
  if (lacking) {
    await install(lacking)
    const still = missing(paths)
    if (still) return { status: 'error', message: `the install finished but the ${still} is still missing` }
  }
  mark()
  await openWindow()
  return { status: 'opened' }
}
