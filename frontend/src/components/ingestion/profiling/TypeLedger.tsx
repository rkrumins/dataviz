/**
 * Counts by type, start to now.
 *
 * The chart shows shape; this shows the numbers behind it, and it is the only
 * place a reader can compare two types that are orders of magnitude apart —
 * on a stacked area the small one is a hairline.
 *
 * ORDER IS THE ARGUMENT. Types that appeared or disappeared come first,
 * whatever their size, then the largest movements. A type reaching zero is the
 * clearest evidence something deleted data, and as a share of a large graph it
 * is frequently too small to rank anywhere near the top by magnitude — which
 * is exactly how it goes unnoticed.
 */
import { Fragment, useMemo, useState } from 'react'
import { ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'
import { exact } from '@/lib/formatMetric'
import { Sparkline } from '@/components/ui/Sparkline'
import { TablePagination } from '@/components/ui/TablePagination'
import { useProfilingSeries } from '@/hooks/useProfiling'
import type { ProfilingBreakdown } from '@/types/profiling'
import { TypeFocusChart } from './TypeFocusChart'
import { Segmented } from './BoardFilters'
import { deltaTone, signed } from './shared'

const PAGE = 10

const KINDS = [
    { key: 'entity_type' as const, label: 'Entity types' },
    { key: 'edge_type' as const, label: 'Relationship types' },
]

type TypeRow = {
    key: string
    label: string
    first: number
    last: number
    delta: number
    points: number[]
    state: 'new' | 'gone' | 'grew' | 'shrank' | 'steady'
}

export function TypeLedger({
    scope, id, window,
}: {
    scope: 'source' | 'workspace' | 'provider' | 'all'
    id?: string | null
    window: string
}) {
    const [kind, setKind] = useState<ProfilingBreakdown>('entity_type')
    const [page, setPage] = useState(0)
    // One row open at a time. Several expanded charts stacked in a table
    // is a worse version of the trellis, which already exists for that.
    const [open, setOpen] = useState<string | null>(null)

    const query = useMemo(() => ({
        scope, id, window, metric: 'total' as const, breakdown: kind, top: 20,
    }), [scope, id, window, kind])
    const { data, isLoading } = useProfilingSeries(query)

    const rows = useMemo<TypeRow[]>(() => {
        if (!data) return []
        const built = data.series
            .filter((s) => s.kind === 'type')
            .map((s) => {
                const values = s.points.map((p) => p.v)
                const first = values[0] ?? 0
                const last = values.at(-1) ?? 0
                const state: TypeRow['state'] = !first && last ? 'new'
                    : first && !last ? 'gone'
                        : last > first ? 'grew'
                            : last < first ? 'shrank' : 'steady'
                return { key: s.key, label: s.label, first, last, delta: last - first, points: values, state }
            })
        const weight = { gone: 0, new: 1, shrank: 2, grew: 3, steady: 4 }
        return built.sort((a, b) => {
            if (weight[a.state] !== weight[b.state]) return weight[a.state] - weight[b.state]
            return Math.abs(b.delta) - Math.abs(a.delta)
        })
    }, [data])

    /**
     * A column earns its place by VARYING.
     *
     * On a source that has not moved, Start and Now hold the same number in
     * every row, Change is a column of dashes and Trend has too few points to
     * draw — four columns carrying one fact. Share carries a different one:
     * "schemaField is 81% of this graph" is what someone wants from a static
     * profile, where "no change" is what they already read at the top.
     */
    const moved = rows.some((r) => r.delta !== 0)
    const hasTrend = rows.some(
        (r) => r.points.length >= 3 && r.points.some((v) => v !== 0),
    )
    const total = rows.reduce((sum, r) => sum + r.last, 0)

    /**
     * Visible columns, derived ONCE.
     *
     * Type, Count and Share are always present; Trend and the two movement
     * columns are conditional. An expansion row whose `colSpan` disagrees with
     * this makes the browser reflow a phantom column, which is what dropped
     * Count and Share out of every row the moment one was expanded.
     */
    const columnCount = 3 + (hasTrend ? 1 : 0) + (moved ? 2 : 0)

    const pageRows = rows.slice(page * PAGE, page * PAGE + PAGE)

    return (
        <section className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden shadow-sm">
            <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-glass-border">
                <div>
                    <h3 className="text-sm font-bold text-ink">Counts by type</h3>
                    <p className="text-xs text-ink-muted mt-0.5">
                        {moved
                            ? 'Types that appeared or disappeared come first.'
                            : 'Nothing moved in this window — this is what the source holds.'}
                    </p>
                </div>
                <Segmented
                    label="Type kind" options={KINDS} size="sm"
                    value={kind as 'entity_type' | 'edge_type'}
                    onChange={(next) => { setKind(next); setPage(0) }}
                />
            </header>

            {isLoading ? (
                <div className="p-4 space-y-2" aria-busy>
                    {[0, 1, 2].map((i) => (
                        <div key={i} className="h-8 rounded-lg bg-canvas animate-pulse" />
                    ))}
                </div>
            ) : rows.length ? (
                <>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-glass-border text-[11px] uppercase tracking-wide text-ink-muted">
                                    <th scope="col" className="text-left font-semibold pl-4 pr-3 py-2">Type</th>
                                    {hasTrend && (
                                        <th scope="col" className="text-left font-semibold px-3 py-2 hidden sm:table-cell">Trend</th>
                                    )}
                                    {moved && (
                                        <th scope="col" className="text-right font-semibold px-3 py-2">Start</th>
                                    )}
                                    <th scope="col" className="text-right font-semibold px-3 py-2">
                                        {moved ? 'Now' : 'Count'}
                                    </th>
                                    <th scope="col" className="text-right font-semibold px-3 py-2">Share</th>
                                    {moved && (
                                        <th scope="col" className="text-right font-semibold pr-4 pl-3 py-2">Change</th>
                                    )}
                                </tr>
                            </thead>
                            <tbody>
                                {pageRows.map((row) => (
                                    <Fragment key={row.key}>
                                    <tr
                                        className={cn(
                                            'border-b border-glass-border last:border-b-0 cursor-pointer',
                                            'hover:bg-canvas transition-colors',
                                            open === row.key && 'bg-canvas',
                                        )}
                                        onClick={() => setOpen(open === row.key ? null : row.key)}
                                        tabIndex={0}
                                        aria-expanded={open === row.key}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' || e.key === ' ') {
                                                e.preventDefault()
                                                setOpen(open === row.key ? null : row.key)
                                            }
                                        }}
                                    >
                                        <td className="pl-4 pr-3 py-2 align-middle">
                                            <span className="inline-flex items-center gap-1.5">
                                                <ChevronRight
                                                    className={cn(
                                                        'w-3.5 h-3.5 text-ink-muted transition-transform shrink-0',
                                                        open === row.key && 'rotate-90',
                                                    )}
                                                    aria-hidden
                                                />
                                                <span className="font-medium text-ink">{row.label}</span>
                                            </span>
                                            {(row.state === 'gone' || row.state === 'new') && (
                                                <span className={cn(
                                                    'ml-2 text-[10px] font-bold uppercase tracking-wide',
                                                    row.state === 'gone'
                                                        ? 'text-rose-600 dark:text-rose-400'
                                                        : 'text-emerald-600 dark:text-emerald-400',
                                                )}>
                                                    {row.state}
                                                </span>
                                            )}
                                        </td>
                                        {hasTrend && (
                                            <td className="px-3 py-2 hidden sm:table-cell align-middle">
                                                {row.points.length >= 3 && row.points.some((v) => v !== 0) ? (
                                                    <Sparkline
                                                        points={row.points}
                                                        width={88} height={20}
                                                        tone={row.delta < 0 ? 'red' : row.delta > 0 ? 'emerald' : 'slate'}
                                                        label={`${row.label} over the window`}
                                                    />
                                                ) : (
                                                    <span className="block h-px w-12 bg-glass-border" aria-hidden />
                                                )}
                                            </td>
                                        )}
                                        {moved && (
                                            <td className="px-3 py-2 text-right tabular-nums text-ink-secondary align-middle">
                                                {exact(row.first)}
                                            </td>
                                        )}
                                        <td className="px-3 py-2 text-right tabular-nums font-semibold text-ink align-middle">
                                            {exact(row.last)}
                                        </td>
                                        <td className="px-3 py-2 text-right align-middle">
                                            <ShareCell value={row.last} total={total} />
                                        </td>
                                        {moved && (
                                            <td className={cn(
                                                'pr-4 pl-3 py-2 text-right tabular-nums font-semibold align-middle',
                                                deltaTone(row.delta),
                                            )}>
                                                {signed(row.delta)}
                                            </td>
                                        )}
                                    </tr>
                                    {open === row.key && data && (
                                        <tr>
                                            <td colSpan={columnCount} className="px-4 pb-4 pt-1 bg-canvas">
                                                {/*
                                                  `w-0 min-w-full` breaks a feedback loop.

                                                  The chart measures its container to draw at
                                                  1 viewBox unit = 1 CSS pixel, and falls back
                                                  to 720px until the observer fires. In an
                                                  auto-layout table the cell then sizes to that
                                                  720px, the observer measures 720, and the
                                                  table stays wider than the drawer for good.
                                                  A zero-width box contributes nothing to the
                                                  intrinsic calculation, so the table sizes from
                                                  the real rows and this stretches to fit.
                                                */}
                                                <div className="w-0 min-w-full">
                                                <TypeFocusChart
                                                    label={row.label}
                                                    buckets={data.buckets}
                                                    values={row.points}
                                                    kind={kind === 'edge_type' ? 'edges' : 'nodes'}
                                                />
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                    </Fragment>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    {rows.length > PAGE && (
                        <div className="flex items-center justify-between gap-3 px-4 py-2 border-t border-glass-border">
                            <p className="text-[11px] text-ink-muted">
                                Showing {page * PAGE + 1}–
                                {Math.min(rows.length, (page + 1) * PAGE)} of {rows.length}
                            </p>
                            <TablePagination
                                page={page}
                                pageSize={PAGE}
                                total={rows.length}
                                onPageChange={setPage}
                            />
                        </div>
                    )}
                </>
            ) : (
                <p className="px-4 py-6 text-sm text-ink-muted">
                    No {kind === 'entity_type' ? 'entity' : 'relationship'} types recorded
                    in this window.
                </p>
            )}
        </section>
    )
}


/**
 * A type's share of the profile, as a number and as a bar.
 *
 * The bar is a proportion of the WHOLE, not of the leader: the question is
 * "how much of this graph is that", and scaling to the largest type would
 * make a 3% type look substantial whenever the biggest one happens to be
 * small. All one colour — length already encodes the value, and spending hue
 * on it would double-encode.
 */
function ShareCell({ value, total }: { value: number; total: number }) {
    const pct = total > 0 ? (value / total) * 100 : 0
    return (
        <span className="inline-flex items-center justify-end gap-2 w-full">
            <span
                className="hidden md:block h-1.5 w-16 rounded-full bg-glass-border overflow-hidden shrink-0"
                aria-hidden
            >
                <span
                    className="block h-full rounded-full bg-indigo-500/70"
                    style={{ width: `${Math.max(pct > 0 ? 2 : 0, Math.min(100, pct))}%` }}
                />
            </span>
            <span className="tabular-nums text-ink-secondary w-11 text-right">
                {pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%
            </span>
        </span>
    )
}
