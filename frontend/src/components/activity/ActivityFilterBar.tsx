/**
 * The explorer's filters: a lens, a range, then the questions a person asks.
 *
 * The lens comes first because it is the question most people arrive with
 * ("what happened to access?"); everything after it narrows that. Filters a
 * drill-in set — a source from a leaderboard, a workspace from a row — show as
 * chips that say what they are and come off in one click, so the selection on
 * screen is always the selection in the URL.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, Filter, Search, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { RangePicker, rangeSpanDays } from '@/components/analytics/RangePicker'
import { useChartTheme } from '@/components/analytics/charts/chartTheme'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import {
    SEARCH_MAX_DAYS,
    type ActivityCatalogue,
    type ActivityCategory,
} from '@/services/activityService'

import { CATEGORY_META, LENSES, WORKSPACE_LENS_IDS } from './activityMeta'
import type { ActivityParams } from './useActivityParams'

/** Names for ids the URL carries — gathered from what is on screen. */
export type ActivityNames = Record<string, string>

const INPUT = 'bg-transparent border border-glass-border rounded-lg px-3 py-1.5 text-xs text-ink placeholder:text-ink-muted focus:outline-none focus:border-accent-lineage/40 disabled:opacity-50'

/**
 * A text box that writes to the URL a moment after typing stops. A change
 * from elsewhere — Clear, a drill-in — replaces what it shows, but its own
 * commit never does: typing on while the last word is being applied must not
 * lose the letters typed since.
 */
