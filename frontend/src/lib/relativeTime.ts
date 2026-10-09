/**
 * Coarse "how long ago" for lists of recent events (trace history, canvas
 * message history). Deliberately blunt — under a minute is "just now", and
 * anything past a day rounds to whole days: these surfaces answer "recently?",
 * not "exactly when?".
 */
export function relativeTime(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
