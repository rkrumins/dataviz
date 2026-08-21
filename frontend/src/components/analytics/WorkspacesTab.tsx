/**
 * WorkspacesTab — every workspace as a row, sortable, with a drill-in.
 *
 * A table, not a chart. Past about seven classes that all carry meaning, colour
 * stops distinguishing them and a table is simply the better instrument — and
 * here every column is a different measure, which no single chart encodes.
 *
 * The one visual is a proportional meter inside the sorted column's cells, so
 * the shape of the distribution is still readable at a glance. Deliberately in
 * the CELL rather than across the row: a row-wide wash or rule is 100% wide on
 * the top row by definition, and at that width it reads as selection or as a
 * section divider, whichever the reader happens to expect.
 */
import { useMemo, useState } from 'react'
import { ArrowUpDown, Lock, MoonStar } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { AnalyticsRangeSelection } from '@/services/analyticsService'
import { timeAgo } from '@/lib/timeAgo'
import { WithheldValue } from './Redacted'
import { WorkspaceLink } from './EntityLink'
import { RequestAccessButton } from './RequestAccessButton'
import { compact, exact } from '@/lib/formatMetric'
import type { WorkspaceAnalyticsRow } from '@/services/analyticsService'
import { useChartTheme } from './charts/chartTheme'
import { rangePhrase } from './RangePicker'

type SortKey = 'name' | 'members' | 'views' | 'newViews' | 'activity'
    | 'opens' | 'activeUsers' | 'nodes' | 'lastActivityAt'

const COLUMNS: { key: SortKey; label: string; numeric: boolean; hint?: string }[] = [
    { key: 'name', label: 'Workspace', numeric: false },
    { key: 'members', label: 'Members', numeric: true, hint: 'Distinct people with a live binding, including through groups' },
    { key: 'views', label: 'Views', numeric: true },
    { key: 'newViews', label: 'New', numeric: true, hint: 'Views created in the selected range' },
    { key: 'activeUsers', label: 'Active', numeric: true, hint: 'Distinct people who did something in range' },
    { key: 'opens', label: 'Opens', numeric: true },
    { key: 'activity', label: 'Actions', numeric: true },
    { key: 'nodes', label: 'Nodes', numeric: true, hint: 'Graph scale across this workspace’s data sources' },
    { key: 'lastActivityAt', label: 'Last active', numeric: false },
]

