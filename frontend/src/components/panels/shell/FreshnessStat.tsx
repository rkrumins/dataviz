/**
 * FreshnessStat — one fact about when something happened, in a drawer's footer: "Updated 3h ago
 * by Ana", "Synced just now". The exact UTC time is in the tooltip; a person gets their avatar.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { formatUtc, timeAgo } from '@/lib/timeAgo'
import { HoverTip } from '@/components/ui/HoverTip'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { Skeleton } from '@/components/ui/Skeleton'

const TONES = {
  indigo: { chip: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-300', label: 'text-indigo-700 dark:text-indigo-300' },
  emerald: { chip: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300', label: 'text-emerald-700 dark:text-emerald-300' },
  amber: { chip: 'bg-amber-500/10 text-amber-600 dark:text-amber-300', label: 'text-amber-700 dark:text-amber-300' },
} as const

export function FreshnessStat({ icon, label, iso, tone, loading, live, overrideValue, emptyText = '—', by }: {
  icon: ReactNode
  label: string
  iso?: string | null
  tone: keyof typeof TONES
  loading?: boolean
  /** A live pulse beside the label (the value is being kept current). */
  live?: boolean
  overrideValue?: string
  emptyText?: string
  /** Who did it — shown with their avatar. */
  by?: { id?: string | null; name: string }
}) {
  const t = TONES[tone]
  const value = overrideValue ?? (iso ? timeAgo(iso) : emptyText)
  const body = (
    <div className="flex items-center gap-2.5 min-w-0 px-2.5 py-2 rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.03]">
      <span className={cn('w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0', t.chip)} aria-hidden>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className={cn('flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide', t.label)}>
          {label}
          {live && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse motion-reduce:animate-none" aria-hidden />}
        </span>
        {loading ? (
          <Skeleton className="h-3.5 w-20 mt-1" />
        ) : (
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-bold text-ink truncate">{value}</span>
            {by && iso && (
              <span className="flex items-center gap-1 min-w-0 text-[11px] text-ink-muted">
                <UserAvatar userId={by.id} name={by.name} className="w-4 h-4 text-[8px] flex-shrink-0" />
                <span className="truncate">{by.name}</span>
              </span>
            )}
          </span>
        )}
      </span>
    </div>
  )
  return iso && !loading
    ? <HoverTip label={formatUtc(iso)} width="data" className="flex min-w-0">{body}</HoverTip>
    : body
}
