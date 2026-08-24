/**
 * The board: what moved.
 *
 * Every other profiling read starts from a source you already chose. This one
 * starts from the question an operator opens the page with — *what moved, and
 * by how much* — and lets the source be the ANSWER rather than the input. A
 * row is therefore a way in, not a readout: clicking one opens that source's
 * full profile without leaving the board behind.
 *
 * ORDERING carries the argument. Unusual movement first, then magnitude, then
 * name. Sorting by magnitude alone buries a catastrophic drop on a small graph
 * beneath ordinary churn on a large one, and sorting by name buries everything
 * under whoever called their source "1111".
 *
 * Sources with no observation in the window are COUNTED, never listed at zero.
 * A source that was not observed did not drop to nothing, and a row showing it
 * at zero would invent an outage.
 */
import { useMemo, useState } from 'react'
import {
    ArrowDown, ArrowUp, ChevronRight, Database, EyeOff,
    Radio, Settings2, TrendingUp, TriangleAlert,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { compact, exact } from '@/lib/formatMetric'
import { KpiCard } from '@/components/analytics/KpiCard'
import { Sparkline } from '@/components/ui/Sparkline'
import {
    DEFAULT_WINDOW, PROFILING_WINDOWS, type ProfilingWindowKey,
    useProfilingBoard,
} from '@/hooks/useProfiling'
import { useCanReadProfiling } from '@/hooks/useProfilingAccess'
import type { BoardRow } from '@/types/profiling'
import { FilterSelect, SearchField, Segmented, Toggle } from './BoardFilters'
import { FindingsBand } from './FindingsBand'
import { ProfilingSettings } from './ProfilingSettings'
import { ProfilingSourceDrawer } from './ProfilingSourceDrawer'
import { BoardVerdict } from './Verdict'
import { formatInstant, deltaTone, metricNoun, signed, significanceMeta } from './shared'
import { UtcChip } from './UtcChip'

const MEASURES = [
    { key: 'nodes' as const, label: 'Entities' },
    { key: 'edges' as const, label: 'Relationships' },
]

const WINDOWS = PROFILING_WINDOWS.map((w) => ({ key: w.key, label: w.label }))

type SortKey = 'movement' | 'size' | 'name' | 'recent'

interface Props {
    /** Narrows the board to one workspace. The workspace Profiling tab passes
     *  this; the Ingestion tab does not. */
    workspaceId?: string | null
    onOpenSource?: (row: BoardRow) => void
    className?: string
}

export function ProfilingBoard({ workspaceId, onOpenSource, className }: Props) {
    const canRead = useCanReadProfiling()
    const [window, setWindow] = useState<ProfilingWindowKey>(DEFAULT_WINDOW)
    const [metric, setMetric] = useState<'nodes' | 'edges'>('nodes')
    const [unusualOnly, setUnusualOnly] = useState(false)
    const [providerId, setProviderId] = useState<string | ''>('')
    const [search, setSearch] = useState('')
    const [sort, setSort] = useState<SortKey>('movement')
    const [descending, setDescending] = useState(true)
    // The board's own drill-down. A host that has a richer place to send the
    // reader (the workspace panel, with its aggregation and versioning tabs)
    // passes `onOpenSource` and owns the navigation instead.
    const [drilling, setDrilling] = useState<BoardRow | null>(null)
    const [settingsOpen, setSettingsOpen] = useState(false)

    const query = useMemo(() => ({
        window, workspaceId, metric, limit: 500,
    }), [window, workspaceId, metric])

    const board = useProfilingBoard(query, { enabled: canRead })
    const rows = board.data?.rows ?? []

    const providers = useMemo(() => {
        const seen = new Map<string, { key: string; label: string; count: number }>()
        rows.forEach((r) => {
            if (!r.provider_id) return
            const entry = seen.get(r.provider_id)
            if (entry) entry.count += 1
            else seen.set(r.provider_id, {
                key: r.provider_id,
                label: r.provider_name || r.provider_id,
                count: 1,
            })
        })
        return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label))
    }, [rows])

    const visible = useMemo(() => {
        const needle = search.trim().toLowerCase()
        const filtered = rows.filter((r) => {
            if (unusualOnly && r.significance === 'normal') return false
            if (providerId && r.provider_id !== providerId) return false
            if (needle && !(
                r.name.toLowerCase().includes(needle)
                || (r.provider_name ?? '').toLowerCase().includes(needle)
            )) return false
            return true
        })
        const direction = descending ? 1 : -1
        return [...filtered].sort((a, b) => {
            if (sort === 'name') return a.name.localeCompare(b.name) * -direction
            if (sort === 'size') return (b.last - a.last) * direction
            if (sort === 'recent') {
                return (b.last_observed_at ?? '').localeCompare(a.last_observed_at ?? '') * direction
            }
            // Movement: unusual first, then magnitude. A catastrophic drop on a
            // small graph must outrank ordinary churn on a large one.
            const rank = significanceMeta(b.significance).rank - significanceMeta(a.significance).rank
            if (rank !== 0) return rank * direction
            return (Math.abs(b.delta) - Math.abs(a.delta)) * direction
        })
    }, [rows, search, unusualOnly, providerId, sort, descending])

    if (!canRead) return null

    const unusualCount = rows.filter((r) => r.significance !== 'normal').length
    const movedCount = rows.filter((r) => r.delta !== 0).length

    return (
        <div className={cn('space-y-5', className)}>
            <Controls
                window={window} onWindow={setWindow}
                metric={metric} onMetric={setMetric}
                unusualOnly={unusualOnly} onUnusualOnly={setUnusualOnly}
                providerId={providerId} onProvider={setProviderId}
                providers={providers}
                search={search} onSearch={setSearch}
                onOpenSettings={() => setSettingsOpen(true)}
            />

            {board.isLoading && <BoardSkeleton />}

            {board.isError && (
                <ErrorPanel
                    message={board.error?.message}
                    onRetry={() => board.refetch()}
                />
            )}

            {board.data && (
                <>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                        <KpiCard
                            label="Sources reporting"
                            value={exact(rows.length)}
                            icon={Database}
                            accent="indigo"
                            sub={board.data.platform_wide ? 'across the platform' : 'in your workspaces'}
                        />
                        <KpiCard
                            label={`${metric === 'nodes' ? 'Entities' : 'Relationships'} now`}
                            value={compact(rows.reduce((sum, r) => sum + r.last, 0))}
                            icon={TrendingUp}
                            accent="cyan"
                            sub={`${movedCount} ${movedCount === 1 ? 'source' : 'sources'} moved`}
                        />
                        <KpiCard
                            label="Need a look"
                            value={exact(unusualCount)}
                            icon={TriangleAlert}
                            accent={unusualCount ? 'amber' : 'emerald'}
                            sub={unusualCount ? 'moved outside their normal range' : 'nothing unusual'}
                        />
                        <KpiCard
                            label="Not observed"
                            value={exact(board.data.unobserved)}
                            icon={EyeOff}
                            accent={board.data.unobserved ? 'violet' : 'emerald'}
                            // The distinction the whole count exists for. A
                            // source that was not observed did not drop to zero.
                            sub={board.data.unobserved
                                ? 'reported nothing in this window'
                                : 'every source reported'}
                        />
                    </div>

                    <BoardVerdict board={board.data} />
                    <FindingsBand />

                    <BoardTable
                        rows={visible}
                        total={rows.length}
                        metric={metric}
                        sort={sort}
                        descending={descending}
                        onSort={(next) => {
                            if (next === sort) setDescending((d) => !d)
                            else { setSort(next); setDescending(true) }
                        }}
                        onOpenSource={onOpenSource ?? setDrilling}
                        onClearFilters={() => {
                            setSearch(''); setProviderId(''); setUnusualOnly(false)
                        }}
                    />
                </>
            )}

            {!onOpenSource && (
                <ProfilingSourceDrawer row={drilling} onClose={() => setDrilling(null)} />
            )}

            {settingsOpen && (
                <ProfilingSettings
                    onClose={() => setSettingsOpen(false)}
                    // So the cost preview can scale from per-source to
                    // this deployment, using what is actually reporting.
                    sourceCount={rows.length}
                />
            )}
        </div>
    )
}

