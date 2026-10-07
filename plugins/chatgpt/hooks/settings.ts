// A time limit setting in minutes as milliseconds: the default when it is not a positive number, 24 h at most.
export function limitMs(raw: unknown, defaultMinutes: number): number {
  const minutes = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return Math.round(defaultMinutes * 60_000)
  return Math.round(Math.min(minutes, 24 * 60) * 60_000)
}
