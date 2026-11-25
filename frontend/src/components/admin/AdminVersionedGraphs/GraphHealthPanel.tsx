/**
 * GraphHealthPanel — how a graph is doing right now, at the top of its settings: how far its
 * readers are behind and where reads come from, the read mode in force and why, its last update,
 * its memory, its last new-version build, what happened to it in the last day, and how many of
 * the graph store's property names it uses.
 *
 * Every part is the server's and best effort: a part it couldn't read says "—" and why. Until the
 * server reports health (404), the panel draws nothing. A fork has no copy of its own: what it
 * serves, its memory and its builds are its root's, and the panel says so, naming the root.
 *
 * The Business view tells a version by when it was published and by whom ("the version published
 * 3 min ago by Ada Lovelace"), never by its number, and names no graph store node. The Technical
 * view keeps both.
 */
import type { ReactNode } from 'react'
import { Activity, RotateCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatBytes, formatCount, formatDuration, formatNumber } from '@/lib/units'
import { Button } from '@/components/ui/Button'
import { DateTime } from '@/components/ui/DateTime'
import { Skeleton } from '@/components/ui/Skeleton'
import { CATALOGUE, type Lens } from '@/components/settings'
import { UpdateProgress } from '@/features/versioning/components/UpdateProgress'
import { settingsError, useGraphHealth, type GraphHealth, type PropertyNames, type Revision, type SignalDefinition } from '@/services/settingsService'
import { PropertyNameBudget } from '../PropertyNameBudget'
import { ResidencyChip } from './GraphInventory'

const READS = CATALOGUE.settings.find((s) => s.key === 'reads.mode')!
const CLASSES = CATALOGUE.settings.find((s) => s.key === 'residency.class')!

type LastBuild = NonNullable<GraphHealth['lastBuild']>

/** What a waiting build waits for, as the server names it. */
const WAITING_FOR: Record<NonNullable<LastBuild['waitingFor']>, string> = {
    room: 'Waiting for room for its copy',
    lock: 'Waiting for another change to finish',
    summaries: 'Waiting for a summaries job to finish',
}

/** A version's revision: "#214 published 3 min ago by Alice: “Q4 import”". */
function Published({ revision, seq, lead }: { revision: Revision | null | undefined; seq: number | undefined; lead?: string }) {
    if (!revision || seq === undefined) return null
    return (
        <span className="mt-0.5 block text-[11.5px] text-ink-secondary">
            {lead}#{seq} published{revision.at && <> <DateTime at={revision.at} /></>}
            {revision.actor && <> by {revision.actor.name ?? revision.actor.id}</>}
            {revision.message && <>: “{revision.message}”</>}
        </span>
    )
}

/**
 * A version as the Business view tells it, by when and by whom, never by its number: "the version
 * published 3 min ago by Ada Lovelace: “Q4 import”" (`first`: capitalised). When neither is known,
 * `unknown`.
 */
function PublishedVersion({ revision, first = false, unknown }: { revision: Revision | null | undefined; first?: boolean; unknown: string }) {
    const who = revision?.actor ? revision.actor.name ?? revision.actor.id : null
    if (!revision || (!revision.at && !who)) return <>{unknown}</>
    return (
        <>
            {first ? 'The' : 'the'} version published{revision.at && <> <DateTime at={revision.at} /></>}{who && <> by {who}</>}
            {revision.message && <>: “{revision.message}”</>}
        </>
    )
}

/** One fact: its name, and its value or "—" with why. A `<div>` grouping a `<dt>` and its `<dd>`. */
function Fact({ label, missing, children, className }: { label: string; missing?: string | null; children?: ReactNode; className?: string }) {
    return (
        <div className={cn('min-w-0', className)}>
            <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-secondary">{label}</dt>
            <dd className="mt-0.5 text-[13px] leading-snug text-ink">
                {missing !== undefined && missing !== null
                    ? <><span aria-hidden>—</span><span className="sr-only">Not known</span><span className="block text-[11.5px] text-ink-secondary">{missing}</span></>
                    : children}
            </dd>
        </div>
    )
}

/** From when a copy the build left goes: still kept until then, or due to go now. */
function CopyRemoval({ after, asOf, whose }: { after: string; asOf: string; whose: string }) {
    return new Date(after).getTime() > new Date(asOf).getTime()
        ? <>{whose} kept until <DateTime at={after} variant="calendar" /></>
        : <>{whose} due to be removed (from <DateTime at={after} variant="calendar" />)</>
}

