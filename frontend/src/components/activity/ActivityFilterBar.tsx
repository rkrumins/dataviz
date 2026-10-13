/**
 * The explorer's filters: a lens, a range, then the questions a person asks.
 *
 * The lens comes first because it is the question most people arrive with
 * ("what happened to access?"); everything after it narrows that. Search is
 * the widest thing on the bar, with the refinements under it: a person (typed,
 * or picked by face from the people active in the range) and their part, the
 * actions, the outcome, whether a reason was given. Filters a drill-in set —
 * a source from a leaderboard, a workspace from a row — show as chips that
 * say what they are and come off in one click, so the selection on screen is
 * always the selection in the URL.
 */
import { useMemo, useState } from 'react'
import { CircleDot, Download, Keyboard, MessageSquareQuote, UserRound, X, Zap } from 'lucide-react'

import { cn } from '@/lib/utils'
import { exact } from '@/lib/formatMetric'
import { RangePicker, rangeSpanDays } from '@/components/analytics/RangePicker'
import { useChartTheme } from '@/components/analytics/charts/chartTheme'
import { FilterDropdown, type FilterOption } from '@/components/explorer/FilterDropdown'
import { PersonChip } from '@/components/ui/PersonChip'
import { Segmented } from '@/components/ui/Segmented'
import { UserAvatar } from '@/components/ui/UserAvatar'
import {
    SEARCH_MAX_DAYS,
    type ActivityCatalogue,
    type ActivityCategory,
    type ActivityOutcome,
    type ActivitySummary,
    type PersonRole,
} from '@/services/activityService'

import { ActivitySearchField } from './ActivitySearchField'
import { ChoicePill } from './ChoicePill'
import { CATEGORY_META, LENSES, WORKSPACE_LENS_IDS, isPersonId } from './activityMeta'
import type { ActivityParams } from './useActivityParams'
import { useDebouncedCommit, useSuggestions } from './useSuggestions'

/** Names for ids the URL carries — gathered from what is on screen. */
export type ActivityNames = Record<string, string>

type ActivePerson = ActivitySummary['topPeople'][number]

/**
 * A person: typed as a name, an email or an id — or picked by face from the
 * people active in this range. One picked by id reads as who they are.
 */
