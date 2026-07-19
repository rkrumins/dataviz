import { History } from 'lucide-react'

/** A small "Updated <date>" freshness chip. Renders nothing without a date. */
export function UpdatedChip({ date }: { date?: string }) {
  if (!date) return null
  // date is an ISO day string (YYYY-MM-DD); format it readably without TZ drift.
  let label = date
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (m) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    label = `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium text-ink-muted bg-black/[0.04] dark:bg-white/[0.06]">
      <History className="w-3.5 h-3.5" />
      Updated {label}
    </span>
  )
}
