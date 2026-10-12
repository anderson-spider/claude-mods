// Colors (UI spec 3.1, 3.2, 10): the `colors` option picks the person's theme keys (`theme`, the default) or the fixed
// role table (`roles`, dark or light). A span's tone becomes the props a Text takes: a color, `dimColor`, `bold`.
import type { Role } from './roles'
import type { SectionId, Span } from './line'

export type ColorsOption = 'roles' | 'theme'

/** The option as stored: anything but `roles` (a removed `palette` value, a typo) is `theme`. */
export const colorsOption = (value: unknown): ColorsOption => (value === 'roles' ? 'roles' : 'theme')

export type Palette = {
  section: Readonly<Record<SectionId, string>>
  role: Readonly<Record<Role, string>>
  ok: string
  bad: string
  warn: string
  faint: string
  /** Body text; undefined leaves the surface's own foreground. */
  text: string | undefined
  /** Role names drawn bold (theme: every role is `text`, told apart by name). */
  roleBold: boolean
}

const THEME: Palette = {
  section: {
    session: 'suggestion',
    quota: 'suggestion',
    plan: 'warning',
    running: 'success',
    review: 'merged',
    finished: 'inactive',
    timeline: 'permission',
    log: 'subtle',
  },
  role: {
    lead: 'text',
    'code-reader': 'text',
    research: 'text',
    designer: 'text',
    developer: 'text',
    tester: 'text',
    architect: 'text',
    other: 'text',
  },
  ok: 'success',
  bad: 'error',
  warn: 'warning',
  faint: 'subtle',
  text: 'text',
  roleBold: true,
}

const DARK: Palette = {
  section: {
    session: '#5B93E6',
    quota: '#6FA8DC',
    plan: '#D9A441',
    running: '#4CC2A0',
    review: '#A56BD8',
    finished: '#8F96A6',
    timeline: '#7C7FE0',
    log: '#7B8190',
  },
  role: {
    lead: '#5B93E6',
    'code-reader': '#A8C545',
    research: '#D4C35A',
    designer: '#D870A8',
    developer: '#F0A35E',
    tester: '#4FB3C9',
    architect: '#A56BD8',
    other: '#B3B5BA',
  },
  ok: '#4CC2A0',
  bad: '#E5604D',
  warn: '#D9A441',
  faint: '#3B4354',
  text: undefined,
  roleBold: false,
}

const LIGHT: Palette = {
  section: {
    session: '#2F68C0',
    quota: '#2F6CA8',
    plan: '#9A6A00',
    running: '#1F8A5B',
    review: '#7A3DB8',
    finished: '#5F6573',
    timeline: '#4A4FB8',
    log: '#6B7180',
  },
  role: {
    lead: '#2F68C0',
    'code-reader': '#5E7F12',
    research: '#8A7400',
    designer: '#B03A7E',
    developer: '#B5521C',
    tester: '#1E7F94',
    architect: '#7A3DB8',
    other: '#6B6E75',
  },
  ok: '#1F8A5B',
  bad: '#C0392B',
  warn: '#9A6A00',
  faint: '#C9CDD6',
  text: undefined,
  roleBold: false,
}

/** The palette of an option; `light` only when the host says the theme is light (the dark table otherwise). */
export const paletteOf = (colors: ColorsOption, light = false): Palette => (colors === 'theme' ? THEME : light ? LIGHT : DARK)

/** Raw colors for SVG, which cannot name theme keys: the role table's mid tones, read on light and dark alike. */
export const SVG_PALETTE: Palette = DARK

export type Paint = { color?: string; dimColor?: boolean; bold?: boolean; inverse?: boolean }

/** The Text props of a span; `card` is the section a `section` tone falls back to. */
export function paint(span: Span, p: Palette, card?: SectionId): Paint {
  const out: Paint = {}
  let color: string | undefined
  switch (span.tone) {
    case 'section':
      color = p.section[span.section ?? card ?? 'session']
      break
    case 'role':
      color = p.role[span.role ?? 'other']
      if (p.roleBold) out.bold = true
      break
    case 'text':
      color = p.text
      break
    case 'ok':
      color = p.ok
      break
    case 'bad':
      color = p.bad
      break
    case 'warn':
      color = p.warn
      break
    case 'faint':
      color = p.faint
      break
    case 'dim':
      out.dimColor = true
      break
    default:
      break
  }
  if (color !== undefined) out.color = color
  if (span.dim) out.dimColor = true
  if (span.bold) out.bold = true
  if (span.inverse) out.inverse = true
  return out
}