function Controls({
    window, onWindow, metric, onMetric, unusualOnly, onUnusualOnly,
    providerId, onProvider, providers, search, onSearch, onOpenSettings,
}: {
    window: ProfilingWindowKey
    onWindow: (next: ProfilingWindowKey) => void
    metric: 'nodes' | 'edges'
    onMetric: (next: 'nodes' | 'edges') => void
    unusualOnly: boolean
    onUnusualOnly: (next: boolean) => void
    providerId: string | ''
    onProvider: (next: string | '') => void
    providers: { key: string; label: string; count: number }[]
    search: string
    onSearch: (next: string) => void
    onOpenSettings: () => void
}) {
    return (
        <div className="flex flex-wrap items-center gap-2">
            <Segmented label="Time window" options={WINDOWS} value={window} onChange={onWindow} />
            <Segmented label="Measure" options={MEASURES} value={metric} onChange={onMetric} />
            <span className="hidden lg:block h-5 w-px bg-glass-border" aria-hidden />
            <SearchField value={search} onChange={onSearch} placeholder="Find a source" />
            {providers.length > 1 && (
                <FilterSelect
                    label="All providers"
                    value={providerId}
                    onChange={onProvider}
                    options={providers}
                />
            )}
            <Toggle checked={unusualOnly} onChange={onUnusualOnly} label="Unusual only" />
            <span className="ml-auto flex items-center gap-2">
                <UtcChip />
                {/* Retention lives here because this is the fleet-wide surface
                    and because retention is what EXPLAINS the windows beside
                    it. Non-admins see it read-only: a policy someone cannot
                    change is still the answer to "why does my window stop
                    there". */}
                <button
                    type="button"
                    onClick={onOpenSettings}
                    className={cn(
                        'inline-flex items-center gap-1.5 rounded-xl border border-glass-border',
                        'bg-canvas px-2.5 py-1.5 text-xs font-semibold text-ink-muted',
                        'hover:text-ink transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
                    )}
                >
                    <Settings2 className="w-3.5 h-3.5" aria-hidden />
                    Retention
                </button>
            </span>
        </div>
    )
}

