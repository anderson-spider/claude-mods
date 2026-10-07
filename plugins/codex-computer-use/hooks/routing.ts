// What goes where: the model's own desktop computer-use tools are refused
// while the mod is on, browsers and purpose-built tools are left alone, and
// native app control goes through the bridge tool. Pure.

export const BRIDGE = 'codex_cu'
// Must match LEASE_MS in helper/lib/hub.mjs.
/** How long an app stays with the caller that last used it. */
export const LEASE_MINUTES = 2

/**
 * Claude's own desktop control: the desktop app's computer-use server, the
 * remote-devices computer tools and the switch that turns them on. The
 * remote-devices browser (`mcp__remote-devices__Claude_Browser__*`) is not one.
 */
const OWN_DESKTOP = /^(mcp__computer-use__|mcp__remote-devices__computer|enable__mcp__remote-devices__computer)/

export const isOwnDesktopTool = (tool: string) => OWN_DESKTOP.test(tool)

export type Command =
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'status' }
  | { kind: 'auto-approve'; isOn: boolean }
  | { kind: 'forget' }
  | { kind: 'forget-app'; app: string }
  | { kind: 'help' }

/** `/codex-cu on|off|status|forget [app]|auto-approve on|off`. */
export const parseCommand = (args: string): Command => {
  const words = args.trim().toLowerCase().split(/\s+/).filter(word => word !== '')

  switch (words[0]) {
    case 'forget': {
      // The app keeps its spelling: "TextEdit", "/Applications/Foo Bar.app", "com.apple.grapher".
      const app = args.trim().slice('forget'.length).trim()

      return app === '' ? { kind: 'forget' } : { kind: 'forget-app', app }
    }
    case 'on':
    case 'off':
    case 'status':
      return words.length === 1 ? { kind: words[0] } : { kind: 'help' }
    case 'auto-approve':
      return words[1] === 'on' || words[1] === 'off' ? { kind: 'auto-approve', isOn: words[1] === 'on' } : { kind: 'help' }
    case undefined:
      return { kind: 'status' }
    default:
      return { kind: 'help' }
  }
}

/** A time limit setting in minutes as milliseconds: the default when it is not a positive number, 24 h at most. */
export const limitMs = (raw: unknown, defaultMinutes: number): number => {
  const minutes = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw

  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
    return Math.round(defaultMinutes * 60_000)
  }

  return Math.round(Math.min(minutes, 24 * 60) * 60_000)
}
