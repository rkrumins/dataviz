/**
 * WorkspaceGraphs — a workspace's versioned graphs, a page at a time: what each sets itself, and
 * the read mode and residency class in force. Where the value in force is the one chosen, it says
 * where that was chosen; where it differs (switch when ready updating in place while New-version
 * builds are off), it says what was chosen, where, and why it isn't in force. Each graph opens its
 * settings in the drawer, or its data source. A fork has no settings of its own: it follows the
 * graph it was forked from. With none yet, it offers the workspace's data sources, where version
 * control is turned on for a graph.
 *
 * Every value is the server's (`GET /{ws}/versioning/settings/graphs`); a phone shows each graph as
 * a card.
 */
import { useState, type ReactNode } from 'react'
import { FolderOpen, GitFork, Network, RotateCw, Settings2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatCount } from '@/lib/units'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { ScopeBadge, StatusBadge, formatValue, sameValue, type Setting } from '@/components/settings'
import {
    settingsError, useWorkspaceGraphs, type BriefSetting, type ServedSchema, type WorkspaceGraph,
} from '@/services/settingsService'
import { graphName } from './meta'

const COLS = 'lg:grid lg:grid-cols-[minmax(12rem,1.3fr)_minmax(10rem,1fr)_minmax(11rem,1fr)_minmax(10rem,0.9fr)_9.5rem] lg:gap-x-5'
const SHOWN_OWN = 3