function SortHeader({
    label, sortKey, active, descending, onSort, align = 'left', className,
}: {
    label: string
    sortKey: SortKey
    active: boolean
    descending: boolean
    onSort: (key: SortKey) => void
    align?: 'left' | 'right'
    className?: string
}) {
    const Arrow = descending ? ArrowDown : ArrowUp
    return (
        <th
            scope="col"
            aria-sort={active ? (descending ? 'descending' : 'ascending') : 'none'}
            className={cn('font-semibold px-3 py-2', align === 'right' ? 'text-right' : 'text-left', className)}
        >
            <button
                type="button"
                onClick={() => onSort(sortKey)}
                className={cn(
                    'inline-flex items-center gap-1 transition-colors',
                    align === 'right' && 'flex-row-reverse',
                    active ? 'text-ink' : 'hover:text-ink',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded',
                )}
            >
                {label}
                <Arrow className={cn('w-3 h-3', active ? 'opacity-100' : 'opacity-0')} aria-hidden />
            </button>
        </th>
    )
}

function BoardTable({
    rows, total, metric, sort, descending, onSort, onOpenSource, onClearFilters,
}: {
    rows: BoardRow[]
    total: number
    metric: 'nodes' | 'edges'
    sort: SortKey
    descending: boolean
    onSort: (key: SortKey) => void
    onOpenSource?: (row: BoardRow) => void
    onClearFilters: () => void
}) {
    if (!total) {
        return (
            <EmptyPanel
                title="Nothing to rank yet"
                body="Counts are captured whenever they change, at every refresh run, and at least once an hour otherwise. Widening the window reaches further back — it cannot reach before a source's first capture."
            />
        )
    }
    if (!rows.length) {
        return (
            <EmptyPanel
                title="Nothing matches these filters"
                body={`${total} ${total === 1 ? 'source' : 'sources'} reported in this window.`}
                action={
                    <button
                        type="button"
                        onClick={onClearFilters}
                        className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                        Clear filters
                    </button>
                }
            />
        )
    }

    const interactive = Boolean(onOpenSource)

    return (
        <div className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <caption className="sr-only">
                        Data sources, ordered by {sort}
                    </caption>
                    <thead>
                        <tr className="border-b border-glass-border text-[11px] uppercase tracking-wide text-ink-muted bg-canvas/40">
                            <SortHeader
                                label="Source" sortKey="name" active={sort === 'name'}
                                descending={descending} onSort={onSort} className="pl-4"
                            />
                            <th scope="col" className="text-left font-semibold px-3 py-2 hidden md:table-cell">
                                Shape
                            </th>
                            <SortHeader
                                label="Now" sortKey="size" active={sort === 'size'}
                                descending={descending} onSort={onSort} align="right"
                            />
                            <SortHeader
                                label="Moved" sortKey="movement" active={sort === 'movement'}
                                descending={descending} onSort={onSort} align="right"
                            />
                            <SortHeader
                                label="Last profiled" sortKey="recent" active={sort === 'recent'}
                                descending={descending} onSort={onSort} align="right"
                                className="hidden sm:table-cell"
                            />
                            <th scope="col" className="w-9" aria-label="Open" />
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((row) => (
                            <Row
                                key={row.data_source_id}
                                row={row}
                                metric={metric}
                                interactive={interactive}
                                onOpen={() => onOpenSource?.(row)}
                            />
                        ))}
                    </tbody>
                </table>
            </div>
            <p className="px-4 py-2 border-t border-glass-border text-[11px] text-ink-muted">
                Showing {rows.length} of {total}
            </p>
        </div>
    )
}