function PersonField({ params, people }: { params: ActivityParams; people: ActivePerson[] }) {
    const [focused, setFocused] = useState(false)
    const commit = (v: string) => params.patch({ person: v.trim() || null })
    const [text, setText, flush] = useDebouncedCommit(params.person, commit)
    const picks = people.slice(0, 6)
    const open = focused && !text && picks.length > 0
    const list = useSuggestions({ items: picks, open, onPick: (p) => flush(p.id) })
    const token = !focused && isPersonId(params.person) && text === params.person

    return (
        <div className="relative">
            <label className={cn(
                'flex h-7 cursor-text items-center gap-1.5 rounded-lg px-2.5 text-xs transition-colors',
                focused
                    ? 'bg-black/[0.04] ring-2 ring-accent-lineage/30 dark:bg-white/[0.05]'
                    : params.person
                        ? 'bg-accent-lineage/10'
                        : 'hover:bg-black/[0.04] dark:hover:bg-white/[0.05]',
            )}>
                <UserRound aria-hidden className={cn('h-3.5 w-3.5 shrink-0', params.person ? 'text-accent-lineage' : 'text-ink-muted')} />
                {/* Picked by id: their face and name, until the field is edited. */}
                {token && <PersonChip id={params.person} size="xs" link={false} className="max-w-[12rem]" />}
                <input
                    aria-label="Filter by person"
                    placeholder="Person — name, email or user ID…"
                    {...list.inputProps}
                    value={text}
                    onChange={(e) => { setText(e.target.value); list.reset() }}
                    onFocus={() => { setFocused(true); list.reset() }}
                    onBlur={() => setFocused(false)}
                    onKeyDown={(e) => {
                        if (list.onKeyDown(e)) return
                        if (e.key === 'Enter') { e.preventDefault(); flush(text) }
                        else if (e.key === 'Escape') e.currentTarget.blur()
                    }}
                    className={cn(
                        'min-w-0 bg-transparent font-medium text-ink outline-none placeholder:font-normal placeholder:text-ink-muted',
                        token ? 'sr-only' : 'w-52',
                    )}
                />
                {!!text && (
                    <button
                        type="button"
                        aria-label="Remove the person filter"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => flush('')}
                        className="-mr-1 shrink-0 rounded p-0.5 text-ink-muted hover:bg-black/5 hover:text-ink dark:hover:bg-white/5"
                    >
                        <X className="h-3 w-3" />
                    </button>
                )}
            </label>
            {open && (
                <div
                    {...list.listProps}
                    aria-label="People active in this range"
                    className="absolute left-0 top-full z-30 mt-1.5 w-72 overflow-hidden rounded-xl border border-glass-border bg-canvas-elevated p-1.5 shadow-xl"
                >
                    <p role="presentation" className="px-2 pb-1 pt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted">
                        Active in this range
                    </p>
                    {picks.map((p, i) => {
                        const name = p.name || p.email || p.id
                        return (
                            <div
                                key={p.id}
                                {...list.optionProps(i)}
                                className={cn(
                                    'flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5',
                                    i === list.active && 'bg-accent-lineage/10',
                                )}
                            >
                                <UserAvatar
                                    userId={p.id} name={name} avatarId={p.avatarId} hasImage={p.hasImage}
                                    className={cn('h-6 w-6 text-[9px] font-bold', p.deleted && 'grayscale')}
                                />
                                <span className="min-w-0 flex-1">
                                    <span className={cn('block truncate text-xs font-semibold text-ink', !(p.name || p.email) && 'font-mono font-normal')}>{name}</span>
                                    {p.deleted
                                        ? <span className="block truncate text-[10px] text-ink-muted">Deleted account</span>
                                        : p.name && p.email && <span className="block truncate text-[10px] text-ink-muted">{p.email}</span>}
                                </span>
                                <span className="shrink-0 text-[10px] font-semibold tabular-nums text-ink-muted">{exact(p.count)}</span>
                            </div>
                        )
                    })}
                </div>
            )}
        </div>
    )
}

const ROLES: { value: PersonRole; label: string }[] = [
    { value: 'any', label: 'Either way' },
    { value: 'actor', label: 'Did it' },
    { value: 'subject', label: 'Done to them' },
]

const OUTCOMES: { value: ActivityOutcome; label: string; dot: string }[] = [
    { value: 'success', label: 'Succeeded', dot: 'bg-emerald-500' },
    { value: 'failure', label: 'Failed', dot: 'bg-red-500' },
    { value: 'denied', label: 'Refused', dot: 'bg-amber-500' },
]

const REASONS: { value: 'given' | 'missing'; label: string }[] = [
    { value: 'given', label: 'A reason was given' },
    { value: 'missing', label: 'No reason given' },
]