/** A cell, with its column's name above it on a phone. */
function Cell({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
    return (
        <div role="cell" className={cn('min-w-0', className)}>
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-secondary lg:hidden">{label}</p>
            {children}
        </div>
    )
}

/** Where a value was chosen; on a fork, a graph's value is its root's (`root`: its name). */
function Source({ source, root }: { source: BriefSetting['source']; root?: string }) {
    if (source === 'graph' && root) {
        return (
            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-black/[0.05] px-1.5 py-px text-[11px] font-medium leading-4 text-ink-secondary dark:bg-white/[0.07]">
                <GitFork aria-hidden className="w-3 h-3 shrink-0" /> From {root}
            </span>
        )
    }
    return <ScopeBadge scope={source} prefix={source === 'default' ? undefined : source === 'env' ? 'Set by' : source === 'graph' ? 'Set at' : 'From'} />
}

/**
 * One setting at a graph: the value in force. Chosen there, it says where; held back, it says what
 * was chosen and where, and why it isn't in force. A fork's are its root's (`root`).
 */
function Brief({ setting, brief, root }: { setting: Setting | undefined; brief: BriefSetting; root?: string }) {
    const say = (v: BriefSetting['effective']) => (setting ? formatValue(setting, v) : String(v))
    const chosen = brief.declared !== null && !sameValue(brief.declared, brief.effective) ? say(brief.declared) : null
    const why = brief.status !== 'in_effect' ? brief.why[0]?.text : undefined
    return (
        <div className="space-y-1">
            <p className="text-[13px] font-medium text-ink">{say(brief.effective)}</p>
            {chosen ? (
                <p className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-secondary">
                    <span>Chosen: {chosen}</span>
                    <Source source={brief.source} root={root} />
                </p>
            ) : (
                <div className="flex flex-wrap items-center gap-1.5"><Source source={brief.source} root={root} /></div>
            )}
            {brief.status !== 'in_effect' && <StatusBadge status={brief.status} />}
            {why && <p className="text-[11.5px] leading-snug text-amber-800 dark:text-amber-300">{why}</p>}
        </div>
    )
}

export function WorkspaceGraphs({ workspaceId, schema, onOpenSettings, onOpenDataSource, onOpenDataSources }: {
    workspaceId: string
    schema: ServedSchema
    onOpenSettings: (graph: WorkspaceGraph) => void
    onOpenDataSource: (dataSourceId: string) => void
    /** The workspace's data sources: with no versioned graph yet, the next step. */
    onOpenDataSources?: () => void
}) {
    const q = useWorkspaceGraphs(workspaceId)
    // The graphs whose own settings are all shown, not only the first few.
    const [shownAll, setShownAll] = useState<ReadonlySet<string>>(() => new Set())
    const toggleAll = (graphId: string) => setShownAll((prev) => {
        const next = new Set(prev)
        if (!next.delete(graphId)) next.add(graphId)
        return next
    })
    const graphs = q.data?.pages.flatMap((p) => p.graphs) ?? []
    const byKey = Object.fromEntries(schema.settings.map((s) => [s.key, s]))
    const byId = new Map(graphs.map((g) => [g.graphId, g]))
    const own = graphs.filter((g) => g.ownSettings.length > 0).length
    const readsLabel = byKey['reads.mode']?.label ?? 'Read mode'
    const classLabel = byKey['residency.class']?.label ?? 'Residency class'

    if (q.isPending) {
        return (
            <div aria-busy="true" aria-label="Loading this workspace’s graphs" className="space-y-2">
                {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 rounded-2xl" />)}
            </div>
        )
    }
    if (q.error) {
        return (
            <div role="alert" className="flex flex-wrap items-center gap-3 rounded-2xl border border-rose-500/25 bg-rose-500/[0.05] px-5 py-4">
                <p className="min-w-0 flex-1 text-[13px] text-rose-700 dark:text-rose-300">Couldn’t list this workspace’s graphs: {settingsError(q.error).message}</p>
                <Button size="sm" leftIcon={RotateCw} onClick={() => void q.refetch()}>Try again</Button>
            </div>
        )
    }
    if (graphs.length === 0) {
        return (
            <EmptyState icon={Network} title="No versioned graphs here yet"
                description="A data source’s graph is listed here once version control is on for it, on the data source’s Versioning tab. It follows this workspace’s defaults until it sets its own."
                action={onOpenDataSources && { label: 'Open data sources', icon: FolderOpen, onClick: onOpenDataSources }} />
        )
    }

    return (
        <section aria-labelledby="workspace-graphs-title" className="space-y-4">
            <div>
                <h2 id="workspace-graphs-title" className="text-lg font-semibold tracking-tight text-ink">This workspace’s graphs</h2>
                <p className="text-[13px] text-ink-secondary">
                    {formatCount(graphs.length, 'graph')}{q.hasNextPage ? ' so far' : ''} · {own === 0 ? 'none sets values of its own'
                        : own === 1 ? '1 sets values of its own' : `${formatCount(own)} set values of their own`}.
                    {' '}A graph follows the defaults unless it sets its own; a fork follows the graph it was forked from.
                </p>
            </div>

            <div role="table" aria-label="This workspace’s graphs" aria-rowcount={graphs.length + 1} className="rounded-2xl border border-glass-border/50 bg-canvas-elevated">
                <div role="rowgroup" className="hidden border-b border-glass-border/50 lg:block">
                    <div role="row" aria-rowindex={1} className={cn(COLS, 'px-5 py-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-secondary')}>
                        <span role="columnheader">Graph</span>
                        <span role="columnheader">Set for this graph</span>
                        <span role="columnheader">{readsLabel}</span>
                        <span role="columnheader">{classLabel}</span>
                        <span role="columnheader"><span className="sr-only">Actions</span></span>
                    </div>
                </div>
                <div role="rowgroup">
                    {graphs.map((g, i) => {
                        const name = graphName(g)
                        const root = g.follows ? byId.get(g.follows.graphId) : undefined
                        const rootName = g.follows ? (root ? graphName(root) : 'its root') : undefined
                        const labels = g.ownSettings.map((k) => byKey[k]?.label ?? k)
                        const more = labels.length - SHOWN_OWN
                        const all = shownAll.has(g.graphId)
                        return (
                            <div key={g.graphId} role="row" aria-rowindex={i + 2}
                                className={cn(COLS, 'space-y-3 border-b border-glass-border/40 px-5 py-4 last:border-b-0 lg:space-y-0')}>
                                <Cell label="Graph">
                                    <div className="flex flex-wrap items-center gap-1.5">
                                        <span className={cn('max-w-full truncate', g.label ? 'text-[13px] font-semibold text-ink' : 'font-mono text-[11.5px] text-ink-secondary')} title={g.graphId}>
                                            {name}
                                        </span>
                                        {g.follows && <Badge tone="info" size="sm"><GitFork aria-hidden className="w-3 h-3" /> Fork</Badge>}
                                    </div>
                                    {g.follows && (
                                        <p className="mt-0.5 text-[11.5px] text-ink-secondary">Follows {root ? rootName : 'the graph it was forked from'}</p>
                                    )}
                                </Cell>
                                <Cell label="Set for this graph">
                                    {g.follows ? (
                                        <p className="text-[12.5px] text-ink-secondary">Nothing: a fork follows its root’s settings</p>
                                    ) : labels.length === 0 ? (
                                        <p className="text-[12.5px] text-ink-secondary">Nothing: it follows the workspace</p>
                                    ) : (
                                        <>
                                            <p className="text-[12.5px] font-medium text-ink">{formatCount(labels.length, 'setting')} of its own</p>
                                            <ul id={`own-${g.graphId}`} className="mt-1 flex flex-wrap items-center gap-1" aria-label={`Set for ${name}`}>
                                                {(all ? labels : labels.slice(0, SHOWN_OWN)).map((l) => (
                                                    <li key={l}><Badge tone="neutral" variant="outline" size="sm">{l}</Badge></li>
                                                ))}
                                                {more > 0 && (
                                                    <li>
                                                        <button type="button" onClick={() => toggleAll(g.graphId)} aria-expanded={all} aria-controls={`own-${g.graphId}`}
                                                            className="rounded px-1 text-[11px] font-semibold leading-4 text-indigo-700 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent-lineage/40 dark:text-indigo-300">
                                                            {all ? 'Show fewer' : `+${formatCount(more, 'more setting')}`}
                                                        </button>
                                                    </li>
                                                )}
                                            </ul>
                                        </>
                                    )}
                                </Cell>
                                <Cell label={readsLabel}>
                                    <Brief setting={byKey['reads.mode']} brief={g.readMode} root={rootName} />
                                </Cell>
                                <Cell label={classLabel}>
                                    <Brief setting={byKey['residency.class']} brief={g.residencyClass} root={rootName} />
                                </Cell>
                                <div role="cell" className="flex flex-wrap items-start gap-1.5 lg:flex-col lg:items-stretch">
                                    <Button size="sm" variant="secondary" leftIcon={Settings2} onClick={() => onOpenSettings(g)} aria-label={`Settings for ${name}`}>
                                        Settings…
                                    </Button>
                                    {g.dataSourceId && (
                                        <Button size="sm" variant="ghost" leftIcon={FolderOpen} onClick={() => onOpenDataSource(g.dataSourceId!)} aria-label={`Open the data source of ${name}`}
                                            className="text-ink-secondary">
                                            Data source
                                        </Button>
                                    )}
                                </div>
                            </div>
                        )
                    })}
                </div>
            </div>

            {q.hasNextPage && (
                <div className="flex justify-center">
                    <Button size="sm" variant="secondary" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Show more graphs</Button>
                </div>
            )}
        </section>
    )
}
