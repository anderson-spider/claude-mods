// The login window: the same Chromium build the daemon drives, launched as a plain app on the profile, with no
// automation flag and no debugging port, so sign-in providers see an ordinary browser. The person signs in and
// closes it; the daemon then runs headless on the cookies it left.
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
 * Stops the daemon (it holds the profile), installs what is missing, then opens the window. Answers
 * `{ status: 'opened' }`, or `{ status: 'error', message }`.
 */
export async function login({ paths, stopDaemon, missing, install, openWindow }) {
  if (!(await stopDaemon())) return { status: 'error', message: 'the running helper did not stop' }
  const lacking = missing(paths)
  if (lacking) {
    await install(lacking)
    const still = missing(paths)
    if (still) return { status: 'error', message: `the install finished but the ${still} is still missing` }
  }
  await openWindow()
  return { status: 'opened' }
}
