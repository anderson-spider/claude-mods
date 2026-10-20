import { readlinkSync } from 'node:fs'
import { join } from 'node:path'

// Where the plugin's own browser lives: one folder per user, shared by every session and plugin version. The hooks
// pass it as `--home` (`helperHome` in hooks/playwright-browser.ts).
export const pathsOf = home => ({
  home,
  /** playwright-core, installed with npm. */
  runtime: join(home, 'runtime'),
  /** The Chromium build that playwright-core pins (PLAYWRIGHT_BROWSERS_PATH). */
  browsers: join(home, 'browsers'),
  /** The persistent profile: the ChatGPT login lives here. */
  profile: join(home, 'profile'),
  /** A folder only this user can enter, holding the socket. */
  run: join(home, 'run'),
  socket: join(home, 'run', 'helper.sock'),
  /** Held by the one `serve` that owns the socket and the profile; it names that process's pid. */
  lock: join(home, 'run', 'serve.lock'),
  /** Touched by `login` before it stops the daemon, so a `start` racing it stays away from the profile. */
  loginMark: join(home, 'run', 'login'),
  /** What the daemon writes, appended across starts. */
  log: join(home, 'helper.log'),
})

// A Unix socket path holds 104 bytes on macOS (108 on Linux), its terminating NUL included.
export const SOCKET_MAX = 103

/** Why the socket under `paths` cannot be listened on, or undefined when it can. */
export const socketError = paths => {
  const bytes = Buffer.byteLength(paths.socket)
  return bytes > SOCKET_MAX ? `the socket path ${paths.socket} is ${bytes} bytes, more than a Unix socket takes (${SOCKET_MAX}): use a shorter --home` : undefined
}

/** Whether a process with this pid is running (signal 0 checks without sending anything). */
export const isAlive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * The pid of the Chromium that holds the profile, from its SingletonLock (a symbolic link to `<host>-<pid>`), when that
 * process is running; undefined when none does.
 */
export function profileHolder(paths, read = readlinkSync) {
  let target
  try {
    target = read(join(paths.profile, 'SingletonLock'))
  } catch {
    return undefined
  }
  const pid = Number(/-(\d+)$/.exec(String(target))?.[1])
  return pid && isAlive(pid) ? pid : undefined
}
