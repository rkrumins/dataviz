/**
 * GraphHealthPanel — how a graph is doing right now, at the top of its settings: how far its
 * readers are behind and where reads come from, the read mode in force and why, its last update,
 * its memory, its last new-version build, and what happened to it in the last day.
 *
 * Every part is the server's and best effort: a part it couldn't read says "—" and why. Until the
 * server reports health (404), the panel draws nothing.
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

const READS = CATALOGUE.settings.find((s) => s.key === 'reads.mode')!
const CLASSES = CATALOGUE.settings.find((s) => s.key === 'residency.class')!

const BUILD_OUTCOME: Record<NonNullable<GraphHealth['lastBuild']>['outcome'], string> = {
    switched: 'Switched to the new version',
    dropped: 'Dropped after its attempts',
    failed: 'Failed',
    waiting: 'Waiting for room',
    running: 'Being built',
}

/** The latest version's revision: "#214 published 3 min ago by Alice: “Q4 import”". */
function Published({ revision, seq }: { revision: Revision | null; seq: number | undefined }) {
    if (!revision || seq === undefined) return null
    return (
        <span className="mt-0.5 block text-[11.5px] text-ink-muted">
            #{seq} published{revision.at && <> <DateTime at={revision.at} /></>}
            {revision.actor && <> by {revision.actor.name ?? revision.actor.id}</>}
            {revision.message && <>: “{revision.message}”</>}
        </span>
    )
}

/** One fact: its name, and its value or "—" with why. */
function Fact({ label, missing, children }: { label: string; missing?: string | null; children?: ReactNode }) {
    return (
        <div className="min-w-0">
            <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-muted">{label}</dt>
            <dd className="mt-0.5 text-[13px] leading-snug text-ink">
                {missing !== undefined && missing !== null
                    ? <><span aria-hidden>—</span><span className="sr-only">Not known</span><span className="block text-[11.5px] text-ink-muted">{missing}</span></>
                    : children}
            </dd>
        </div>
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
    // The registry names each signal; until it does, its id in words ("reads.asked_to_retry" → "Reads: asked to retry").
    const label = (id: string) => definitions.find((d) => d.id === id)?.label
        ?? id.replace(/^(\w)(\w*)\./, (_m, a: string, b: string) => `${a.toUpperCase()}${b}: `).replaceAll('_', ' ')
    const happened = (h.signals ?? []).filter((s) => s.count24h > 0)

    return (
        <section aria-labelledby={`health-${graphId}`} className="rounded-2xl border border-glass-border/60 bg-black/[0.015] px-4 py-4 dark:bg-white/[0.02] sm:px-5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h3 id={`health-${graphId}`} className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                    <Activity aria-hidden className="w-3.5 h-3.5 text-ink-muted" /> Health now
                </h3>
                <p className="text-[11px] text-ink-muted"><DateTime at={h.asOf} prefix="As of " /></p>
            </div>
            <dl className="mt-3 grid gap-x-6 gap-y-3.5 sm:grid-cols-2">
                <Fact label="Readers are" missing={missing('versionsBehind', behind)}>
                    <span className={cn('font-semibold', behind ? 'text-amber-700 dark:text-amber-300' : '')}>
                        {behind === 0 ? 'Up to date' : `${formatCount(behind ?? 0)} ${behind === 1 ? 'version' : 'versions'} behind`}
                    </span>
                </Fact>
                <Fact label="Serving" missing={missing('serving', h.serving) ?? missing('head', h.head)}>
                    Version #{h.serving?.seq}
                    {h.head && h.serving && h.head.seq !== h.serving.seq && <span className="text-ink-muted"> · latest #{h.head.seq}</span>}
                    <span className="block text-[11.5px] text-ink-muted">
                        {h.serving?.source === 'graph_store' ? 'Read from the graph store'
                            : h.serving?.source === 'database' ? 'Read from the database while the graph store catches up' : 'Where reads come from isn’t known'}
                    </span>
                    <Published revision={h.head?.version ?? null} seq={h.head?.seq} />
                </Fact>
                <Fact label="Readers get" missing={missing('readMode', h.readMode)}>
                    {reads?.title ?? h.readMode?.effective}
                    {declared && <span className="block text-[11.5px] text-ink-muted">Chosen: {declared.title}</span>}
                    {h.readMode?.why[0] && <span className="block text-[11.5px] text-amber-700 dark:text-amber-300">{h.readMode.why[0].text}</span>}
                </Fact>
                <Fact label="Last update" missing={missing('lastUpdate', h.lastUpdate)}>
                    {h.lastUpdate?.durationSecs != null ? formatDuration(h.lastUpdate.durationSecs) : '—'}
                    {h.lastUpdate?.rows != null && <> for {formatCount(h.lastUpdate.rows, 'rows')}</>}
                    <span className="block text-[11.5px] text-ink-muted">
                        {h.lastUpdate?.ratePerSec != null && `${formatNumber(h.lastUpdate.ratePerSec, { maxFractionDigits: 0 })} rows a second · `}
                        {h.lastUpdate?.finishedAt ? <DateTime at={h.lastUpdate.finishedAt} prefix="finished " /> : 'not finished'}
                    </span>
                </Fact>
                <Fact label="Memory" missing={missing('memory', h.memory)}>
                    {h.memory?.loaded == null ? 'Load state not known' : h.memory.loaded ? 'In memory' : 'Unloaded'}
                    {h.memory?.bytes != null && <>, {formatBytes(h.memory.bytes)}</>}
                    <span className="block text-[11.5px] text-ink-muted">
                        {[
                            h.memory?.class && `${CLASSES.choices.find((c) => c.id === h.memory?.class)?.title ?? h.memory.class} class`,
                            h.memory?.node && `on ${h.memory.node}`,
                        ].filter(Boolean).join(' · ')}
                        {h.memory?.lastReadAt && <> · <DateTime at={h.memory.lastReadAt} prefix="read " /></>}
                    </span>
                </Fact>
                <Fact label="Last new-version build" missing={h.lastBuild === null && !h.problems.some((p) => p.part === 'lastBuild') ? 'None built yet.' : missing('lastBuild', h.lastBuild)}>
                    {h.lastBuild && BUILD_OUTCOME[h.lastBuild.outcome]}
                    <span className="block text-[11.5px] text-ink-muted">
                        {h.lastBuild?.at && <DateTime at={h.lastBuild.at} />}{h.lastBuild?.why && ` · ${h.lastBuild.why}`}
                    </span>
                </Fact>
                <div className="sm:col-span-2">
                    <Fact label="Last 24 hours" missing={missing('signals', h.signals)}>
                        {happened.length === 0 ? 'Nothing out of the ordinary.' : (
                            <ul className="mt-1 flex flex-wrap gap-1.5">
                                {happened.map((s) => (
                                    <li key={s.id} className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11.5px] font-medium text-amber-800 dark:text-amber-300">
                                        {label(s.id)}: {formatCount(s.count24h)}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </Fact>
                </div>
            </dl>
        </section>
    )
}
