// One glyph per row: Nerd Font icons (Font Awesome and devicons ranges) by name and extension, or a plain Unicode set
// for terminals without a patched font. Every glyph is one cell wide.
import type { Config } from './config'

type Icons = { dirClosed: string; dirOpen: string; link: string; file: string; byName: Record<string, string>; byExtension: Record<string, string> }

const CATEGORY: Record<string, readonly string[]> = {
  code: ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'lua', 'sh', 'zsh', 'bash', 'fish', 'ps1', 'vue', 'svelte', 'dart', 'scala', 'ex', 'exs', 'sql'],
  doc: ['md', 'mdx', 'txt', 'rst', 'adoc', 'pdf', 'doc', 'docx'],
  data: ['json', 'jsonc', 'yaml', 'yml', 'toml', 'xml', 'csv', 'tsv', 'ini', 'env', 'lock'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif'],
  archive: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar'],
  web: ['html', 'htm', 'css', 'scss', 'sass', 'less'],
}

const PLAIN_CATEGORY: Record<string, string> = { code: '◇', doc: '≡', data: '◫', image: '▣', archive: '▤', web: '◈' }

const byCategory = (glyphs: Record<string, string>) =>
  Object.fromEntries(Object.entries(CATEGORY).flatMap(([category, extensions]) => extensions.map(ext => [ext, glyphs[category] ?? ''])))

const UNICODE: Icons = {
  dirClosed: '▸',
  dirOpen: '▾',
  link: '↪',
  file: '·',
  byName: {},
  byExtension: byCategory(PLAIN_CATEGORY),
}

const NERD: Icons = {
  dirClosed: '',
  dirOpen: '',
  link: '',
  file: '',
  byName: {
    '.gitignore': '', '.gitattributes': '', '.gitmodules': '',
    dockerfile: '', 'docker-compose.yml': '', 'package.json': '', 'package-lock.json': '',
    license: '', makefile: '',
  },
  byExtension: {
    ...byCategory({ code: '', doc: '', data: '', image: '', archive: '', web: '' }),
    ts: '', tsx: '', jsx: '', js: '', mjs: '', cjs: '', py: '', rb: '',
    go: '', rs: '', java: '', swift: '', php: '', md: '', mdx: '',
    html: '', css: '', scss: '', json: '', sh: '', zsh: '', bash: '',
    pdf: '', lock: '', env: '',
  },
}

/** The glyph for a row: a directory open or closed, a link, else by file name then extension, else the plain file. */
export function iconOf(name: string, kind: 'file' | 'dir' | 'other', isOpen: boolean, isLink: boolean, set: Config['icons']): string {
  const icons = set === 'nerd' ? NERD : UNICODE
  if (kind === 'dir') return isOpen ? icons.dirOpen : icons.dirClosed
  if (isLink) return icons.link
  const lower = name.toLowerCase()
  const named = icons.byName[lower]
  if (named) return named
  const dot = lower.lastIndexOf('.')
  return (dot >= 0 ? icons.byExtension[lower.slice(dot + 1)] : undefined) ?? icons.file
}
