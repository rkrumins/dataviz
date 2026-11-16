/**
 * GraphHealthPanel — how a graph is doing right now, at the top of its settings: how far its
 * readers are behind and where reads come from, the read mode in force and why, its last update,
 * its memory, its last new-version build, and what happened to it in the last day.
 *
 * Every part is the server's and best effort: a part it couldn't read says "—" and why. Until the
 * server reports health (404), the panel draws nothing. A fork has no copy of its own: what it
 * serves, its memory and its builds are its root's, and the panel says so, naming the root.
 */
import type { ReactNode } from 'react'
import { Activity, RotateCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatBytes, formatCount, formatDuration, formatNumber } from '@/lib/units'
import { Button } from '@/components/ui/Button'
import { DateTime } from '@/components/ui/DateTime'
import { Skeleton } from '@/components/ui/Skeleton'
import { CATALOGUE } from '@/components/settings'
import { settingsError, useGraphHealth, type GraphHealth, type Revision, type SignalDefinition } from '@/services/settingsService'
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

export function GraphHealthPanel({ workspaceId, graphId, enabled, signals: definitions = [] }: {
    workspaceId: string
    graphId: string
    enabled: boolean
    /** The registry's signals, to name the counts. */
    signals?: SignalDefinition[]
}) {
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

    return (
        <section aria-labelledby={`health-${graphId}`} className="rounded-2xl border border-glass-border/60 bg-black/[0.015] px-4 py-4 dark:bg-white/[0.02] sm:px-5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h3 id={`health-${graphId}`} className="flex min-w-0 items-center gap-2 text-[13px] font-semibold text-ink">
                    <Activity aria-hidden className="w-3.5 h-3.5 shrink-0 text-ink-muted" />
                    {root ? <span className="min-w-0">Health of {root} <span className="font-normal text-ink-secondary">— this fork reads through it</span></span> : 'Health now'}
                </h3>
                <p className="text-[11px] text-ink-secondary"><DateTime at={h.asOf} prefix="As of " /></p>
            </div>
            <dl className="mt-3 grid gap-x-6 gap-y-3.5 sm:grid-cols-2">
                <Fact label="Readers are" missing={missing('versionsBehind', behind)}>
                    <span className={cn('font-semibold', behind ? 'text-amber-700 dark:text-amber-300' : '')}>
                        {behind === 0 ? 'Up to date' : `${formatCount(behind ?? 0, 'versions')} behind`}
                    </span>
                </Fact>
                <Fact label={root ? 'Serving, through its root' : 'Serving'} missing={missing('serving', h.serving) ?? missing('head', h.head)}>
                    Version #{h.serving?.seq}
                    {h.head && h.serving && h.head.seq !== h.serving.seq && <span className="text-ink-secondary"> · latest #{h.head.seq}</span>}
                    <span className="block text-[11.5px] text-ink-secondary">
                        {h.serving?.source === 'graph_store' ? 'Read from the graph store'
                            : h.serving?.source === 'database' ? 'Read from the database while the graph store catches up' : 'Where reads come from isn’t known'}
                    </span>
                    <Published revision={h.serving?.version} seq={h.serving?.seq} />
                    {h.head && h.serving && h.head.seq !== h.serving.seq && <Published revision={h.head.version} seq={h.head.seq} lead="Latest: " />}
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
                            memory?.node && `on ${memory.node}`,
                        ].filter(Boolean).join(' · ')}
                        {memory?.rehydratingSince && <> · <DateTime at={memory.rehydratingSince} prefix="loading since " /></>}
                        {memory?.lastReadAt && <> · <DateTime at={memory.lastReadAt} prefix="read " /></>}
                    </span>
                </Fact>
                <Fact label={root ? 'Last new-version build, its root’s' : 'Last new-version build'} missing={missing('lastBuild', h.lastBuild)}>
                    {h.lastBuild && <LastBuildFact b={h.lastBuild} asOf={h.asOf} />}
                </Fact>
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