export function ActivityFilterBar({
    params, catalogue, workspaceLocked, exportHref, isFetching, names, onShowShortcuts,
    people = [], searchSuggestions = [],
}: {
    params: ActivityParams
    catalogue?: ActivityCatalogue
    /** A workspace admin's scope: the lenses the server answers for them. */
    workspaceLocked?: boolean
    exportHref: string
    isFetching?: boolean
    names: ActivityNames
    onShowShortcuts: () => void
    /** The people active in this range, offered when picking a person. */
    people?: ActivePerson[]
    /** Words this range can answer, offered under an empty search. */
    searchSuggestions?: string[]
}) {
    const theme = useChartTheme()
    const lenses = workspaceLocked
        ? LENSES.filter((l) => (WORKSPACE_LENS_IDS as readonly string[]).includes(l.id))
        : LENSES
    const searchAllowed = rangeSpanDays(params.range) <= SEARCH_MAX_DAYS

    // The actions worth offering are the lens's own, by category and then
    // by name — the order the timeline's colours already teach.
    const actions = useMemo<FilterOption[]>(() => {
        const inLens = (category: ActivityCategory) =>
            params.lens.categories.length === 0 || params.lens.categories.includes(category)
        return (catalogue?.eventTypes ?? [])
            .filter((entry) => inLens(entry.category))
            .sort((a, b) => CATEGORY_META[a.category].slot - CATEGORY_META[b.category].slot
                || a.label.localeCompare(b.label))
            .map((entry) => ({ id: entry.type, label: entry.label, sublabel: CATEGORY_META[entry.category].label }))
    }, [catalogue, params.lens])
    const categoryOf = useMemo(
        () => new Map((catalogue?.eventTypes ?? []).map((e) => [e.type, e.category])),
        [catalogue],
    )

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
        params.apiKeyId && {
            key: 'apiKey', label: 'API key', value: names[params.apiKeyId] ?? params.apiKeyId,
            clear: { apiKey: null },
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
                    <button
                        type="button"
                        onClick={onShowShortcuts}
                        aria-label="Keyboard shortcuts"
                        title="Keyboard shortcuts (?)"
                        className="p-2 rounded-lg text-ink-secondary hover:text-ink bg-canvas-elevated border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                    >
                        <Keyboard className="w-3.5 h-3.5" />
                    </button>
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

            <div className="rounded-2xl border border-glass-border bg-canvas-elevated p-2 shadow-sm">
                <ActivitySearchField
                    value={params.q}
                    onCommit={(v) => params.patch({ q: v || null })}
                    suggestions={searchSuggestions}
                    disabled={!searchAllowed}
                    maxDays={SEARCH_MAX_DAYS}
                    onFitRange={() => params.setRange({ kind: 'preset', days: 90 })}
                    busy={isFetching}
                />
                <div role="group" aria-label="Refine" className="mt-2 flex flex-wrap items-center gap-1 border-t border-glass-border/60 px-0.5 pt-2">
                    <PersonField params={params} people={people} />
                    {params.person && (
                        <Segmented
                            label="Their part"
                            options={ROLES}
                            value={params.personRole}
                            onChange={(role) => params.patch({ role: role === 'any' ? null : role })}
                        />
                    )}
                    <span aria-hidden className="mx-1 h-4 w-px bg-glass-border" />
                    <FilterDropdown
                        icon={Zap}
                        label="Action"
                        accent="indigo"
                        options={actions}
                        selectedIds={params.eventTypes}
                        onChange={(ids) => params.patch({ types: ids.length ? ids.join(',') : null })}
                        searchPlaceholder="Search actions…"
                        emptyMessage="No actions under this lens"
                        panelWidthClassName="w-72"
                        activeLabelFormatter={(ids, options) => (ids.length === 1
                            ? options.find((o) => o.id === ids[0])?.label ?? '1 action'
                            : `${ids.length} actions`)}
                        renderOption={(option, { isSelected }) => {
                            const category = categoryOf.get(option.id)
                            return (
                                <span className="flex items-center gap-2.5 px-3 py-2 text-xs">
                                    <span className={cn(
                                        'grid h-4 w-4 shrink-0 place-items-center rounded border',
                                        isSelected ? 'border-indigo-500 bg-indigo-500 text-white' : 'border-ink-muted/50',
                                    )}>
                                        {isSelected && <span className="h-1.5 w-1.5 rounded-sm bg-white" />}
                                    </span>
                                    <span
                                        aria-hidden className="h-2 w-2 shrink-0 rounded-full"
                                        style={{ backgroundColor: category ? theme.series[CATEGORY_META[category].slot] : undefined }}
                                    />
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate font-medium text-ink">{option.label}</span>
                                        <span className="block truncate text-[10px] text-ink-muted">{option.sublabel}</span>
                                    </span>
                                </span>
                            )
                        }}
                    />
                    <ChoicePill
                        icon={CircleDot}
                        label="Outcome"
                        anyLabel="Any outcome"
                        value={params.outcome}
                        choices={OUTCOMES}
                        onChange={(outcome) => params.patch({ outcome })}
                    />
                    <ChoicePill
                        icon={MessageSquareQuote}
                        label="Reason"
                        anyLabel="With or without a reason"
                        value={params.reason}
                        choices={REASONS}
                        onChange={(reason) => params.patch({ reason })}
                    />
                    {params.activeFilterCount > 0 && (
                        <button
                            type="button"
                            onClick={params.clearFilters}
                            className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-ink-muted hover:text-ink"
                        >
                            <X className="h-3 w-3" />
                            Clear filters
                        </button>
                    )}
                </div>
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
