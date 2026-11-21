/**
 * ImpactReportCard — what a change to an entity reaches, and why: how serious it is, how much is
 * affected and of what kind, who uses the end of the line, whom to tell, the lineage paths that
 * carry it there, and when the first job that reads it runs. Upstream it reads the other way:
 * where the entity comes from, ending at its original sources.
 *
 * Every number says whether it is exact, and the card ends on what the walk could not see:
 * a walk cut short, rolled-up (table-level) lineage standing in for physical lineage, notes.
 */
import { useState, type ReactNode } from 'react'
import {
    AlertOctagon, AlertTriangle, ArrowDown, Check, Clock, Copy, GitBranch, Search, ShieldCheck, Users,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { exact } from '@/lib/formatMetric'
import { cn } from '@/lib/utils'
import type { ImpactData, ImpactPath } from '../../api/types'
import { useAssistantActions } from '../../lib/useAssistantActions'
import { useCopy } from '../../lib/useCopy'
import { Caveats, EntityChip, SectionLabel, TypeBars, type Caveat } from './parts'

const SEVERITY = {
    high: { icon: AlertOctagon, band: 'bg-rose-500/10 border-rose-500/25', text: 'text-rose-700 dark:text-rose-300', impact: 'High impact', reach: 'Wide reach' },
    medium: { icon: AlertTriangle, band: 'bg-amber-500/10 border-amber-500/25', text: 'text-amber-700 dark:text-amber-300', impact: 'Medium impact', reach: 'Moderate reach' },
    low: { icon: ShieldCheck, band: 'bg-emerald-500/10 border-emerald-500/25', text: 'text-emerald-700 dark:text-emerald-300', impact: 'Low impact', reach: 'Narrow reach' },
} as const

const CHANGE_WORDS = { drop: 'dropped', rename: 'renamed', type_change: 'given a new type', remove: 'removed' } as const

const LIST_STEP = 6

export function ImpactReportCard({ data }: { data: ImpactData }) {
    const actions = useAssistantActions()
    const [copied, copy] = useCopy()
    const upstream = data.direction === 'upstream'
    const sev = SEVERITY[data.severity] ?? SEVERITY.medium
    const SevIcon = upstream ? GitBranch : sev.icon
    const name = data.target.name

    const title = upstream ? `Where ${name} comes from`
        : data.change ? `What breaks if ${name} is ${CHANGE_WORDS[data.change] ?? 'changed'}`
            : `What depends on ${name}`
    const badge = upstream ? 'Upstream lineage' : data.change ? sev.impact : sev.reach
    const endsLabel = upstream ? 'Sources' : 'Consumers'
    const consumers = data.consumers ?? []
    const owners = data.owners ?? []
    const paths = data.paths ?? []
    const total = `${exact(data.totals.entities)}${data.totals.exact ? '' : '+'}`

    const caveats: Caveat[] = []
    if (data.grain === 'coarse') {
        caveats.push({ tone: 'warning', text: `Traced through rolled-up lineage: table-level links stand in for column-level ones, so this may include things that don’t read ${name} itself.` })
    } else if (data.grain === 'fine') {
        caveats.push({ tone: 'ok', text: 'Traced through physical lineage, link by link.' })
    }
    if (data.truncated) caveats.push({ tone: 'warning', text: 'The walk stopped before the end of the lineage — there may be more than shown.' })
    if (!data.totals.exact) caveats.push({ tone: 'warning', text: `Counts are a floor: at least ${exact(data.totals.entities)}.` })
    for (const text of data.notes ?? []) caveats.push({ tone: 'info', text })

    return (
        <section aria-label={title} className="overflow-hidden rounded-xl border border-glass-border bg-canvas shadow-sm shadow-black/5">
            {/* Severity: the first thing read, in its colour. */}
            <header className={cn('border-b px-3.5 pb-3 pt-3', upstream ? 'border-accent-lineage/20 bg-accent-lineage/5' : sev.band)}>
                <div className={cn('flex items-center gap-1.5 text-2xs font-bold uppercase tracking-wider', upstream ? 'text-accent-lineage' : sev.text)}>
                    <SevIcon className="h-3.5 w-3.5" aria-hidden />
                    {badge}
                </div>
                <h3 className="mt-1 text-base font-semibold leading-snug text-ink">{title}</h3>
                <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-xs text-ink-muted">
                    <EntityChip entity={data.target} viewId={data.viewId} />
                </div>
                {data.severityReasons && data.severityReasons.length > 0 && (
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                        {data.severityReasons.map((r) => (
                            <li key={r} className="rounded-full border border-glass-border bg-canvas/70 px-2 py-0.5 text-xs text-ink-secondary">{r}</li>
                        ))}
                    </ul>
                )}
            </header>

            <div className="space-y-4 px-3.5 py-3.5">
                <p className="text-sm leading-relaxed text-ink">{data.summary}</p>

                <dl className="grid grid-cols-3 gap-2">
                    <Stat value={total} label={upstream ? 'upstream' : data.change ? 'affected' : 'downstream'} />
                    <Stat value={exact(consumers.length)} label={endsLabel.toLowerCase()} />
                    <Stat value={exact(owners.length)} label={owners.length === 1 ? 'owner' : 'owners'} />
                </dl>

                {data.totals.byType && data.totals.byType.length > 0 && (
                    <div>
                        <SectionLabel>{upstream ? 'Upstream, by type' : 'Affected, by type'}</SectionLabel>
                        <TypeBars rows={data.totals.byType} />
                    </div>
                )}

                {data.byContainer && data.byContainer.length > 0 && (
                    <div>
                        <SectionLabel>Where</SectionLabel>
                        <ul className="flex flex-wrap gap-1.5">
                            {data.byContainer.slice(0, 8).map(({ entity, count }) => (
                                <li key={entity.urn} className="min-w-0 max-w-full">
                                    <EntityChip entity={entity} viewId={data.viewId}
                                                trailing={<span className="ml-0.5 font-semibold tabular-nums text-ink-muted">{exact(count)}</span>} />
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                {consumers.length > 0 && (
                    <ShowMore label={endsLabel} items={consumers} render={(c) => (
                        <li key={c.urn} className="flex items-center justify-between gap-2 py-1">
                            <EntityChip entity={c} viewId={data.viewId} />
                            {typeof c.hops === 'number' && (
                                <span className="shrink-0 text-xs tabular-nums text-ink-muted">{c.hops} {c.hops === 1 ? 'hop' : 'hops'}</span>
                            )}
                        </li>
                    )} />
                )}

                {owners.length > 0 && (
                    <div>
                        <SectionLabel>{upstream ? 'Owners' : 'Owners to notify'}</SectionLabel>
                        <ul className="space-y-2">
                            {owners.map((o) => (
                                <li key={`${o.property}:${o.owner}`} className="rounded-lg border border-glass-border px-2.5 py-2">
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-ink">
                                            <Users className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />
                                            <span className="truncate">{o.owner}</span>
                                        </span>
                                        <span className="shrink-0 text-xs text-ink-muted">
                                            <span className="font-semibold tabular-nums text-ink">{exact(o.count)}</span> {o.count === 1 ? 'asset' : 'assets'}
                                        </span>
                                    </div>
                                    <div className="mt-0.5 text-xs text-ink-muted">From the <span className="font-mono">{o.property}</span> property</div>
                                    {o.assets.length > 0 && (
                                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                                            {o.assets.slice(0, 3).map((a) => <EntityChip key={a.urn} entity={a} viewId={data.viewId} />)}
                                            {o.count > 3 && <span className="self-center text-xs text-ink-muted">+{exact(o.count - Math.min(3, o.assets.length))} more</span>}
                                        </div>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}

                {paths.length > 0 && <WhyPaths paths={paths} viewId={data.viewId} upstream={upstream} />}

                {data.timing && (data.timing.note || data.timing.schedules.length > 0) && (
                    <div>
                        <SectionLabel>When</SectionLabel>
                        {data.timing.note && (
                            <p className="flex items-start gap-1.5 text-sm text-ink">
                                <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-lineage" aria-hidden />
                                {data.timing.note}
                            </p>
                        )}
                        {data.timing.schedules.length > 0 && (
                            <ul className="mt-1.5 space-y-1">
                                {data.timing.schedules.map((s) => (
                                    <li key={`${s.job.urn}:${s.schedule}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-secondary">
                                        <EntityChip entity={s.job} viewId={data.viewId} />
                                        <span>{s.human}</span>
                                        <code className="rounded bg-black/[0.05] px-1 font-mono text-2xs text-ink-muted dark:bg-white/[0.07]">{s.schedule}</code>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                )}

                <Caveats items={caveats} />
            </div>

            <footer className="flex flex-wrap items-center gap-1.5 border-t border-glass-border bg-black/[0.02] px-3 py-2 dark:bg-white/[0.02]">
                {data.trace && data.viewId && (
                    <Button size="sm" variant="primary" leftIcon={GitBranch}
                            onClick={() => actions.openTrace({ viewId: data.viewId!, urn: data.trace!.urn, direction: data.trace!.direction, depth: data.trace!.depth })}>
                        Open trace
                    </Button>
                )}
                {data.query?.predicate && data.viewId && (
                    <Button size="sm" variant="secondary" leftIcon={Search} onClick={() => actions.openSearch(data.viewId!, data.query!.predicate)}>
                        Open in Advanced Search
                    </Button>
                )}
                {owners.length > 0 && (
                    <Button size="sm" variant="ghost" leftIcon={copied ? Check : Copy}
                            onClick={() => copy(owners.map((o) => `${o.owner}\t${o.count}`).join('\n'))}>
                        {copied ? 'Copied' : 'Copy owners'}
                    </Button>
                )}
            </footer>
        </section>
    )
}

function Stat({ value, label }: { value: string; label: string }) {
    return (
        <div className="flex flex-col-reverse rounded-lg border border-glass-border bg-black/[0.02] px-2 py-1.5 dark:bg-white/[0.02]">
            <dt className="text-xs text-ink-muted">{label}</dt>
            <dd className="text-lg font-semibold leading-tight tabular-nums text-ink">{value}</dd>
        </div>
    )
}

function ShowMore<T>({ label, items, render }: { label: string; items: T[]; render: (item: T) => ReactNode }) {
    const [all, setAll] = useState(false)
    const shown = all ? items : items.slice(0, LIST_STEP)
    return (
        <div>
            <SectionLabel aside={items.length > LIST_STEP && (
                <button type="button" onClick={() => setAll(!all)} aria-expanded={all}
                        className="text-xs font-medium text-accent-lineage hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                    {all ? 'Show fewer' : `Show all ${exact(items.length)}`}
                </button>
            )}>
                {label}
            </SectionLabel>
            <ul className="divide-y divide-glass-border/60">{shown.map(render)}</ul>
        </div>
    )
}

/** The lineage paths that carry the change — each a chain, the link between two steps under the arrow. */
function WhyPaths({ paths, viewId, upstream }: { paths: ImpactPath[]; viewId?: string; upstream: boolean }) {
    const [all, setAll] = useState(false)
    const shown = all ? paths : paths.slice(0, 2)
    return (
        <div>
            <SectionLabel aside={paths.length > 2 && (
                <button type="button" onClick={() => setAll(!all)} aria-expanded={all}
                        className="text-xs font-medium text-accent-lineage hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                    {all ? 'Show fewer' : `Show all ${paths.length} paths`}
                </button>
            )}>
                Why
            </SectionLabel>
            <ol className="space-y-2">
                {shown.map((p, i) => (
                    <li key={i} aria-label={`Path ${i + 1}: ${p.nodes.map((n) => n.name).join(upstream ? ' from ' : ' to ')}`}
                        className="rounded-lg border border-glass-border px-2.5 py-2">
                        {p.nodes.map((n, j) => {
                            const edge = j < p.edges.length ? p.edges[j] : null
                            return (
                                <div key={`${n.urn}:${j}`}>
                                    <EntityChip entity={n} viewId={viewId} />
                                    {edge && j < p.nodes.length - 1 && (
                                        <div className="ml-2 flex gap-2 border-l border-dashed border-accent-lineage/40 py-1 pl-3">
                                            <ArrowDown className="-ml-[1.15rem] mt-0.5 h-3 w-3 shrink-0 rounded-full bg-canvas text-accent-lineage" aria-hidden />
                                            <div className="min-w-0">
                                                <div className="text-2xs font-semibold uppercase tracking-wider text-ink-muted">{edge.type.replace(/_/g, ' ').toLowerCase()}</div>
                                                {edge.detail && <code className="block break-words font-mono text-xs text-ink-secondary">{edge.detail}</code>}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )
                        })}
                    </li>
                ))}
            </ol>
        </div>
    )
}