function Row({
    row, metric, interactive, onOpen,
}: {
    row: BoardRow
    metric: 'nodes' | 'edges'
    interactive: boolean
    onOpen: () => void
}) {
    const meta = significanceMeta(row.significance)
    const unusual = row.significance !== 'normal'

    return (
        <tr
            className={cn(
                'border-b border-glass-border last:border-b-0 transition-colors',
                interactive && 'hover:bg-canvas cursor-pointer',
                // A left rule rather than a tinted row: the tint would fight
                // the delta's own colour, which is the number that matters.
                unusual && 'shadow-[inset_2px_0_0_0_currentColor]',
                unusual && meta.tone,
            )}
            onClick={interactive ? onOpen : undefined}
            tabIndex={interactive ? 0 : undefined}
            onKeyDown={interactive ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() }
            } : undefined}
        >
            <td className="pl-4 pr-3 py-2.5 align-middle">
                <span className="block font-semibold text-ink truncate max-w-[18rem]">
                    {row.name}
                </span>
                <span className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[11px] text-ink-muted truncate">
                        {row.provider_name || 'Unknown provider'}
                    </span>
                    {unusual && (
                        <span className={cn(
                            'text-[10px] font-bold uppercase tracking-wide', meta.tone,
                        )}>
                            · {meta.label}
                        </span>
                    )}
                </span>
            </td>

            <td className="px-3 py-2.5 hidden md:table-cell align-middle">
                {row.points.length >= 3 ? (
                    <Sparkline
                        points={row.points}
                        width={120}
                        height={24}
                        tone={row.delta < 0 ? 'red' : row.delta > 0 ? 'emerald' : 'slate'}
                        label={`${row.name} over the window`}
                    />
                ) : (
                    // A first observation is not a failure to have a trend —
                    // it is where a trend starts. Saying "too few points" 58
                    // times says nothing; a rule says "nothing to draw yet"
                    // and gets out of the way.
                    <span
                        className="block h-px w-16 bg-glass-border"
                        title={row.observations === 1 ? 'One observation so far' : 'Not enough points to draw a trend'}
                        aria-label={row.observations === 1 ? 'One observation so far' : 'Not enough points to draw a trend'}
                    />
                )}
            </td>

            <td className="px-3 py-2.5 text-right tabular-nums text-ink align-middle">
                {exact(row.last)}
            </td>

            <td className="px-3 py-2.5 text-right align-middle">
                <span className={cn('tabular-nums font-semibold', deltaTone(row.delta))}>
                    {signed(row.delta)}
                </span>
                <span className="sr-only"> {metricNoun(metric, row.delta)}</span>
                {row.pct_change !== null && row.delta !== 0 && (
                    <span className="block text-[11px] text-ink-muted tabular-nums">
                        {row.pct_change > 0 ? '+' : ''}{row.pct_change}%
                    </span>
                )}
            </td>

            <td className="px-3 py-2.5 text-right text-[11px] text-ink-muted hidden sm:table-cell align-middle">
                {row.last_observed_at ? (
                    // Relative to read, absolute to check. "13h ago" answers
                    // "is this current"; the title answers "which 13 hours",
                    // which is what someone correlating with another system's
                    // log actually needs.
                    <span title={formatInstant(row.last_observed_at)}>
                        {relativeShort(row.last_observed_at)}
                    </span>
                ) : '—'}
            </td>

            <td className="pr-3 text-ink-muted align-middle">
                {interactive && <ChevronRight className="w-4 h-4" aria-hidden />}
            </td>
        </tr>
    )
}