/** The last new-version build, in the server's terms: in flight, switched to, not switched to, or none. */
function LastBuildFact({ b, asOf }: { b: LastBuild; asOf: string }) {
    if (b.outcome === 'none') {
        return <>{b.windowSecs != null ? `None in flight, and none switched to in the last ${formatDuration(b.windowSecs)}` : 'None in flight'}</>
    }
    if (b.outcome === 'running' || b.outcome === 'waiting') {
        return (
            <>
                {b.outcome === 'running' ? 'Being built' : b.waitingFor ? WAITING_FOR[b.waitingFor] : 'Waiting'}
                <span className="block text-[11.5px] text-ink-secondary">
                    {b.since ? <DateTime at={b.since} prefix="Asked for " /> : 'When it was asked for isn’t known'}
                    {b.attempts ? ` · ${formatCount(b.attempts, 'failed attempts')}` : ''}
                </span>
                {b.why && (b.outcome === 'running' || !b.waitingFor) && (
                    <span className="block text-[11.5px] text-ink-secondary">{b.outcome === 'running' ? `Last attempt failed: ${b.why}` : b.why}</span>
                )}
            </>
        )
    }
    const switched = b.outcome === 'switched'
    return (
        <>
            {switched ? 'Switched to the new version' : 'Not switched to'}
            <span className="block text-[11.5px] text-ink-secondary">
                {b.at ? <DateTime at={b.at} prefix={switched ? 'Switched ' : 'Given up '} />
                    : switched ? 'When isn’t known: the graph has been updated since' : 'When isn’t known'}
            </span>
            {b.copyRemovedAfter && (
                <span className="block text-[11.5px] text-ink-secondary">
                    <CopyRemoval after={b.copyRemovedAfter} asOf={asOf} whose={switched ? 'Previous copy' : 'Its copy'} />
                </span>
            )}
        </>
    )
}

/** At most this many of the keys kept as values are named, per kind; the rest are counted. */
const NAMED_KEYS = 8

function KeptAsValues({ what, keys }: { what: string; keys: string[] }) {
    if (keys.length === 0) return null
    const shown = keys.slice(0, NAMED_KEYS)
    return (
        <span className="mt-1 flex flex-wrap items-center gap-1">
            <span className="text-[11.5px] text-ink-secondary">{what}:</span>
            {shown.map((k) => (
                <code key={k} className="rounded-md bg-black/[0.05] px-1.5 py-0.5 text-[11px] text-ink dark:bg-white/[0.07]">{k}</code>
            ))}
            {keys.length > shown.length && <span className="text-[11.5px] text-ink-secondary">and {formatNumber(keys.length - shown.length)} more</span>}
        </span>
    )
}

/**
 * The graph's property names against the two limits that matter: the platform's budget, past which
 * a new name is kept as a value (nothing is lost; it is searched by presence and equality), and the
 * graph store's ceiling, which no write can pass and which is never given back.
 */
function PropertyNamesFact({ n }: { n: PropertyNames }) {
    const budget = formatNumber(n.budget)
    const kept = n.storedAsValues
    return (
        <>
            <PropertyNameBudget
                total={n.registered}
                platform={n.platform}
                source={n.registered != null && n.platform != null ? Math.max(0, n.registered - n.platform) : null}
                budget={n.budget}
                compact
            />
            <span className="mt-1.5 block text-[11.5px] text-ink-secondary">
                {n.registered == null
                    ? 'Counted at its next update. Items and relationships share these names, and none is ever freed.'
                    : `Items and relationships share these names, and none is ever freed. The mark is the ${budget} the platform writes as searchable properties.`}
            </span>
            {n.state === 'near_budget' && (
                <span role="status" className="mt-1 block text-[11.5px] text-amber-700 dark:text-amber-300">
                    Close to {budget}: property names added past it are kept as values — still shown and exported, and searched with is set, is, is not and is one of.
                </span>
            )}
            {n.state === 'at_budget' && (
                <span role="status" className="mt-1 block text-[11.5px] text-rose-700 dark:text-rose-300">
                    At {budget}: new property names are kept as values — still shown and exported, and searched with is set, is, is not and is one of. Reuse existing names where you can.
                </span>
            )}
            {kept && kept.count > 0 && (
                <span className="mt-1 block text-[11.5px] text-ink">
                    {formatCount(kept.count, 'property key')} kept as values
                    <KeptAsValues what="On items" keys={kept.nodes} />
                    <KeptAsValues what="On relationships" keys={kept.edges} />
                </span>
            )}
            {n.measuredAt && (
                <span className="mt-1 block text-[11px] text-ink-muted">
                    <DateTime at={n.measuredAt} prefix={n.measuredBy === 'poll' ? 'As its data source was last counted, ' : 'As its last update found, '} />
                </span>
            )}
        </>
    )
}

