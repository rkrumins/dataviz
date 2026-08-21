/**
 * WorkspacesTab — every workspace as a row, sortable, with a drill-in.
 *
 * A table, not a chart. Past about seven classes that all carry meaning, colour
 * stops distinguishing them and a table is simply the better instrument — and
 * here every column is a different measure, which no single chart encodes.
 *
 * The one visual is a proportional bar behind the sorted column, so the shape
 * of the distribution is still readable at a glance.
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
import { rangeLabel } from './RangePicker'

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
                        activity in {rangeLabel(range).toLowerCase()}. Worth a look before
                        they quietly become abandoned.
                    </span>
                </p>
            )}

            <div className="overflow-x-auto rounded-2xl border border-glass-border bg-canvas-elevated shadow-sm">
                <table className="w-full text-xs">
                    <caption className="sr-only">
                        Per-workspace analytics for {rangeLabel(range).toLowerCase()}
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
                            const selected = row.workspaceId === selectedId
                            return (
                                <tr
                                    key={row.workspaceId}
                                    // The sorted column's distribution, painted as
                                    // the ROW's background rather than an absolute
                                    // overlay — a positioned bar either sits above
                                    // the text or (with a negative z-index) behind
                                    // the card entirely, and there is no z-index
                                    // that reliably lands between the two.
                                    style={share > 0 ? {
                                        backgroundImage: `linear-gradient(to right, ${theme.series[0]}1f ${share * 100}%, transparent ${share * 100}%)`,
                                    } : undefined}
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
                                    <Cell value={row.members} />
                                    <Cell value={row.views} />
                                    <Cell value={row.newViews} />
                                    <Cell value={row.activeUsers} />
                                    <Cell value={row.opens} />
                                    <Cell value={row.activity} />
                                    <Cell value={row.nodes} compactValue />
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
    value, compactValue,
}: { value: number | null; compactValue?: boolean }) {
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
        <td className="px-3 py-2.5 text-right tabular-nums text-ink" title={exact(value)}>
            {compactValue ? compact(value) : exact(value)}
        </td>
    )
}
