/**
 * Relative time formatting — "2h ago", "3d ago", "just now", etc.
 */

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const MONTH = 30 * DAY
const YEAR = 365 * DAY

export function timeAgo(dateString: string): string {
  const date = new Date(dateString)
  const now = Date.now()
  const seconds = Math.floor((now - date.getTime()) / 1000)

  if (seconds < 0) return 'just now'
  if (seconds < MINUTE) return 'just now'
  if (seconds < HOUR) {
    const m = Math.floor(seconds / MINUTE)
    return `${m}m ago`
  }
  if (seconds < DAY) {
    const h = Math.floor(seconds / HOUR)
    return `${h}h ago`
  }
  if (seconds < WEEK) {
    const d = Math.floor(seconds / DAY)
    return `${d}d ago`
  }
  if (seconds < MONTH) {
    const w = Math.floor(seconds / WEEK)
    return `${w}w ago`
  }
  if (seconds < YEAR) {
    const m = Math.floor(seconds / MONTH)
    return `${m}mo ago`
  }
  const y = Math.floor(seconds / YEAR)
  return `${y}y ago`
}