export function GraphHealthPanel({ workspaceId, graphId, enabled, signals: definitions = [], lens = 'operator' }: {
    workspaceId: string
    graphId: string
    enabled: boolean
    /** The registry's signals, to name the counts. */
    signals?: SignalDefinition[]
    /** The app's view: Business tells a version by when and by whom, and names no node. */
    lens?: Lens
}) {
    const business = lens === 'business'
    const q = useGraphHealth(workspaceId, graphId, enabled)
    if (q.data === null) return null
    if (q.isPending) return <Skeleton aria-label="Reading this graph’s health" className="h-40 rounded-2xl" />
    if (q.error) {
        return (
            <div role="alert" className="flex flex-wrap items-center gap-3 rounded-2xl border border-glass-border/60 px-4 py-3">
                <p className="min-w-0 flex-1 text-[13px] text-ink-secondary">Couldn’t read this graph’s health: {settingsError(q.error).message}</p>
                <Button size="sm" leftIcon={RotateCw} onClick={() => void q.refetch()}>Try again</Button>
            </div>
        )
    }
    const h = q.data
    const why = (part: string) => h.problems.find((p) => p.part === part)?.message ?? 'Not reported for this graph.'
    const missing = (part: string, value: unknown) => (value === null || value === undefined ? why(part) : null)
    const reads = h.readMode ? READS.choices.find((c) => c.id === h.readMode?.effective) : undefined
    const declared = h.readMode?.declared && h.readMode.declared !== h.readMode.effective
        ? READS.choices.find((c) => c.id === h.readMode?.declared) : undefined
    const behind = h.versionsBehind
    // A fork reads through its root's copy: what it serves, its memory and its builds are the root's.
    const root = h.follows ? (h.follows.label ?? h.follows.graphId) : null
    const definition = (id: string) => definitions.find((d) => d.id === id)
    // The registry names each signal; until it does, its id in words ("reads.asked_to_retry" → "Reads: asked to retry").
    const label = (id: string) => definition(id)?.label
        ?? id.replace(/^(\w)(\w*)\./, (_m, a: string, b: string) => `${a.toUpperCase()}${b}: `).replaceAll('_', ' ')
    const happened = (h.signals ?? []).filter((s) => s.count24h > 0)
    const memory = h.memory
    // As the inventory has it: null when the graph has no copy in the graph store yet.
    const state = memory?.state
    const newer = h.head && h.serving && h.head.seq !== h.serving.seq ? h.head : null
    const source = h.serving?.source === 'graph_store' ? 'Read from the graph store'
        : h.serving?.source === 'database' ? 'Read from the database while the graph store catches up' : 'Where reads come from isn’t known'

    return (
        <section aria-labelledby={`health-${graphId}`} className="rounded-2xl border border-glass-border/60 bg-black/[0.015] px-4 py-4 dark:bg-white/[0.02] sm:px-5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h3 id={`health-${graphId}`} className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-ink">
                    <Activity aria-hidden className="w-3.5 h-3.5 shrink-0 text-ink-muted" />
                    {root ? <span className="min-w-0">Health of {root} <span className="font-normal text-ink-secondary">— this fork reads through it</span></span> : 'Health now'}
                </h3>
                <p className="text-[11px] text-ink-secondary"><DateTime at={h.asOf} prefix="As of " /></p>
            </div>
            <UpdateProgress progress={h.progress} className="mt-3 rounded-xl bg-indigo-500/[0.05] px-3 py-2.5 dark:bg-indigo-400/[0.07]" />
            <dl className="mt-3 grid gap-x-6 gap-y-3.5 sm:grid-cols-2">
                <Fact label="Readers are" missing={missing('versionsBehind', behind)}>
                    <span className={cn('font-semibold', behind ? 'text-amber-700 dark:text-amber-300' : '')}>
                        {behind === 0 ? 'Up to date' : `${formatCount(behind ?? 0, 'versions')} behind`}
                    </span>
                </Fact>
                <Fact label={root ? 'Serving, through its root' : 'Serving'} missing={missing('serving', h.serving) ?? missing('head', h.head)}>
                    {business ? (
                        <>
                            <PublishedVersion revision={h.serving?.version} first unknown="The version in use now" />
                            <span className="block text-[11.5px] text-ink-secondary">{source}</span>
                            {newer && (
                                <span className="mt-0.5 block text-[11.5px] text-ink-secondary">
                                    Latest: <PublishedVersion revision={newer.version} unknown="a newer version, not served yet" />
                                </span>
                            )}
                        </>
                    ) : (
                        <>
                            Version #{h.serving?.seq}
                            {newer && <span className="text-ink-secondary"> · latest #{newer.seq}</span>}
                            <span className="block text-[11.5px] text-ink-secondary">{source}</span>
                            <Published revision={h.serving?.version} seq={h.serving?.seq} />
                            {newer && <Published revision={newer.version} seq={newer.seq} lead="Latest: " />}
                        </>
                    )}
                </Fact>
                <Fact label="Readers get" missing={missing('readMode', h.readMode)}>
                    {reads?.title ?? h.readMode?.effective}
                    {declared && <span className="block text-[11.5px] text-ink-secondary">Chosen: {declared.title}</span>}
                    {h.readMode?.why[0] && <span className="block text-[11.5px] text-amber-700 dark:text-amber-300">{h.readMode.why[0].text}</span>}
                </Fact>
                <Fact label="Last update" missing={missing('lastUpdate', h.lastUpdate)}>
                    {h.lastUpdate?.durationSecs != null ? formatDuration(h.lastUpdate.durationSecs) : '—'}
                    {h.lastUpdate?.rows != null && <> for {formatCount(h.lastUpdate.rows, 'rows')}</>}
                    <span className="block text-[11.5px] text-ink-secondary">
                        {h.lastUpdate?.ratePerSec != null && `${formatNumber(h.lastUpdate.ratePerSec, { maxFractionDigits: 0 })} rows a second · `}
                        {h.lastUpdate?.finishedAt ? <DateTime at={h.lastUpdate.finishedAt} prefix="finished " /> : 'not finished'}
                    </span>
                </Fact>
                <Fact label={root ? 'Memory, its root’s copy' : 'Memory'} missing={missing('memory', memory)}>
                    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                        {state ? <ResidencyChip state={state} /> : 'No copy in the graph store yet'}
                        {memory?.bytes != null && <span>{formatBytes(memory.bytes)}</span>}
                    </span>
                    <span className="block text-[11.5px] text-ink-secondary">
                        {[
                            memory?.class && `${CLASSES.choices.find((c) => c.id === memory.class)?.title ?? memory.class} class`,
                            !business && memory?.node && `on ${memory.node}`,
                        ].filter(Boolean).join(' · ')}
                        {memory?.rehydratingSince && <> · <DateTime at={memory.rehydratingSince} prefix="loading since " /></>}
                        {memory?.lastReadAt && <> · <DateTime at={memory.lastReadAt} prefix="read " /></>}
                    </span>
                </Fact>
                <Fact label={root ? 'Last new-version build, its root’s' : 'Last new-version build'} missing={missing('lastBuild', h.lastBuild)}>
                    {h.lastBuild && <LastBuildFact b={h.lastBuild} asOf={h.asOf} />}
                </Fact>
                {h.propertyNames !== undefined && (
                    <Fact label={root ? 'Property names, its root’s copy' : 'Property names'} missing={missing('propertyNames', h.propertyNames)} className="sm:col-span-2">
                        {h.propertyNames && <PropertyNamesFact n={h.propertyNames} />}
                    </Fact>
                )}
                <Fact label="Last 24 hours" missing={missing('signals', h.signals)} className="sm:col-span-2">
                    {happened.length === 0 ? 'Nothing out of the ordinary.' : (
                        <ul className="mt-1 space-y-1">
                            {happened.map((s) => (
                                <li key={s.id} className="flex items-baseline gap-2 text-[12.5px] leading-snug">
                                    <span className="shrink-0 whitespace-nowrap font-semibold tabular-nums text-amber-800 dark:text-amber-300">
                                        {formatCount(s.count24h, definition(s.id)?.unit || 'times')}
                                    </span>
                                    <span className="min-w-0 text-ink-secondary">{label(s.id)}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </Fact>
            </dl>
        </section>
    )
}
