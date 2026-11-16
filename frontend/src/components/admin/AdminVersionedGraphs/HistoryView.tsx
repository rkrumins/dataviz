/**
 * History — every change to versioned-graph settings, newest first: who made it, when, why, how
 * (saved here, through the old settings, carried over when settings moved, or a revert), where (the
 * platform, a workspace, a graph), and each value and limit from → to.
 *
 * Filters run on the server. "Put back…" opens the same review a save does — what each value goes
 * back to, what that would do where it can be worked out, a reason — then reverts the change as one.
 */
import { useMemo, useState } from 'react'
import { ArrowRight, History, RotateCw, Undo2 } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { DateTime } from '@/components/ui/DateTime'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Input'
import { PersonChip } from '@/components/ui/PersonChip'
import { Select } from '@/components/ui/Select'
import { Skeleton } from '@/components/ui/Skeleton'
import { useAppNotifications } from '@/components/ui/notifications'
import {
    ScopeBadge, changeImpacts, describeLimits, formatValue, sameLimits, type Limits, type ReviewItem, type Setting, type SettingValue,
} from '@/components/settings'
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

function ChangeSetCard({ set, settings, onRevert }: { set: ChangeSet; settings: Record<string, Setting>; onRevert: (set: ChangeSet) => void }) {
    return (
        <article aria-label={`Change by ${set.actor?.name ?? 'the system'}`} className="rounded-2xl border border-glass-border/50 bg-canvas-elevated">
            <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-glass-border/40 px-5 py-3">
                {set.actor ? <PersonChip id={set.actor.id} person={{ name: set.actor.name }} /> : <span className="text-[13px] font-medium text-ink">The system</span>}
                <span className="text-xs text-ink-muted"><DateTime at={set.at} /></span>
                <Badge tone={set.source === 'revert' ? 'info' : 'neutral'} size="sm">{SOURCE_LABEL[set.source] ?? set.source}</Badge>
                <ScopeBadge scope={set.scope} />
                {set.scope !== 'platform' && <code className="max-w-[12rem] truncate font-mono text-[10.5px] text-ink-muted" title={set.scopeId}>{set.scopeId}</code>}
                <Button size="sm" variant="ghost" leftIcon={Undo2} onClick={() => onRevert(set)} className="ml-auto">Put back…</Button>
            </header>
            <div className="space-y-3 px-5 py-3.5">
                <p className="text-[13px] leading-relaxed text-ink-secondary">
                    {set.reason ? <>“{set.reason}”</> : <span className="text-ink-muted">No reason given.</span>}
                </p>
                <ul className="space-y-1.5">
                    {set.entries.map((e) => {
                        const s = settings[e.key]
                        return (
                            <li key={e.id} className="text-[13px]">
                                <span className="font-medium text-ink">{s?.label ?? e.key}</span>
                                {e.from.value !== e.to.value && (
                                    <span className="ml-2 inline-flex flex-wrap items-center gap-1.5 text-ink-secondary">
                                        <span className="text-ink-muted line-through decoration-ink-muted/50"><span className="sr-only">From </span>{say(s, e.from.value)}</span>
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

export function HistoryView({ schema, onGoToSettings }: { schema: ServedSchema; onGoToSettings: () => void }) {
    const [filter, setFilter] = useState<HistoryFilter>({})
    const q = useSettingsHistory(PLATFORM, filter)
    const settings = useMemo(() => Object.fromEntries(schema.settings.map((s) => [s.key, s])), [schema.settings])
    const entries = useMemo(() => q.data?.pages.flatMap((p) => p.entries) ?? [], [q.data])
    const sets = useMemo(() => groupChangeSets(entries), [entries])
    const people = useMemo(() => [...new Map(entries.flatMap((e) => (e.actor ? [[e.actor.id, e.actor]] : []))).values()], [entries])
    const [reverting, setReverting] = useState<ChangeSet | null>(null)
    const [round, setRound] = useState(0)
    const [error, setError] = useState<SettingsRequestError | null>(null)
    const revert = useRevertChangeSet(PLATFORM)
    const { notify } = useAppNotifications()
    const filtered = Object.keys(filter).length > 0

    const place = reverting ? placeOf(reverting) : null
    const previewItems = useMemo(() => (reverting && place ? reverting.entries.map((e) => ({
        key: e.key,
        ...(e.from.value !== e.to.value ? { value: e.from.value } : {}),
        ...(reverting.scope === 'platform' && limitsChanged(e) ? { limits: e.from.limits as Limits | null } : {}),
        expectedVersion: e.version,
    })) : []), [reverting, place])
    const preview = useSettingsPreview(place ?? PLATFORM, previewItems, 'full', { enabled: Boolean(reverting && place) })

    const field = (key: keyof HistoryFilter) => (value: string) => setFilter((f) => {
        const next = { ...f }
        if (value) (next as Record<string, string>)[key] = value
        else delete next[key]
        return next
    })
    const day = (value: string, end = false) => (value ? new Date(`${value}T${end ? '23:59:59' : '00:00:00'}`).toISOString() : '')

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
                <p className="text-[13px] text-ink-muted">Each save is recorded with who made it, when, the reason they gave, and every value before and after.</p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <Select size="sm" aria-label="Setting" value={filter.key ?? ''} onChange={field('key')}
                    options={[{ value: '', label: 'Every setting' }, ...schema.settings.map((s) => ({ value: s.key, label: s.label }))]} />
                <Select size="sm" aria-label="Where" value={filter.scope ?? ''} onChange={field('scope')}
                    options={[{ value: '', label: 'Platform, workspaces and graphs' }, { value: 'platform', label: 'The platform' },
                        { value: 'workspace', label: 'Workspaces' }, { value: 'graph', label: 'Graphs' }]} />
                <Select size="sm" aria-label="Who" value={filter.actor ?? ''} onChange={field('actor')}
                    options={[{ value: '', label: 'Anyone' }, ...people.map((p) => ({ value: p.id, label: p.name ?? p.id }))]} />
                <label className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
                    From
                    <Input type="date" size="sm" aria-label="Changed on or after" value={filter.since?.slice(0, 10) ?? ''}
                        onChange={(e) => field('since')(day(e.target.value))} containerClassName="w-40" />
                </label>
                <label className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
                    to
                    <Input type="date" size="sm" aria-label="Changed on or before" value={filter.until?.slice(0, 10) ?? ''}
                        onChange={(e) => field('until')(day(e.target.value, true))} containerClassName="w-40" />
                </label>
                {filtered && <Button size="sm" variant="ghost" leftIcon={Undo2} onClick={() => setFilter({})}>Clear filters</Button>}
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
                    action={filtered ? { label: 'Clear filters', onClick: () => setFilter({}) } : { label: 'Go to settings', onClick: onGoToSettings }}
                />
            ) : (
                <div className="space-y-3">
                    {sets.map((set) => <ChangeSetCard key={set.id} set={set} settings={settings} onRevert={(s) => { setError(null); setReverting(s) }} />)}
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
                where={!reverting ? '' : reverting.scope === 'platform' ? 'the platform' : reverting.scope === 'workspace' ? 'a workspace' : 'a graph'}
                settings={settings}
                dimensions={schema.dimensions}
                impact={place ? preview.data?.impact : undefined}
                impactPending={Boolean(place) && preview.isFetching}
                impactError={place && preview.error ? settingsError(preview.error) : null}
                onRetryImpact={() => void preview.refetch()}
                impactNote={reverting && !place ? 'What putting a graph’s values back does is checked when they are put back: a value someone changed since is refused, and nothing changes.' : undefined}
                onSave={doRevert}
                saving={revert.isPending}
                error={error}
                round={round}
            />
        </section>
    )
}
