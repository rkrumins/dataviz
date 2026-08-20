/**
 * HistoryWindowSelector — the 24h / 7d / 30d / 90d segmented control, plus a
 * custom range.
 *
 * Same `role="group"` + `aria-pressed` shape as the Telemetry day-window
 * selector, so the two admin analytics surfaces behave identically.
 */
import { useEffect, useRef, useState } from 'react'
import { CalendarRange, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { HISTORY_WINDOWS, type HistoryWindowKey } from '@/hooks/useCountHistory'

export interface CustomRange {
    from?: string
    to?: string
}

export function HistoryWindowSelector({
    value, custom, onChange, retentionDays, className,
}: {
    value: HistoryWindowKey
    custom: CustomRange
    onChange: (value: HistoryWindowKey, custom: CustomRange) => void
    /** Windows beyond retention are still selectable but marked, so asking for
     *  90 days on a 30-day retention explains the short answer up front
     *  instead of looking like data loss. */
    retentionDays?: number
    className?: string
}) {
    const [open, setOpen] = useState(false)
    const popover = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!open) return
        const onDown = (e: MouseEvent) => {
            if (popover.current && !popover.current.contains(e.target as Node)) setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
    }, [open])

    return (
        <div className={cn('flex items-center gap-2', className)}>
            <div
                role="group"
                aria-label="Time window"
                className="flex items-center gap-1 p-1 rounded-xl border border-glass-border bg-canvas-elevated"
            >
                {HISTORY_WINDOWS.map((w) => {
                    const beyond = retentionDays != null && w.days > retentionDays
                    return (
                        <button
                            key={w.key}
                            type="button"
                            onClick={() => onChange(w.key, {})}
                            aria-pressed={value === w.key}
                            title={beyond
                                ? `Retention keeps ${retentionDays} days — this window will show what exists`
                                : undefined}
                            className={cn(
                                'px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors',
                                'outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                                value === w.key
                                    ? 'bg-indigo-500 text-white shadow-sm'
                                    : 'text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5',
                                beyond && value !== w.key && 'opacity-60',
                            )}
                        >
                            {w.label}
                        </button>
                    )
                })}
            </div>

            <div className="relative" ref={popover}>
                <button
                    type="button"
                    onClick={() => setOpen((o) => !o)}
                    aria-expanded={open}
                    aria-pressed={value === 'custom'}
                    className={cn(
                        'inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border text-sm font-semibold',
                        'outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 transition-colors',
                        value === 'custom'
                            ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400'
                            : 'border-glass-border bg-canvas-elevated text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5',
                    )}
                >
                    <CalendarRange className="w-4 h-4" />
                    {value === 'custom' && (custom.from || custom.to)
                        ? `${custom.from || '…'} → ${custom.to || 'now'}`
                        : 'Custom'}
                </button>

                {open && (
                    <div className={cn(
                        'absolute right-0 top-full mt-2 z-20 w-72 p-3',
                        'rounded-xl border border-glass-border bg-canvas-overlay shadow-glass-lg',
                    )}>
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-xs font-bold text-ink">Custom range</span>
                            <button
                                type="button"
                                onClick={() => setOpen(false)}
                                aria-label="Close"
                                className="p-1 rounded-md text-ink-muted hover:bg-black/5 dark:hover:bg-white/5"
                            >
                                <X className="w-3.5 h-3.5" />
                            </button>
                        </div>
                        <label className="block mb-2">
                            <span className="block text-[10px] font-semibold uppercase tracking-wide text-ink-muted mb-1">
                                From
                            </span>
                            <input
                                type="date"
                                value={custom.from ?? ''}
                                onChange={(e) => onChange('custom', { ...custom, from: e.target.value })}
                                className="w-full px-2 py-1.5 rounded-lg border border-glass-border bg-canvas-elevated text-sm text-ink"
                            />
                        </label>
                        <label className="block">
                            <span className="block text-[10px] font-semibold uppercase tracking-wide text-ink-muted mb-1">
                                To
                            </span>
                            <input
                                type="date"
                                value={custom.to ?? ''}
                                onChange={(e) => onChange('custom', { ...custom, to: e.target.value })}
                                className="w-full px-2 py-1.5 rounded-lg border border-glass-border bg-canvas-elevated text-sm text-ink"
                            />
                        </label>
                        <p className="mt-2 text-[10px] text-ink-muted">
                            Leave either end blank to anchor the range at today.
                        </p>
                    </div>
                )}
            </div>
        </div>
    )
}
