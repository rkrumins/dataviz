/**
 * FreshnessStat — one fact about when something happened, in a drawer's footer: Created, Updated,
 * Synced. A tinted icon and label, the time, then who did it (with their avatar) or what it
 * means. The exact UTC time, and anything more, is in the tooltip. Fills its grid cell, so a row
 * of them lines up whatever each one says.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { formatUtc, timeAgo } from '@/lib/timeAgo'
import { HoverTip } from '@/components/ui/HoverTip'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { Skeleton } from '@/components/ui/Skeleton'

const TONES = {
  sky: { chip: 'bg-sky-500/10 text-sky-600 dark:text-sky-300', label: 'text-sky-700 dark:text-sky-300' },
  indigo: { chip: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-300', label: 'text-indigo-700 dark:text-indigo-300' },
  emerald: { chip: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300', label: 'text-emerald-700 dark:text-emerald-300' },
  amber: { chip: 'bg-amber-500/10 text-amber-600 dark:text-amber-300', label: 'text-amber-700 dark:text-amber-300' },
} as const

export function FreshnessStat({ icon, label, iso, tone, loading, live, overrideValue, emptyText = '—', by, tag, note, tip }: {
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
  /** A small tag after the time — "draft" for the draft's own change. */
  tag?: string
  /** The quieter last line when there is no one to name. */
  note?: string
  /** More for the tooltip, under the exact time. */
  tip?: ReactNode
}) {
  const t = TONES[tone]
  const value = overrideValue ?? (iso ? timeAgo(iso) : emptyText)
  const body = (
    <div className="w-full min-w-0 flex flex-col gap-1 px-2.5 py-2 rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.03]">
      <span className="flex items-center gap-1.5 min-w-0">
        <span className={cn('w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 [&>svg]:w-3.5 [&>svg]:h-3.5', t.chip)} aria-hidden>{icon}</span>
        <span className={cn('min-w-0 truncate text-[10px] font-semibold uppercase tracking-wide', t.label)}>{label}</span>
        {live && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse motion-reduce:animate-none flex-shrink-0" aria-hidden />}
      </span>
      {loading ? (
        <>
          <Skeleton className="h-4 w-14" />
          <Skeleton className="h-3 w-20" />
        </>
      ) : (
        <>
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="text-sm font-bold text-ink truncate">{value}</span>
            {tag && (
              <span className="px-1 rounded text-[10px] font-medium bg-amber-500/10 text-amber-700 dark:text-amber-300 flex-shrink-0">
                {tag}
              </span>
            )}
          </span>
          {by && iso ? (
            <span className="flex items-center gap-1 min-w-0 text-[11px] text-ink-muted">
              <UserAvatar userId={by.id} name={by.name} className="w-4 h-4 text-[8px] flex-shrink-0" />
              <span className="truncate">{by.name}</span>
            </span>
          ) : note ? (
            <span className="text-[11px] text-ink-muted truncate">{note}</span>
          ) : null}
        </>
      )}
    </div>
  )
  return iso && !loading
    ? <HoverTip label={formatUtc(iso)} detail={tip} width="data" className="flex min-w-0">{body}</HoverTip>
    : body
}
