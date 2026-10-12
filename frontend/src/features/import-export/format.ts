/** A byte count for people: 512 B, 3.4 KB, 12.5 MB, 1.2 GB. */
export function prettyBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** "42s", "2m 14s", "1h 05m". */
export function formatElapsed(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ${String(secs % 60).padStart(2, '0')}s`
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`
}

/** Roughly how long is left, from how long the part done took; null until that says anything. */
export function timeLeft(elapsedMs: number, pct: number | null): string | null {
  if (pct == null || pct < 3 || elapsedMs < 15_000) return null
  const mins = Math.round((elapsedMs * (100 - pct)) / pct / 60_000)
  if (mins < 1) return 'less than a minute left'
  if (mins === 1) return 'about a minute left'
  if (mins < 60) return `about ${mins} min left`
  return `about ${Math.floor(mins / 60)} h ${mins % 60} min left`
}
