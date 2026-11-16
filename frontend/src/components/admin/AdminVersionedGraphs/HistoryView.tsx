/**
 * History — every change to versioned-graph settings, newest first: who made it, when, why, how
 * (saved here, through the old settings, carried over when settings moved, or a revert), where (the
 * platform, a workspace, a graph), and each value and limit from → to. On the platform it lists
 * every change; on a workspace's page (`place`), the workspace's own and its graphs'.
 *
 * Filters run on the server. The days picked stay as picked (the request asks from the start of the
 * first to the end of the last, in the reader's time zone); "Who" finds anyone in the directory, not
 * only the people on the pages read so far. "Put back…" opens the same review a save does — what
 * each value goes back to, what that would do where it can be worked out, a reason — then reverts
 * the change as one; a change set the pages split is read whole first.
 */
import { useId, useMemo, useState, type KeyboardEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, History, RotateCw, Search, Undo2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { calendarTime } from '@/lib/smartTime'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { DateTime } from '@/components/ui/DateTime'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Input'
import { PersonChip } from '@/components/ui/PersonChip'
import { Select } from '@/components/ui/Select'
import { Skeleton } from '@/components/ui/Skeleton'
import { CONTROL_SHELL, CONTROL_SIZE } from '@/components/ui/controlStyles'
import { useAppNotifications } from '@/components/ui/notifications'
import {
    ScopeBadge, changeImpacts, describeLimits, formatValue, sameLimits, type Limits, type ReviewItem, type Scope, type Setting,
    type SettingValue,
} from '@/components/settings'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { usePerson } from '@/hooks/usePerson'
import { searchDirectory } from '@/services/userDirectoryService'
import { useAuthStore } from '@/store/auth'
import {
    PLATFORM, groupChangeSets, settingsError, useRevertChangeSet, useSettingsHistory, useSettingsPreview,
    type ChangeSet, type HistoryEntry, type HistoryFilter, type ServedSchema, type SettingsPlace, type SettingsRequestError,
} from '@/services/settingsService'
import { SOURCE_LABEL } from './meta'
import { SettingsReview } from './SettingsReview'

const say = (s: Setting | undefined, v: SettingValue | null) => (v === null ? 'Not set (inherits)' : s ? formatValue(s, v) : String(v))

/** Where a change was made, for a preview of putting it back. A graph's place needs its graph id, which history doesn't carry. */
function placeOf(set: ChangeSet): SettingsPlace | null {
    if (set.scope === 'platform') return PLATFORM
    if (set.scope === 'workspace') return { scope: 'workspace', workspaceId: set.scopeId }
    return null
}

function limitsChanged(e: HistoryEntry) {
    return (e.from.limits !== null || e.to.limits !== null) && !sameLimits(e.from.limits, e.to.limits)
}

/** The review's items for putting a change set back: each value from what it was set to, to what it was. */
function revertItems(set: ChangeSet, settings: Record<string, Setting>): ReviewItem[] {
    return set.entries.flatMap((e) => {
        const s = settings[e.key]
        const label = s?.label ?? e.key
        const items: ReviewItem[] = []
        if (e.from.value !== e.to.value) {
            items.push({
                key: e.key, id: `${e.key}:value`, label,
                from: say(s, e.to.value), to: say(s, e.from.value), how: 'Put back',
                takesEffect: s?.takesEffect.text ?? '',
                impacts: s && e.from.value !== null && e.to.value !== null ? changeImpacts(s, e.to.value, e.from.value) : [],
            })
        }
        if (s && limitsChanged(e)) {
            items.push({
                key: e.key, id: `${e.key}:limits`, label: `${label}: what workspaces and graphs may choose`,
                from: describeLimits(s, e.to.limits ?? s.defaultLimits), to: describeLimits(s, e.from.limits ?? s.defaultLimits),
                how: 'Put back', takesEffect: '', impacts: [],
            })
        }
        return items
    })
}

/** A change set in a few words, for its name: "Ada Lovelace’s change to Read mode and 1 more, Today 15:40". */
function changeName(set: ChangeSet, settings: Record<string, Setting>): string {
    const who = set.actor ? `${set.actor.name ?? 'Someone'}’s` : 'The system’s'
    const keys = [...new Set(set.entries.map((e) => settings[e.key]?.label ?? e.key))]
    const what = keys.length > 1 ? `${keys[0]} and ${keys.length - 1} more` : keys[0]
    return `${who} change to ${what}, ${calendarTime(new Date(set.at), Date.now())}`
}

function ChangeSetCard({ set, settings, name, reading, onRevert }: {
    set: ChangeSet
    settings: Record<string, Setting>
    /** The workspace's or graph's name, where the page knows it. */
    name: string | null
    /** The rest of it is being read before it is put back. */
    reading: boolean
    onRevert: (set: ChangeSet) => void
}) {
    const called = changeName(set, settings)
    return (
        <article aria-label={called} className="rounded-2xl border border-glass-border/50 bg-canvas-elevated">
            <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-glass-border/40 px-5 py-3">
                {set.actor ? <PersonChip id={set.actor.id} person={{ name: set.actor.name }} /> : <span className="text-[13px] font-medium text-ink">The system</span>}
                <span className="text-xs text-ink-secondary"><DateTime at={set.at} /></span>
                <Badge tone={set.source === 'revert' ? 'info' : 'neutral'} size="sm" className="dark:text-ink">{SOURCE_LABEL[set.source] ?? set.source}</Badge>
                <ScopeBadge scope={set.scope} />
                {set.scope !== 'platform' && (name
                    ? <span className="max-w-[14rem] truncate text-xs font-medium text-ink-secondary" title={set.scopeId}>{name}</span>
                    : <code className="max-w-[12rem] truncate font-mono text-[10.5px] text-ink-secondary" title={set.scopeId}>{set.scopeId}</code>)}
                <Button size="sm" variant="ghost" leftIcon={Undo2} loading={reading} onClick={() => onRevert(set)} className="ml-auto text-ink-secondary"
                    aria-label={`Put back ${called}`}>
                    Put back…
                </Button>
            </header>
            <div className="space-y-3 px-5 py-3.5">
                <p className="text-[13px] leading-relaxed text-ink-secondary">
                    {set.reason ? <>“{set.reason}”</> : <span className="italic">No reason given.</span>}
                </p>
                <ul className="space-y-1.5">
                    {set.entries.map((e) => {
                        const s = settings[e.key]
                        return (
                            <li key={e.id} className="text-[13px]">
                                <span className="font-medium text-ink">{s?.label ?? e.key}</span>
                                {e.from.value !== e.to.value && (
                                    <span className="ml-2 inline-flex flex-wrap items-center gap-1.5 text-ink-secondary">
                                        <span className="line-through decoration-ink-muted/50"><span className="sr-only">From </span>{say(s, e.from.value)}</span>
                                        <ArrowRight aria-hidden className="w-3 h-3 text-ink-muted" />
                                        <span className="font-semibold text-ink"><span className="sr-only">to </span>{say(s, e.to.value)}</span>
                                    </span>
                                )}
                                {s && limitsChanged(e) && (
                                    <span className="mt-0.5 block text-[12px] text-ink-secondary">
                                        What workspaces and graphs may choose: {describeLimits(s, e.from.limits ?? s.defaultLimits)}
                                        {' → '}<span className="font-semibold text-ink">{describeLimits(s, e.to.limits ?? s.defaultLimits)}</span>
                                    </span>
                                )}
                            </li>
                        )
                    })}
                </ul>
            </div>
        </article>
    )
}

interface PersonOption {
    id: string
    label: string
    detail?: string
}

/**
 * "Who": anyone, found by name in the directory as it is typed; the reader ("Me") and the people
 * on the pages read so far are offered before anything is typed. A combobox: ↑ ↓ move, Enter
 * picks, Esc closes the list or clears what is typed.
 */
function PersonFilter({ value, seen, onChange }: {
    value: string | undefined
    seen: Array<{ id: string; name: string | null }>
    onChange: (id: string | undefined) => void
}) {
    const id = useId()
    const me = useAuthStore((st) => st.user)
    const chosen = usePerson(value)
    const [query, setQuery] = useState('')
    const [open, setOpen] = useState(false)
    const [active, setActive] = useState(0)
    const term = useDebouncedValue(query.trim(), 250)
    const found = useQuery({
        queryKey: ['directory', 'search', 'user', term],
        queryFn: () => searchDirectory(term, { types: ['user'], limit: 20 }),
        enabled: open && term.length > 0,
        staleTime: 60_000,
    })
    const options = useMemo(() => {
        const q = query.trim().toLowerCase()
        const out: PersonOption[] = []
        const add = (o: PersonOption) => { if (!out.some((x) => x.id === o.id)) out.push(o) }
        const matches = (...words: Array<string | null | undefined>) => !q || words.some((w) => w?.toLowerCase().includes(q))
        if (me && matches('me', me.email, me.displayName, `${me.firstName} ${me.lastName}`)) add({ id: me.id, label: 'Me', detail: me.email })
        for (const p of seen) if (matches(p.name, p.id)) add({ id: p.id, label: p.name ?? p.id, detail: 'Made changes listed here' })
        for (const u of term && term === query.trim() ? found.data?.users ?? [] : []) add({ id: u.id, label: u.displayName, detail: u.email })
        return out
    }, [query, term, me, seen, found.data])
    const name = value ? (value === me?.id ? 'Me' : seen.find((p) => p.id === value)?.name ?? chosen?.displayName ?? value) : ''
    const showList = open
    const pick = (o: PersonOption | undefined) => {
        onChange(o?.id)
        setQuery('')
        setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setOpen(true)
            if (options.length) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length)
        } else if (e.key === 'Enter' && showList && options[active]) {
            e.preventDefault()
            pick(options[active])
        } else if (e.key === 'Escape') {
            if (showList) setOpen(false)
            else setQuery('')
        }
    }
    const searching = found.isFetching && term.length > 0
    return (
        <div className="relative">
            <div className={cn(CONTROL_SHELL, CONTROL_SIZE.sm, 'w-56 pl-2.5 pr-1')}>
                <Search aria-hidden className="w-3.5 h-3.5 shrink-0 text-ink-secondary" />
                <input
                    type="text"
                    role="combobox"
                    aria-label="Who"
                    aria-expanded={showList}
                    aria-controls={`${id}-people`}
                    aria-autocomplete="list"
                    aria-activedescendant={showList && options[active] ? `${id}-person-${active}` : undefined}
                    placeholder="Anyone"
                    value={open ? query : name}
                    onChange={(e) => { setQuery(e.target.value); setActive(0); setOpen(true) }}
                    onFocus={() => { setQuery(''); setActive(0); setOpen(true) }}
                    onBlur={() => setOpen(false)}
                    onKeyDown={onKeyDown}
                    className="h-full min-w-0 flex-1 bg-transparent px-2 text-xs text-ink outline-none placeholder:text-ink-secondary"
                />
                {value && (
                    <button type="button" aria-label="Anyone: clear who" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(undefined)}
                        className="grid place-items-center w-6 h-6 shrink-0 rounded-md text-ink-secondary outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                        <X aria-hidden className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>
            <ul id={`${id}-people`} role="listbox" aria-label="People" hidden={!showList}
                className={cn('absolute left-0 top-full z-40 mt-1.5 max-h-72 w-72 overflow-y-auto rounded-2xl border border-glass-border/60 bg-canvas-elevated p-1.5',
                    'shadow-[0_1px_2px_rgba(15,23,42,0.08),0_18px_48px_-18px_rgba(15,23,42,0.45)] dark:shadow-[0_18px_48px_-18px_rgba(0,0,0,0.9)]')}>
                {options.map((o, i) => (
                    <li key={o.id} id={`${id}-person-${i}`} role="option" aria-selected={i === active}
                        onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => pick(o)}
                        className={cn('cursor-pointer rounded-xl px-3 py-1.5', i === active && 'bg-black/[0.05] dark:bg-white/[0.07]')}>
                        <span className="block truncate text-[13px] font-medium text-ink">{o.label}</span>
                        {o.detail && <span className="block truncate text-[11px] text-ink-secondary">{o.detail}</span>}
                    </li>
                ))}
                {options.length === 0 && (
                    <li role="presentation" className="px-3 py-2.5 text-xs text-ink-secondary">
                        {searching ? 'Searching…' : term ? `Nobody found for “${term}”.` : 'Type a name or an email to find someone.'}
                    </li>
                )}
            </ul>
        </div>
    )
}

