/**
 * CoverageStrip — how much of the requested window history actually covers.
 *
 * This exists because of one specific misreading. History begins the first
 * time capture runs, so on a fresh deploy a 30-day view legitimately holds
 * three days — and a chart that starts three days ago, with no explanation,
 * looks exactly like a chart that lost twenty-seven days of data. Stating the
 * coverage up front removes the ambiguity before anyone raises an incident.
 */
import { useState } from 'react'
import { Clock, Database, History, Settings2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { formatUtc, toUtcDate } from '@/lib/timeAgo'
import { HistorySettingsDialog } from './HistorySettingsDialog'

export function CoverageStrip({
    coverageFrom, requestedFrom, requestedTo, retentionDays, snapshots, changed, className,
}: {
    coverageFrom: string | null
    requestedFrom: string
    requestedTo: string
    retentionDays: number
    snapshots: number
    changed: number
    className?: string
}) {
    const [editingRetention, setEditingRetention] = useState(false)
    const oldest = toUtcDate(coverageFrom)
    const requested = toUtcDate(requestedFrom)
    // Both ends of the WINDOW, never the wall clock. The statement is about
    // the range the reader asked for, and reading `Date.now()` during render
    // would also make this component impure for no gain.
    const end = toUtcDate(requestedTo)?.getTime() ?? requested?.getTime() ?? 0

    const requestedDays = requested
        ? Math.max(1, Math.round((end - requested.getTime()) / 86_400_000))
        : null
    const coveredDays = oldest
        ? Math.max(0, Math.round((end - Math.max(oldest.getTime(), requested?.getTime() ?? 0)) / 86_400_000))
        : 0

    // Only call coverage "partial" when history genuinely starts inside the
    // window. A day of slack absorbs the rounding above rather than nagging
    // about an hour.
    const partial =
        requestedDays != null && oldest != null &&
        oldest.getTime() > (requested?.getTime() ?? 0) &&
        coveredDays < requestedDays - 1

    return (
        <div className={cn(
            'flex flex-wrap items-center gap-x-5 gap-y-1.5 px-4 py-2.5',
            'rounded-xl border border-glass-border bg-canvas-elevated',
            className,
        )}>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-secondary">
                <History className="w-3.5 h-3.5 text-ink-muted" />
                {oldest ? (
                    partial ? (
                        <>
                            History covers{' '}
                            <strong className="text-ink font-semibold tabular-nums">
                                {coveredDays} of {requestedDays} days
                            </strong>{' '}
                            — capture started {formatUtc(coverageFrom)}
                        </>
                    ) : (
                        <>
                            Full window covered · oldest snapshot{' '}
                            <strong className="text-ink font-semibold">{formatUtc(coverageFrom)}</strong>
                        </>
                    )
                ) : (
                    <>No snapshots recorded yet</>
                )}
            </span>

            <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-secondary">
                <Database className="w-3.5 h-3.5 text-ink-muted" />
                <strong className="text-ink font-semibold tabular-nums">{snapshots}</strong>
                {' '}observations ·{' '}
                <strong className="text-ink font-semibold tabular-nums">{changed}</strong>
                {' '}with changes
            </span>

            {/* The retention control lives on the number it governs. A reader
                who has just been told the series only goes back 30 days is the
                one person who wants to change that, and a settings page three
                clicks away is where that intent goes to die. */}
            <button
                type="button"
                onClick={() => setEditingRetention(true)}
                className={cn(
                    'inline-flex items-center gap-1.5 text-[11px] text-ink-secondary',
                    'px-1.5 py-0.5 -mx-1.5 rounded-lg transition-colors outline-none',
                    'hover:bg-black/5 dark:hover:bg-white/5',
                    'focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                )}
            >
                <Clock className="w-3.5 h-3.5 text-ink-muted" />
                Retention{' '}
                <strong className="text-ink font-semibold tabular-nums">{retentionDays} days</strong>
                <Settings2 className="w-3 h-3 text-ink-muted" />
            </button>

            {editingRetention && (
                <HistorySettingsDialog onClose={() => setEditingRetention(false)} />
            )}
        </div>
    )
}
