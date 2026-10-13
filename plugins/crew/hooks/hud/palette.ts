import type { Style } from './view'

/** `mockup`: the design's fixed colours, for a dark theme; `theme`: the person's theme keys, for any other. */
export type Palette = 'mockup' | 'theme'
/** What one segment is drawn with, in the screen's prop names. */
export type Paint = { color?: string; backgroundColor?: string; bold?: boolean; dimColor?: boolean }

/**
 * A full-colour dark or automatic theme takes the design's palette; a light, ANSI or unknown one keeps theme keys.
 * The host does not say what `auto` resolved to, and it follows the terminal, which is dark where this runs.
 */
export function paletteOf(theme: unknown): Palette {
  return (theme === 'auto' || (typeof theme === 'string' && theme.startsWith('dark'))) && !String(theme).includes('ansi') ? 'mockup' : 'theme'
}

// The design's palette (One Dark): fixed colours are legible on a dark background only.
const MOCKUP: Record<Style, Paint> = {
  plain: {},
  heading: { bold: true },
  secondary: { color: '#8a8f98' },
  success: { color: '#4fb383' },
  warning: { color: '#e5c07b' },
  error: { color: '#e06c75' },
  info: { color: '#61afef' },
  accent: { color: '#c678dd' },
  title: { color: '#e5c07b', bold: true },
  frame: { color: '#4b5468' },
  track: { color: '#33363d' },
  'pill-running': { color: '#4fb383', backgroundColor: '#1d3a2e' },
  'pill-recent': { color: '#8a8f98', backgroundColor: '#2a2d33' },
}

const THEME: Record<Style, Paint> = {
  plain: {},
  heading: { bold: true },
  secondary: { dimColor: true },
  success: { color: 'success' },
  warning: { color: 'warning' },
  error: { color: 'error' },
  info: { color: 'permission' },
  accent: { color: 'merged' },
  title: { color: 'warning', bold: true },
  frame: { color: 'inactive' },
  track: { color: 'subtle' },
  'pill-running': { color: 'success' },
  'pill-recent': { dimColor: true },
}

/** The paint of one style; `bold` adds weight to any of them. */
export function paint(palette: Palette, style: Style, bold = false): Paint {
  const base = (palette === 'mockup' ? MOCKUP : THEME)[style] ?? {}
  return bold ? { ...base, bold: true } : base
}
