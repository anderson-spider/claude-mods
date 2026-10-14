import type { Style } from './view'

/** `mockup`: the design's fixed colours, for a dark theme; `theme`: the person's theme keys, for any other. */
export type Palette = 'mockup' | 'theme'
/** What one segment is drawn with, in the screen's prop names. */
export type Paint = { color?: string; bold?: boolean; dimColor?: boolean }

/**
 * A full-colour dark or automatic theme takes the design's palette; a light, ANSI or unknown one keeps theme keys.
 * The host does not say what `auto` resolved to, and it follows the terminal, which is dark where this runs.
 */
export function paletteOf(theme: unknown): Palette {
  return (theme === 'auto' || (typeof theme === 'string' && theme.startsWith('dark'))) && !String(theme).includes('ansi') ? 'mockup' : 'theme'
}

// The design's palette: fixed colours are legible on a dark background only.
const MOCKUP: Record<Style, Paint> = {
  plain: {},
  strong: { bold: true },
  secondary: { color: '#8a8f98' },
  model: { color: '#d97757', bold: true },
  success: { color: '#4fb383' },
  warning: { color: '#e5c07b' },
  danger: { color: '#e06c75', bold: true },
  sent: { color: '#61afef' },
  bar: { color: '#e5c07b' },
  track: { color: '#3d424b' },
  tick: { color: '#e6e6e6' },
  frame: { color: '#4b5468' },
}

const THEME: Record<Style, Paint> = {
  plain: {},
  strong: { bold: true },
  secondary: { dimColor: true },
  model: { color: 'claude', bold: true },
  success: { color: 'success' },
  warning: { color: 'warning' },
  danger: { color: 'error', bold: true },
  sent: { color: 'suggestion' },
  bar: { color: 'warning' },
  track: { color: 'subtle' },
  tick: { color: 'text' },
  frame: { color: 'inactive' },
}

/** The paint of one style. */
export function paint(palette: Palette, style: Style): Paint {
  return (palette === 'mockup' ? MOCKUP : THEME)[style] ?? {}
}