/** "How long ago", from a capture instant.
 *
 *  Still pads a bucket key, because a source with no stats row falls back to
 *  one — a coarse answer beats none, and the two agree to within a bucket. */
function relativeShort(bucket: string): string {
    const padded = bucket.length <= 10
        ? `${bucket}T00:00:00Z`
        : bucket.length <= 13 ? `${bucket}:00:00Z` : bucket
    const at = new Date(padded).getTime()
    if (Number.isNaN(at)) return bucket
    const mins = Math.round((Date.now() - at) / 60000)
    if (mins < 60) return `${Math.max(0, mins)}m ago`
    const hours = Math.round(mins / 60)
    if (hours < 48) return `${hours}h ago`
    return `${Math.round(hours / 24)}d ago`
}

function BoardSkeleton() {
    return (
        <div className="space-y-3" aria-busy>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="h-24 rounded-2xl border border-glass-border bg-canvas-elevated animate-pulse" />
                ))}
            </div>
            <div className="h-64 rounded-2xl border border-glass-border bg-canvas-elevated animate-pulse" />
            <p className="sr-only">Reading what moved…</p>
        </div>
    )
}

function ErrorPanel({ message, onRetry }: { message?: string; onRetry: () => void }) {
    return (
        <div className="rounded-2xl border border-rose-500/30 bg-rose-500/[0.05] px-4 py-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                <TriangleAlert className="w-4 h-4 text-rose-600 dark:text-rose-400" aria-hidden />
                The board could not be read
            </p>
            <p className="text-xs text-ink-secondary mt-1">
                {message || 'The request failed.'} Nothing has been lost — profiling
                records are durable, and this is a read.
            </p>
            <button
                type="button"
                onClick={onRetry}
                className="mt-3 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
            >
                Try again
            </button>
        </div>
    )
}

function EmptyPanel({
    title, body, action,
}: { title: string; body: string; action?: React.ReactNode }) {
    return (
        <div className="rounded-2xl border border-glass-border bg-canvas-elevated px-6 py-10 text-center">
            <Radio className="w-8 h-8 mx-auto text-ink-muted opacity-40 mb-3" aria-hidden />
            <p className="text-sm font-semibold text-ink">{title}</p>
            <p className="text-xs text-ink-muted mt-1.5 max-w-md mx-auto leading-relaxed">{body}</p>
            {action && <div className="mt-3">{action}</div>}
        </div>
    )
}