export function WorkspacesTab({
    rows, range, isStale, onSelect, selectedId,
}: {
    rows: WorkspaceAnalyticsRow[]
    range: AnalyticsRangeSelection
    isStale: boolean
    onSelect: (workspaceId: string) => void
    selectedId: string | null
}) {
    const theme = useChartTheme()
    const [sortKey, setSortKey] = useState<SortKey>('activity')
    const [asc, setAsc] = useState(false)

    const sorted = useMemo(() => {
        const copy = [...rows]
        copy.sort((a, b) => {
            const av = a[sortKey]
            const bv = b[sortKey]
            if (typeof av === 'number' && typeof bv === 'number') return asc ? av - bv : bv - av
            const as = String(av ?? '')
            const bs = String(bv ?? '')
            return asc ? as.localeCompare(bs) : bs.localeCompare(as)
        })
        return copy
    }, [rows, sortKey, asc])

    const peak = useMemo(() => {
        const col = COLUMNS.find((c) => c.key === sortKey)
        if (!col?.numeric) return 0
        return Math.max(1, ...rows.map((r) => Number(r[sortKey]) || 0))
    }, [rows, sortKey])

    const dormant = rows.filter((r) => r.dormant).length

    const toggle = (key: SortKey) => {
        if (key === sortKey) setAsc((v) => !v)
        else { setSortKey(key); setAsc(false) }
    }

    return (
        <div className={cn('space-y-4 transition-opacity duration-200', isStale && 'opacity-50')}>
            {dormant > 0 && (
                <p className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-900 dark:text-amber-100">
                    <MoonStar className="w-3.5 h-3.5 shrink-0" aria-hidden />
                    <span>
                        <strong className="font-semibold">{dormant}</strong>
                        {dormant === 1 ? ' workspace has' : ' workspaces have'} seen no
                        activity in {rangePhrase(range)}. Worth a look before
                        they quietly become abandoned.
                    </span>
                </p>
            )}

            <div className="overflow-x-auto rounded-2xl border border-glass-border bg-canvas-elevated shadow-sm">
                <table className="w-full text-xs">
                    <caption className="sr-only">
                        Per-workspace analytics for {rangePhrase(range)}
                    </caption>
                    <thead>
                        <tr className="border-b border-glass-border">
                            {COLUMNS.map((col) => (
                                <th
                                    key={col.key}
                                    scope="col"
                                    aria-sort={sortKey === col.key ? (asc ? 'ascending' : 'descending') : 'none'}
                                    className={cn(
                                        'px-3 py-2.5 font-semibold text-ink-secondary whitespace-nowrap',
                                        col.numeric ? 'text-right' : 'text-left',
                                    )}
                                >
                                    <button
                                        type="button"
                                        onClick={() => toggle(col.key)}
                                        title={col.hint ?? `Sort by ${col.label}`}
                                        className={cn(
                                            'inline-flex items-center gap-1 rounded px-1 -mx-1 outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                                            sortKey === col.key && 'text-indigo-600 dark:text-indigo-400',
                                        )}
                                    >
                                        {col.label}
                                        <ArrowUpDown className="w-3 h-3 opacity-50" aria-hidden />
                                    </button>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {sorted.map((row) => {
                            const locked = row.redacted === true
                            const value = Number(row[sortKey]) || 0
                            // A locked row has no measurement to shade, so it
                            // gets no distribution bar — painting one from a
                            // null would draw a 0% bar that reads as "this
                            // workspace does nothing".
                            const share = locked || peak <= 0 ? 0 : value / peak
                            // Only the column being sorted carries a meter —
                            // eight of them at once would be a heatmap nobody
                            // asked for.
                            const meterFor = (key: SortKey) =>
                                key === sortKey && share > 0
                                    ? { share, color: theme.series[0] }
                                    : undefined
                            const selected = row.workspaceId === selectedId
                            return (
                                <tr
                                    key={row.workspaceId}
                                    // A locked row opens nothing, so it is not a
                                    // button: giving it a click target and a
                                    // focus stop would promise a drill-in that
                                    // answers 403.
                                    onClick={locked ? undefined : () => onSelect(row.workspaceId)}
                                    tabIndex={locked ? -1 : 0}
                                    onKeyDown={(e) => {
                                        if (locked) return
                                        if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault()
                                            onSelect(row.workspaceId)
                                        }
                                    }}
                                    aria-label={locked
                                        ? 'A workspace you are not a member of'
                                        : `Open analytics for ${row.name}`}
                                    className={cn(
                                        'border-b border-glass-border last:border-b-0 outline-none transition-colors',
                                        locked
                                            ? 'cursor-default'
                                            : 'cursor-pointer',
                                        selected
                                            ? 'bg-indigo-500/[0.07]'
                                            : !locked && 'hover:bg-black/[0.02] dark:hover:bg-white/[0.03] focus-visible:bg-black/[0.03] dark:focus-visible:bg-white/[0.04]',
                                    )}
                                >
                                    <td className="px-3 py-2.5">
                                        <span className="flex items-center gap-2">
                                            {locked && (
                                                <Lock
                                                    className="h-3 w-3 shrink-0 text-ink-muted/70"
                                                    aria-hidden
                                                />
                                            )}
                                            {locked ? (
                                                <span className="truncate italic text-ink-muted">
                                                    {row.name}
                                                </span>
                                            ) : (
                                                <WorkspaceLink
                                                    workspaceId={row.workspaceId}
                                                    name={row.name}
                                                    canOpen={row.canOpen}
                                                    className="truncate font-semibold text-ink"
                                                />
                                            )}
                                            {!locked && row.dormant && (
                                                <span
                                                    title="No activity in the selected range"
                                                    className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400"
                                                >
                                                    dormant
                                                </span>
                                            )}
                                        </span>
                                        {locked ? (
                                            // The moment someone finds a workspace
                                            // they want is the moment to let them
                                            // ask for it, rather than sending them
                                            // to find somebody on chat.
                                            <span className="mt-1 flex items-center gap-2">
                                                <span className="text-[10px] text-ink-muted">
                                                    You are not a member
                                                </span>
                                                <RequestAccessButton workspaceId={row.workspaceId} />
                                            </span>
                                        ) : (
                                            <span className="block text-[10px] text-ink-muted">
                                                {row.dataSources} {row.dataSources === 1 ? 'source' : 'sources'}
                                            </span>
                                        )}
                                    </td>
                                    <Cell value={row.members} meter={meterFor('members')} />
                                    <Cell value={row.views} meter={meterFor('views')} />
                                    <Cell value={row.newViews} meter={meterFor('newViews')} />
                                    <Cell value={row.activeUsers} meter={meterFor('activeUsers')} />
                                    <Cell value={row.opens} meter={meterFor('opens')} />
                                    <Cell value={row.activity} meter={meterFor('activity')} />
                                    <Cell value={row.nodes} compactValue meter={meterFor('nodes')} />
                                    <td className="px-3 py-2.5 text-ink-muted whitespace-nowrap">
                                        {row.lastActivityAt ? timeAgo(row.lastActivityAt) : '—'}
                                    </td>
                                </tr>
                            )
                        })}
                        {sorted.length === 0 && (
                            <tr>
                                <td colSpan={COLUMNS.length} className="px-3 py-10 text-center text-ink-muted">
                                    No workspaces yet.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    )
}

function Cell({
    value, compactValue, meter,
}: {
    value: number | null
    compactValue?: boolean
    /** Share of the column's peak, for the one column being sorted. */
    meter?: { share: number; color: string }
}) {
    // `null` is a refusal, not a measurement. Rendering it as 0 would put a
    // real-looking number in a column people sort and total.
    if (value === null) {
        return (
            <td className="px-3 py-2.5 text-right text-ink-muted/70">
                <WithheldValue />
            </td>
        )
    }
    return (
        <td className="relative px-3 py-2.5 text-right tabular-nums text-ink" title={exact(value)}>
            {compactValue ? compact(value) : exact(value)}
            {/* Absolutely positioned so sorting a different column never
                changes the row height, and grown leftwards from the right edge
                so it lines up under its own right-aligned figure. A floor of 3%
                keeps the smallest non-zero value visible as a mark rather than
                as nothing. */}
            {meter && (
                <span
                    aria-hidden
                    className="absolute bottom-1.5 right-3 h-[3px] rounded-full"
                    style={{
                        width: `calc((100% - 24px) * ${Math.max(meter.share, 0.03)})`,
                        backgroundColor: meter.color,
                        opacity: 0.55,
                    }}
                />
            )}
        </td>
    )
}