function DebouncedInput({ value, onCommit, ...props }: {
    value: string
    onCommit: (value: string) => void
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
    const [text, setText] = useState(value)
    const committed = useRef(value)
    const debounced = useDebouncedValue(text, 350)

    useEffect(() => {
        if (value !== committed.current) {
            committed.current = value
            setText(value)
        }
    }, [value])

    useEffect(() => {
        if (debounced !== committed.current) {
            committed.current = debounced
            onCommit(debounced)
        }
    }, [debounced, onCommit])

    return <input {...props} value={text} onChange={(e) => setText(e.target.value)} />
}

export function ActivityFilterBar({
    params, catalogue, workspaceLocked, exportHref, isFetching, names,
}: {
    params: ActivityParams
    catalogue?: ActivityCatalogue
    /** A workspace admin's scope: the lenses the server answers for them. */
    workspaceLocked?: boolean
    exportHref: string
    isFetching?: boolean
    names: ActivityNames
}) {
    const theme = useChartTheme()
    const lenses = workspaceLocked
        ? LENSES.filter((l) => (WORKSPACE_LENS_IDS as readonly string[]).includes(l.id))
        : LENSES
    const searchAllowed = rangeSpanDays(params.range) <= SEARCH_MAX_DAYS

    // The actions worth offering are the lens's own.
    const actions = useMemo(() => {
        const inLens = (category: ActivityCategory) =>
            params.lens.categories.length === 0 || params.lens.categories.includes(category)
        const byCategory = new Map<ActivityCategory, { type: string; label: string }[]>()
        for (const entry of catalogue?.eventTypes ?? []) {
            if (!inLens(entry.category)) continue
            const list = byCategory.get(entry.category) ?? []
            list.push({ type: entry.type, label: entry.label })
            byCategory.set(entry.category, list)
        }
        for (const list of byCategory.values()) list.sort((a, b) => a.label.localeCompare(b.label))
        return [...byCategory.entries()]
    }, [catalogue, params.lens])

    const chips = [
        params.workspaceId && !workspaceLocked && {
            key: 'workspace', label: 'Workspace', value: names[params.workspaceId] ?? params.workspaceId,
            clear: { workspace: null },
        },
        params.dataSourceId && {
            key: 'dataSource', label: 'Data source', value: names[params.dataSourceId] ?? params.dataSourceId,
            clear: { dataSource: null },
        },
        params.targetId && {
            key: 'target', label: params.targetType ? params.targetType.replace(/_/g, ' ') : 'Target',
            value: names[params.targetId] ?? params.targetId,
            clear: { targetType: null, targetId: null },
        },
    ].filter(Boolean) as { key: string; label: string; value: string; clear: Parameters<ActivityParams['patch']>[0] }[]

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div role="group" aria-label="Lens" className="flex flex-wrap items-center gap-1.5">
                    {lenses.map((lens) => {
                        const active = params.lens.id === lens.id
                        const single = lens.categories.length === 1 ? lens.categories[0] : null
                        return (
                            <button
                                key={lens.id}
                                type="button"
                                aria-pressed={active}
                                title={lens.hint}
                                onClick={() => params.setLens(lens.id)}
                                className={cn(
                                    'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                                    active
                                        ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300'
                                        : 'border-glass-border text-ink-secondary hover:text-ink hover:border-indigo-500/30',
                                )}
                            >
                                {single && (
                                    <span
                                        aria-hidden
                                        className="w-2 h-2 rounded-full"
                                        style={{ backgroundColor: theme.series[CATEGORY_META[single].slot] }}
                                    />
                                )}
                                {lens.label}
                            </button>
                        )
                    })}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <RangePicker range={params.range} onChange={params.setRange} isFetching={isFetching} />
                    <a
                        href={exportHref}
                        download
                        title="Download this selection as CSV (at most 50,000 events). The export is itself recorded."
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-ink-secondary hover:text-ink bg-canvas-elevated border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    >
                        <Download className="w-3.5 h-3.5" />
                        Export
                    </a>
                </div>
            </div>

            <div className="rounded-xl border border-glass-border bg-canvas-elevated p-3 flex flex-wrap items-center gap-2">
                <Filter className="w-4 h-4 text-ink-muted shrink-0" aria-hidden />
                <DebouncedInput
                    type="text"
                    aria-label="Filter by person"
                    placeholder="Person — name, email or user ID…"
                    value={params.person}
                    onCommit={(v) => params.patch({ person: v.trim() || null })}
                    className={cn(INPUT, 'flex-1 min-w-[180px]')}
                />
                <select
                    aria-label="Their part"
                    value={params.personRole}
                    disabled={!params.person}
                    onChange={(e) => params.patch({ role: e.target.value === 'any' ? null : e.target.value })}
                    className={INPUT}
                >
                    <option value="any">Did it, or had it done to them</option>
                    <option value="actor">Did it</option>
                    <option value="subject">Had it done to them</option>
                </select>
                <select
                    aria-label="Action"
                    value={params.eventTypes.length > 1 ? '__several' : (params.eventTypes[0] ?? '')}
                    onChange={(e) => params.patch({ types: e.target.value || null })}
                    className={cn(INPUT, 'max-w-[220px]')}
                >
                    <option value="">Any action</option>
                    {params.eventTypes.length > 1 && (
                        <option value="__several" disabled>{params.eventTypes.length} actions</option>
                    )}
                    {actions.map(([category, list]) => (
                        <optgroup key={category} label={CATEGORY_META[category].label}>
                            {list.map((a) => <option key={a.type} value={a.type}>{a.label}</option>)}
                        </optgroup>
                    ))}
                </select>
                <select
                    aria-label="Outcome"
                    value={params.outcome ?? ''}
                    onChange={(e) => params.patch({ outcome: e.target.value || null })}
                    className={INPUT}
                >
                    <option value="">Any outcome</option>
                    <option value="success">Succeeded</option>
                    <option value="failure">Failed</option>
                    <option value="denied">Refused</option>
                </select>
                <select
                    aria-label="Reason"
                    value={params.reason ?? ''}
                    onChange={(e) => params.patch({ reason: e.target.value || null })}
                    className={INPUT}
                >
                    <option value="">With or without a reason</option>
                    <option value="given">A reason was given</option>
                    <option value="missing">No reason given</option>
                </select>
                <div className="relative flex-1 min-w-[180px]">
                    <Search className="w-3.5 h-3.5 text-ink-muted absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden />
                    <DebouncedInput
                        type="search"
                        aria-label="Search activity"
                        placeholder={searchAllowed ? 'Search what happened…' : `Search covers at most ${SEARCH_MAX_DAYS} days`}
                        title={searchAllowed ? undefined : `Text search reads every event in its window, so it covers at most ${SEARCH_MAX_DAYS} days. Pick a shorter range to search.`}
                        disabled={!searchAllowed}
                        value={params.q}
                        onCommit={(v) => params.patch({ q: v.trim() || null })}
                        className={cn(INPUT, 'w-full pl-8')}
                    />
                </div>
                {params.activeFilterCount > 0 && (
                    <button
                        type="button"
                        onClick={params.clearFilters}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold text-ink-muted hover:text-ink"
                    >
                        <X className="w-3 h-3" />
                        Clear filters
                    </button>
                )}
            </div>

            {chips.length > 0 && (
                <ul aria-label="Active filters" className="flex flex-wrap items-center gap-2">
                    {chips.map((chip) => (
                        <li key={chip.key}>
                            <span className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-indigo-500/[0.06] pl-2.5 pr-1 py-0.5 text-[11px]">
                                <span className="text-ink-muted capitalize">{chip.label}</span>
                                <span className="font-semibold text-ink">{chip.value}</span>
                                <button
                                    type="button"
                                    aria-label={`Remove the ${chip.label.toLowerCase()} filter`}
                                    onClick={() => params.patch(chip.clear)}
                                    className="rounded p-0.5 text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5"
                                >
                                    <X className="w-3 h-3" />
                                </button>
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}