export function HistoryView({ schema, place = PLATFORM, placeName, onGoToSettings }: {
    schema: ServedSchema
    /** Whose history: the platform's (every change), or a workspace's (its own values and its graphs'). */
    place?: SettingsPlace
    /** A workspace's or a graph's name, by its id (a graph's: its data source's), where the page knows it. */
    placeName?: (scope: Scope, scopeId: string) => string | null
    onGoToSettings: () => void
}) {
    const [filter, setFilter] = useState<HistoryFilter>({})
    // The days as picked (YYYY-MM-DD): they stay what the inputs show, in any time zone. The
    // request asks from the start of the first to the end of the last, in the reader's zone.
    const [days, setDays] = useState<{ since: string; until: string }>({ since: '', until: '' })
    const asked = useMemo((): HistoryFilter => ({
        ...filter,
        ...(days.since ? { since: new Date(`${days.since}T00:00:00`).toISOString() } : {}),
        ...(days.until ? { until: new Date(`${days.until}T23:59:59.999`).toISOString() } : {}),
    }), [filter, days])
    const q = useSettingsHistory(place, asked)
    const settings = useMemo(() => Object.fromEntries(schema.settings.map((s) => [s.key, s])), [schema.settings])
    const entries = useMemo(() => q.data?.pages.flatMap((p) => p.entries) ?? [], [q.data])
    const sets = useMemo(() => groupChangeSets(entries), [entries])
    const people = useMemo(() => [...new Map(entries.flatMap((e) => (e.actor ? [[e.actor.id, e.actor]] : []))).values()], [entries])
    // The change set being put back, by id: read again as more of it arrives.
    const [revertingId, setRevertingId] = useState<string | null>(null)
    const reverting = revertingId ? sets.find((x) => x.id === revertingId) ?? null : null
    const setReverting = (set: ChangeSet | null) => setRevertingId(set?.id ?? null)
    const [reading, setReading] = useState<string | null>(null)
    const [round, setRound] = useState(0)
    const [error, setError] = useState<SettingsRequestError | null>(null)
    const revert = useRevertChangeSet(place)
    const { notify } = useAppNotifications()
    const filtered = Object.keys(asked).length > 0
    const clearFilters = () => {
        setFilter({})
        setDays({ since: '', until: '' })
    }
    const nameOf = (set: ChangeSet) => (set.scope === 'platform' ? null : placeName?.(set.scope, set.scopeId) ?? null)
    /** Where putting a change set back applies, for its review: "the platform", "the Finance workspace", "Sales lineage". */
    const whereOf = (set: ChangeSet) => {
        const name = nameOf(set)
        if (set.scope === 'platform') return 'the platform'
        if (set.scope === 'workspace') return name ? `the ${name} workspace` : 'a workspace'
        return name ?? 'a graph'
    }

    const revertPlace = reverting ? placeOf(reverting) : null
    const previewItems = useMemo(() => (reverting && revertPlace ? reverting.entries.map((e) => ({
        key: e.key,
        ...(e.from.value !== e.to.value ? { value: e.from.value } : {}),
        ...(reverting.scope === 'platform' && limitsChanged(e) ? { limits: e.from.limits as Limits | null } : {}),
        expectedVersion: e.version,
    })) : []), [reverting, revertPlace])
    const preview = useSettingsPreview(revertPlace ?? PLATFORM, previewItems, 'full', { enabled: Boolean(reverting && revertPlace) })

    const field = (key: keyof HistoryFilter) => (value: string) => setFilter((f) => {
        const next = { ...f }
        if (value) (next as Record<string, string>)[key] = value
        else delete next[key]
        return next
    })

    /**
     * Put back a change set, whole: one the pages split (the last read, with more to read) is read
     * to its end first, so the review lists every value it puts back.
     */
    const askRevert = async (set: ChangeSet) => {
        setError(null)
        if (set.id === sets.at(-1)?.id && q.hasNextPage) {
            setReading(set.id)
            try {
                let page = await q.fetchNextPage()
                while (page.hasNextPage && page.data?.pages.at(-1)?.entries.at(-1)?.changeSetId === set.id) page = await q.fetchNextPage()
            } finally {
                setReading(null)
            }
        }
        setReverting(set)
    }

    const doRevert = async (reason: string) => {
        if (!reverting) return
        setError(null)
        try {
            const res = await revert.mutateAsync({ changeSetId: reverting.id, reason })
            const n = reverting.entries.length
            setReverting(null)
            setRound((r) => r + 1)
            const undoId = res.changeSetId
            notify('success', `Put back ${n} ${n === 1 ? 'value' : 'values'}.`, undoId ? {
                label: 'Undo',
                onClick: () => void revert.mutateAsync({ changeSetId: undoId, reason: `Undo: ${reason}` })
                    .then(() => notify('success', 'Undone: the values are as they were.'))
                    .catch((e) => notify('error', `Couldn’t undo: ${settingsError(e).message}`)),
            } : undefined, undoId ? 10_000 : undefined)
        } catch (err) {
            setError(settingsError(err))
        }
    }

    return (
        <section aria-labelledby="history-title" className="space-y-5">
            <div>
                <h2 id="history-title" className="text-lg font-semibold tracking-tight text-ink">Every change, with why</h2>
                <p className="text-[13px] text-ink-secondary">Each save is recorded with who made it, when, the reason they gave, and every value before and after.</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <Select size="sm" aria-label="Setting" value={filter.key ?? ''} onChange={field('key')}
                    options={[{ value: '', label: 'Every setting' }, ...schema.settings.map((s) => ({ value: s.key, label: s.label }))]} />
                {place.scope === 'platform' && (
                    <Select size="sm" aria-label="Where" value={filter.scope ?? ''} onChange={field('scope')}
                        options={[{ value: '', label: 'Platform, workspaces and graphs' }, { value: 'platform', label: 'The platform' },
                            { value: 'workspace', label: 'Workspaces' }, { value: 'graph', label: 'Graphs' }]} />
                )}
                <PersonFilter value={filter.actor} seen={people} onChange={(id) => field('actor')(id ?? '')} />
                <label className="inline-flex items-center gap-1.5 text-xs text-ink-secondary">
                    From
                    <Input type="date" size="sm" aria-label="Changed on or after" value={days.since} max={days.until || undefined}
                        onChange={(e) => setDays((d) => ({ ...d, since: e.target.value }))} containerClassName="w-40" />
                </label>
                <label className="inline-flex items-center gap-1.5 text-xs text-ink-secondary">
                    to
                    <Input type="date" size="sm" aria-label="Changed on or before" value={days.until} min={days.since || undefined}
                        onChange={(e) => setDays((d) => ({ ...d, until: e.target.value }))} containerClassName="w-40" />
                </label>
                {filtered && <Button size="sm" variant="ghost" leftIcon={Undo2} onClick={clearFilters} className="text-ink-secondary">Clear filters</Button>}
            </div>

            {q.isPending ? (
                <div aria-busy="true" aria-label="Loading the history" className="space-y-3">
                    {[0, 1, 2].map((i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
                </div>
            ) : q.error ? (
                <div role="alert" className="flex flex-wrap items-center gap-3 rounded-2xl border border-rose-500/25 bg-rose-500/[0.05] px-4 py-3">
                    <p className="min-w-0 flex-1 text-[13px] text-rose-700 dark:text-rose-300">Couldn’t read the history: {settingsError(q.error).message}</p>
                    <Button size="sm" leftIcon={RotateCw} onClick={() => void q.refetch()}>Try again</Button>
                </div>
            ) : sets.length === 0 ? (
                <EmptyState
                    icon={History}
                    title={filtered ? 'No change matches these filters' : 'No changes yet'}
                    description={filtered ? 'Try fewer filters.' : 'Every save of a versioned-graph setting is listed here, with who made it, when and why. Nothing has been changed since settings moved here.'}
                    action={filtered ? { label: 'Clear filters', onClick: clearFilters } : { label: 'Go to settings', onClick: onGoToSettings }}
                />
            ) : (
                <div className="space-y-3">
                    {sets.map((set) => (
                        <ChangeSetCard key={set.id} set={set} settings={settings} name={nameOf(set)} reading={reading === set.id}
                            onRevert={(x) => { void askRevert(x) }} />
                    ))}
                    {q.hasNextPage && (
                        <div className="flex justify-center pt-1">
                            <Button size="sm" variant="secondary" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Load older changes</Button>
                        </div>
                    )}
                </div>
            )}

            <SettingsReview
                open={reverting !== null}
                onOpenChange={(open) => { if (!open) setReverting(null) }}
                items={reverting ? revertItems(reverting, settings) : []}
                where={reverting ? whereOf(reverting) : ''}
                settings={settings}
                dimensions={schema.dimensions}
                impact={revertPlace ? preview.data?.impact : undefined}
                impactPending={Boolean(revertPlace) && preview.isFetching}
                impactError={revertPlace && preview.error ? settingsError(preview.error) : null}
                onRetryImpact={() => void preview.refetch()}
                impactNote={reverting && !revertPlace ? 'What putting a graph’s values back does is checked when they are put back: a value someone changed since is refused, and nothing changes.' : undefined}
                onSave={doRevert}
                saving={revert.isPending}
                error={error}
                round={round}
            />
        </section>
    )
}
