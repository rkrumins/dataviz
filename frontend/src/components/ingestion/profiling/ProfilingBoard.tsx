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
import { useCallback, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
    ArrowDown, ArrowUp, ChevronRight, Database, EyeOff,
    Radio, Search, TrendingUp, TriangleAlert,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { compact, exact } from '@/lib/formatMetric'
import { KpiCard } from '@/components/analytics/KpiCard'
import { Sparkline } from '@/components/ui/Sparkline'
import { getProviderLogo } from '@/components/admin/ProviderLogos'
import { SteadyMark } from './SteadyMark'
import {
    DEFAULT_WINDOW, PROFILING_WINDOWS, type ProfilingWindowKey,
    useProfilingBoard,
} from '@/hooks/useProfiling'
import { profilingService } from '@/services/profilingService'
import { useCanReadProfiling } from '@/hooks/useProfilingAccess'
import type { BoardRow, ProfilingMetric } from '@/types/profiling'
import { ProfilingFilterBar } from './ProfilingFilterBar'
import { FindingsBand } from './FindingsBand'
import { ProfilingSettings } from './ProfilingSettings'
import { ProfilingSourceDrawer } from './ProfilingSourceDrawer'
import { BoardVerdict } from './Verdict'
import {
    MEASURE_LABEL, formatInstant, deltaTone, metricNoun, signed, significanceMeta,
} from './shared'

const WINDOW_KEYS = PROFILING_WINDOWS.map((w) => w.key) as readonly ProfilingWindowKey[]
const SORT_KEYS = ['movement', 'size', 'recent', 'name'] as const
const MEASURE_KEYS: ProfilingMetric[] = ['nodes', 'edges', 'total']

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

    /**
     * The board's state lives in the URL.
     *
     * A finding you cannot link to is a finding you have to describe over a
     * call. Every other surface here already does this — `?tab=` on Ingestion
     * and Workspaces, `?ds=`/`?dstab=` on the drawer, `?range=` on Analytics —
     * so profiling holding its filters in React state made it the one place
     * you could not send someone. It also means back and forward work, and a
     * bell notification can land on the row it is about.
     *
     * Names are unprefixed but chosen not to collide with the params the
     * hosting pages already own.
     */
    const [params, setParams] = useSearchParams()

    const set = useCallback((key: string, value: string | null) => {
        setParams((current) => {
            const next = new URLSearchParams(current)
            // A param at its default is noise in a shared link, so defaults
            // are removed rather than written.
            if (value === null || value === '') next.delete(key)
            else next.set(key, value)
            return next
        }, { replace: true })
    }, [setParams])

    const window = (WINDOW_KEYS.includes(params.get('window') as ProfilingWindowKey)
        ? params.get('window') as ProfilingWindowKey
        : DEFAULT_WINDOW)
    const metric: ProfilingMetric =
        MEASURE_KEYS.includes(params.get('measure') as ProfilingMetric)
            ? params.get('measure') as ProfilingMetric
            : 'nodes'
    const unusualOnly = params.get('unusual') === '1'
    const providerId = params.get('provider') ?? ''
    const workspaceFilter = params.get('workspace') ?? ''
    const search = params.get('q') ?? ''
    const sort = (SORT_KEYS.includes(params.get('sort') as SortKey)
        ? params.get('sort') as SortKey
        : 'movement')
    const descending = params.get('dir') !== 'asc'

    const setWindow = (next: ProfilingWindowKey) =>
        set('window', next === DEFAULT_WINDOW ? null : next)
    const setMetric = (next: ProfilingMetric) =>
        set('measure', next === 'nodes' ? null : next)
    const setUnusualOnly = (next: boolean) => set('unusual', next ? '1' : null)
    const setProviderId = (next: string | '') => set('provider', next || null)
    const setWorkspaceFilter = (next: string) => set('workspace', next || null)
    const setSearch = (next: string) => set('q', next || null)
    /**
     * The board's own drill-down, held in the URL like every other piece of
     * board state. A host with a richer place to send the reader (the
     * workspace panel, with its aggregation and versioning tabs) passes
     * `onOpenSource` and owns the navigation instead.
     *
     * Keeping it in `?source=` is what lets the Data Sources page hand a
     * reader straight to one source's profiling — the row there knows a
     * catalog id, the board knows both, so either resolves.
     */
    const sourceParam = params.get('source') ?? ''
    const setSourceParam = (next: string | null) => set('source', next)
    const [settingsOpen, setSettingsOpen] = useState(false)

    const query = useMemo(() => ({
        window, workspaceId, metric, limit: 500,
    }), [window, workspaceId, metric])

    const board = useProfilingBoard(query, { enabled: canRead })
    const rows = board.data?.rows ?? []

    // A deep link names a source; the row it resolves to only exists once the
    // board has loaded, so the drawer opens when the data arrives rather than
    // on mount. An id that matches nothing leaves the drawer closed — a source
    // outside this window or this caller's reach is not an error state.
    const drilling = sourceParam
        ? rows.find((r) => (
            r.data_source_id === sourceParam || r.catalog_item_id === sourceParam
        )) ?? null
        : null

    // Exported at the altitude the board is showing: one workspace when it is
    // scoped to one, everything the caller can see otherwise.
    const exportHref = profilingService.exportUrl({
        scope: workspaceId ? 'workspace' : 'all',
        id: workspaceId ?? undefined,
        window,
        breakdown: 'none',
    })

    const visible = useMemo(() => {
        const needle = search.trim().toLowerCase()
        const filtered = rows.filter((r) => {
            if (unusualOnly && r.significance === 'normal') return false
            if (providerId && r.provider_id !== providerId) return false
            if (workspaceFilter && r.workspace_id !== workspaceFilter) return false
            // Name, provider or workspace: someone searching "sandbox"
            // means any of the three, and asking them which is a question the
            // search box can answer itself.
            if (needle && !(
                r.name.toLowerCase().includes(needle)
                || (r.provider_name ?? '').toLowerCase().includes(needle)
                || (r.workspace_name ?? '').toLowerCase().includes(needle)
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
    }, [rows, search, unusualOnly, providerId, workspaceFilter, sort, descending])

    if (!canRead) return null

    const unusualCount = rows.filter((r) => r.significance !== 'normal').length
    const movedCount = rows.filter((r) => r.delta !== 0).length

    return (
        <div className={cn('space-y-5', className)}>
            <ProfilingFilterBar
                rows={rows}
                window={window} onWindow={setWindow}
                metric={metric} onMetric={setMetric}
                unusualOnly={unusualOnly} onUnusualOnly={setUnusualOnly}
                providerId={providerId} onProvider={setProviderId}
                workspaceId={workspaceFilter} onWorkspace={setWorkspaceFilter}
                // Already scoped to one workspace by the host page; offering
                // the filter would be a control that can only narrow to what
                // is already shown.
                showWorkspaceFilter={!workspaceId}
                search={search} onSearch={setSearch}
                onOpenSettings={() => setSettingsOpen(true)}
                exportHref={exportHref}
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
                            label={`${MEASURE_LABEL[metric]} now`}
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

                    {/* Arriving from Data Sources on a source that reported
                        nothing in this window: say so, rather than opening
                        the board on a row that is not there. */}
                    {sourceParam && !drilling && (
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-glass-border bg-canvas-elevated px-4 py-2.5 text-[13px] text-ink-secondary">
                            <Search className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                            <span>
                                That source reported nothing in the last{' '}
                                {PROFILING_WINDOWS.find((w) => w.key === window)?.label.toLowerCase()}.
                            </span>
                            {window !== '90d' && (
                                <button
                                    onClick={() => setWindow('90d')}
                                    className="font-semibold text-indigo-500 hover:text-indigo-600 transition-colors"
                                >
                                    Look back 90 days
                                </button>
                            )}
                            <button
                                onClick={() => setSourceParam(null)}
                                className="text-ink-muted hover:text-ink transition-colors"
                            >
                                Dismiss
                            </button>
                        </div>
                    )}

                    <BoardTable
                        rows={visible}
                        total={rows.length}
                        metric={metric}
                        sort={sort}
                        descending={descending}
                        onSort={(next) => {
                            if (next === sort) set('dir', descending ? 'asc' : null)
                            else {
                                setParams((current) => {
                                    const merged = new URLSearchParams(current)
                                    if (next === 'movement') merged.delete('sort')
                                    else merged.set('sort', next)
                                    merged.delete('dir')
                                    return merged
                                }, { replace: true })
                            }
                        }}
                        onOpenSource={onOpenSource ?? ((row) => setSourceParam(row.data_source_id))}
                        onClearFilters={() => {
                            setParams((current) => {
                                const merged = new URLSearchParams(current)
                                for (const key of ['q', 'provider', 'workspace', 'unusual']) {
                                    merged.delete(key)
                                }
                                return merged
                            }, { replace: true })
                        }}
                    />
                </>
            )}

            {!onOpenSource && (
                <ProfilingSourceDrawer row={drilling} onClose={() => setSourceParam(null)} />
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
    metric: ProfilingMetric
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
                            <th scope="col" className="text-left font-semibold px-3 py-2 hidden lg:table-cell">
                                Workspace
                            </th>
                            <th scope="col" className="text-left font-semibold px-3 py-2 hidden md:table-cell">
                                Trend
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
    metric: ProfilingMetric
    interactive: boolean
    onOpen: () => void
}) {
    const meta = significanceMeta(row.significance)
    const unusual = row.significance !== 'normal'
    const ProviderLogo = getProviderLogo(row.provider_type ?? 'falkordb')

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
                <span className="flex items-center gap-2.5 min-w-0">
                    {/* The logo, as the Data Sources page draws it. A provider
                        is recognised by its mark long before its name is read,
                        and a fleet board is exactly where that matters. */}
                    <span className="w-7 h-7 shrink-0 rounded-lg border border-glass-border bg-canvas flex items-center justify-center">
                        <ProviderLogo className="w-4 h-4" />
                    </span>
                    <span className="min-w-0">
                        <span className="flex items-center gap-1.5 min-w-0">
                            <span className="font-semibold text-ink truncate max-w-[16rem]">
                                {row.name}
                            </span>
                            {unusual && (
                                <span className={cn(
                                    'shrink-0 text-[10px] font-bold uppercase tracking-wide',
                                    meta.tone,
                                )}>
                                    {meta.label}
                                </span>
                            )}
                        </span>
                        <span className="block text-[11px] text-ink-muted truncate">
                            {row.provider_name || 'Unknown provider'}
                        </span>
                    </span>
                </span>
            </td>

            {/* Whose source it is. On a fleet board an operator has to know who
                to tell, and an id is not something anyone recognises. */}
            <td className="px-3 py-2.5 align-middle hidden lg:table-cell">
                {row.workspace_name ? (
                    <span className="inline-flex items-center rounded-lg border border-glass-border bg-canvas px-2 py-0.5 text-[11px] font-medium text-ink-secondary max-w-[11rem] truncate">
                        {row.workspace_name}
                    </span>
                ) : (
                    <span className="text-[11px] text-ink-muted">—</span>
                )}
            </td>

            <td className="px-3 py-2.5 hidden md:table-cell align-middle">
                {/*
                  Ink only where something happened.

                  Drawing a sparkline for every row means a quiet estate renders
                  the same flat line thirty-two times — ink spent saying
                  "nothing changed", which is exactly what crowds out the rows
                  where something did. A series with no variance gets a word
                  instead, so the drawn lines ARE the movers.
                */}
                {varies(row.points) ? (
                    <Sparkline
                        points={row.points}
                        width={120}
                        height={24}
                        tone={row.delta < 0 ? 'red' : row.delta > 0 ? 'emerald' : 'slate'}
                        label={`${row.name} over the window`}
                    />
                ) : (
                    <SteadyMark
                        variant={row.observations <= 1 ? 'first' : 'steady'}
                        observations={row.observations}
                        width={120}
                        height={24}
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

/** Did this series actually move?
 *
 *  Three points is the floor for a line to describe anything, and identical
 *  values across them describe nothing — a flat rule with an end dot reads as
 *  "steady at some level" when the honest answer is "there is no shape here".
 */
function varies(points: number[]): boolean {
    if (points.length < 3) return false
    return points.some((v) => v !== points[0])
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
