/**
 * LabelLedger — counts by type, over time, as a scannable table.
 *
 * The chart answers "what shape is this"; this answers "which label, exactly,
 * and by how much". Sorted by the magnitude of change rather than by size,
 * because a label that lost 40,000 rows matters more than the label that has
 * always been the biggest and still is.
 */
import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Minus } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Sparkline } from '@/components/ui/Sparkline'
import { TablePagination } from '@/components/ui/TablePagination'
import type { LabelSeriesSummary } from '@/types/insights'
import { compactNum, formatPct, signedNum } from './shared'

const PAGE_SIZE = 12

const STATE_META: Record<string, { label: string; className: string }> = {
    new: {
        label: 'New',
        className: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
    },
    gone: {
        label: 'Gone',
        className: 'text-red-600 dark:text-red-400 bg-red-500/10 border-red-500/20',
    },
    grew: { label: 'Grew', className: 'text-ink-muted bg-black/5 dark:bg-white/5 border-transparent' },
    shrank: { label: 'Shrank', className: 'text-ink-muted bg-black/5 dark:bg-white/5 border-transparent' },
    steady: { label: 'Steady', className: 'text-ink-muted bg-black/5 dark:bg-white/5 border-transparent' },
}

export function LabelLedger({ labels, unit = 'entities', className }: {
    labels: LabelSeriesSummary[]
    unit?: string
    className?: string
}) {
    const [page, setPage] = useState(0)

    // `new` and `gone` float to the top regardless of magnitude: a label
    // appearing or disappearing is a categorically different event from one
    // changing size, and burying it under a bigger numeric delta would hide
    // the finding this page exists to produce.
    const sorted = useMemo(() => {
        const weight = (s: string) => (s === 'gone' ? 0 : s === 'new' ? 1 : 2)
        return [...labels].sort((a, b) =>
            weight(a.state) - weight(b.state) ||
            Math.abs(b.delta) - Math.abs(a.delta) ||
            a.label.localeCompare(b.label),
        )
    }, [labels])

    if (!sorted.length) {
        return (
            <p className={cn('text-sm text-ink-muted', className)}>
                No {unit} recorded in this window.
            </p>
        )
    }

    const shown = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

    return (
        <div className={className}>
            <div className="overflow-x-auto">
                <table className="w-full min-w-[36rem]">
                    <thead>
                        <tr className="border-b border-glass-border">
                            <th className="text-left text-xs font-semibold text-ink-muted uppercase tracking-wider px-4 py-3">
                                Label
                            </th>
                            <th className="text-left text-xs font-semibold text-ink-muted uppercase tracking-wider px-4 py-3 w-28">
                                Trend
                            </th>
                            <th className="text-right text-xs font-semibold text-ink-muted uppercase tracking-wider px-4 py-3">
                                Start
                            </th>
                            <th className="text-right text-xs font-semibold text-ink-muted uppercase tracking-wider px-4 py-3">
                                Now
                            </th>
                            <th className="text-right text-xs font-semibold text-ink-muted uppercase tracking-wider px-4 py-3">
                                Change
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {shown.map((row, i) => {
                            const meta = STATE_META[row.state] ?? STATE_META.steady
                            const pct = formatPct(
                                row.first ? ((row.last - row.first) / row.first) * 100 : null,
                            )
                            const Icon = row.delta > 0 ? ArrowUp : row.delta < 0 ? ArrowDown : Minus
                            return (
                                <tr
                                    key={row.label}
                                    className={cn(
                                        'border-b last:border-b-0 border-glass-border',
                                        i % 2 === 0 && 'bg-black/[0.01] dark:bg-white/[0.01]',
                                    )}
                                >
                                    <td className="px-4 py-2.5 min-w-0">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <span className="text-sm font-semibold text-ink truncate">
                                                {row.label}
                                            </span>
                                            {(row.state === 'new' || row.state === 'gone') && (
                                                <span className={cn(
                                                    'shrink-0 px-1.5 py-0.5 rounded-full border',
                                                    'text-[9px] font-bold uppercase tracking-wide',
                                                    meta.className,
                                                )}>
                                                    {meta.label}
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-4 py-2.5">
                                        {/* Sparkline self-suppresses below 3 points, so a
                                            two-observation window shows the numbers alone
                                            rather than a misleading straight line. */}
                                        <Sparkline
                                            points={row.points}
                                            width={88}
                                            height={20}
                                            tone={row.delta < 0 ? 'red' : row.delta > 0 ? 'emerald' : 'slate'}
                                            label={row.label}
                                        />
                                    </td>
                                    <td className="px-4 py-2.5 text-right text-sm text-ink-secondary tabular-nums">
                                        {compactNum(row.first)}
                                    </td>
                                    <td className="px-4 py-2.5 text-right text-sm font-semibold text-ink tabular-nums">
                                        {compactNum(row.last)}
                                    </td>
                                    <td className="px-4 py-2.5 text-right tabular-nums">
                                        <span className={cn(
                                            'inline-flex items-center gap-1 text-sm font-bold',
                                            row.delta > 0
                                                ? 'text-emerald-600 dark:text-emerald-400'
                                                : row.delta < 0
                                                    ? 'text-red-600 dark:text-red-400'
                                                    : 'text-ink-muted',
                                        )}>
                                            <Icon className="w-3 h-3" />
                                            {signedNum(row.delta)}
                                        </span>
                                        {pct && row.delta !== 0 && (
                                            <span className="block text-[10px] text-ink-muted">{pct}</span>
                                        )}
                                    </td>
                                </tr>
                            )
                        })}
                    </tbody>
                </table>
            </div>
            <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="text-[11px] text-ink-muted tabular-nums">
                    Showing {shown.length} of {sorted.length}
                </span>
                <TablePagination
                    page={page}
                    pageSize={PAGE_SIZE}
                    total={sorted.length}
                    onPageChange={setPage}
                />
            </div>
        </div>
    )
}
