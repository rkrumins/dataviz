/**
 * "What I know" — what the assistant already knows about the page before anything is asked:
 * what it is and where it sits, its layers, how its types nest, what connects them, what is in
 * it, what to watch out for, and how much of all this the model is sent. Every section shows
 * only when there is something in it.
 *
 * Three shapes, one content: `popover` over the context chip, `block` in an answer (the
 * `context` card), and `summary`, the one-line card the welcome opens the popover from. Names
 * read as the person's mode does: type names in the Business view, ids (in mono) in Technical.
 */
import { useState, type ComponentType } from 'react'
import {
    AlertTriangle, BookOpen, Check, ChevronRight, Compass, Database, Eye, FolderKanban, Info, Network,
    ShieldCheck, Sparkles, X,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { HoverTip } from '@/components/ui/HoverTip'
import { Skeleton } from '@/components/ui/Skeleton'
import { compact, exact, percent } from '@/lib/formatMetric'
import { timeAgo } from '@/lib/timeAgo'
import { cn } from '@/lib/utils'
import { usePersonaMode } from '@/store/persona'
import { useAiStatus } from '../api/aiQueries'
import type { BriefConnection, ContextBrief } from '../api/types'
import { CardShell, SectionLabel, TypeBars, TypeGlyph } from './blocks/parts'

export type ContextCardVariant = 'popover' | 'block' | 'summary'

/** What the confirm-type heads-up asks in chat; the answer is a clarification with counted options. */
export const CONFIRM_TYPE_QUESTION = 'Which property says what kind of thing each one is?'

type Icon = ComponentType<{ className?: string }>

const KIND: Record<ContextBrief['kind'], { label: string; icon: Icon }> = {
    view: { label: 'View', icon: Eye },
    workspace: { label: 'Workspace', icon: FolderKanban },
    data_source: { label: 'Data source', icon: Database },
    explorer: { label: 'Explorer', icon: Compass },
    ontology: { label: 'Semantic layer', icon: Network },
    doc: { label: 'Page', icon: BookOpen },
    app: { label: 'App', icon: Sparkles },
}

const GROUPS: Array<{ cls: BriefConnection['class']; label: string }> = [
    { cls: 'containment', label: 'Hierarchy' },
    { cls: 'lineage', label: 'Lineage' },
    { cls: 'other', label: 'Other connections' },
]

const TYPES_SHOWN = 8
const PROPERTIES_SHOWN = 6
const TAGS_SHOWN = 10

const plural = (n: number, one: string, many = `${one}s`) => `${exact(n)} ${n === 1 ? one : many}`

/** Type and connection names, as the person's mode reads them. */
function useNames(brief: ContextBrief) {
    const technical = usePersonaMode() === 'technical'
    const types = new Map((brief.types ?? []).map((t) => [t.id, t]))
    const typeText = (id: string) => (technical ? id : types.get(id)?.name ?? id)
    const mono = technical ? 'font-mono text-[11px]' : undefined
    return { technical, types, typeText, mono }
}

export function ContextCard({ brief, variant, onAsk, onOpen, disabled = false }: {
    brief: ContextBrief
    variant: ContextCardVariant
    /** Ask in chat — the confirm-type heads-up. */
    onAsk?: (question: string) => void
    /** `summary`: open the full card. */
    onOpen?: () => void
    disabled?: boolean
}) {
    if (variant === 'summary') return <Summary brief={brief} onOpen={onOpen} />
    const kind = KIND[brief.kind] ?? KIND.app
    if (variant === 'popover') {
        return (
            <>
                <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar">
                    <header className="flex items-start gap-2.5 px-4 pb-3 pt-3.5">
                        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-lineage/10 text-accent-lineage">
                            <kind.icon className="h-4 w-4" aria-hidden />
                        </span>
                        <div className="min-w-0 flex-1">
                            <p className="text-2xs font-semibold uppercase tracking-wider text-ink-muted">What I know · {kind.label}</p>
                            <h3 className="mt-0.5 text-sm font-semibold leading-snug text-ink">{brief.about.name}</h3>
                            <Where brief={brief} />
                        </div>
                    </header>
                    <div className="space-y-4 px-4 pb-4">
                        <Sections brief={brief} onAsk={onAsk} disabled={disabled} />
                    </div>
                </div>
                <div className="shrink-0 border-t border-glass-border bg-black/[0.02] px-4 py-2.5 dark:bg-white/[0.02]">
                    <ModelSees brief={brief} />
                </div>
            </>
        )
    }
    return (
        <CardShell icon={kind.icon} title={brief.about.name} label={`What I know about ${brief.about.name}`}
                   meta={<><span>{kind.label}</span><Where brief={brief} inline /></>}
                   footer={<ModelSees brief={brief} />}>
            <Sections brief={brief} onAsk={onAsk} disabled={disabled} />
        </CardShell>
    )
}

/** The shape of the popover's content, while the brief is on its way. */
export function ContextCardSkeleton({ variant }: { variant: Exclude<ContextCardVariant, 'block'> }) {
    if (variant === 'summary') {
        return (
            <div aria-busy="true" aria-label="Reading what I know about this page" className="flex w-full items-center gap-2.5 rounded-xl border border-glass-border bg-canvas p-3">
                <Skeleton className="h-8 w-8 shrink-0 rounded-lg" />
                <div className="min-w-0 flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-2/5" />
                    <Skeleton className="h-3 w-4/5" />
                </div>
            </div>
        )
    }
    return (
        <div aria-busy="true" aria-label="Reading what I know about this page" className="space-y-4 p-4">
            <div className="flex items-center gap-2.5">
                <Skeleton className="h-8 w-8 shrink-0 rounded-lg" />
                <div className="flex-1 space-y-1.5"><Skeleton className="h-3 w-1/3" /><Skeleton className="h-4 w-1/2" /></div>
            </div>
            <Skeleton className="h-3 w-full" /><Skeleton className="h-3 w-4/5" />
            <div className="flex gap-1.5"><Skeleton className="h-6 w-20 rounded-full" /><Skeleton className="h-6 w-16 rounded-full" /><Skeleton className="h-6 w-24 rounded-full" /></div>
            <Skeleton className="h-16 w-full" />
        </div>
    )
}

/** Workspace › data source, and the semantic layer it is read with. */
function Where({ brief, inline = false }: { brief: ContextBrief; inline?: boolean }) {
    const { workspace, dataSource, semanticLayer } = brief.about
    const path = [workspace, dataSource].filter(Boolean).join(' › ')
    if (!path && !semanticLayer) return null
    return (
        <span className={cn('text-xs text-ink-muted', inline ? 'before:mx-1 before:content-["·"]' : 'mt-0.5 block')}>
            {path}
            {semanticLayer && <>{path ? ' · ' : ''}Semantic layer <span className="text-ink-secondary">{semanticLayer}</span></>}
        </span>
    )
}

function Sections({ brief, onAsk, disabled }: { brief: ContextBrief; onAsk?: (q: string) => void; disabled: boolean }) {
    return (
        <>
            <About brief={brief} />
            <HeadsUp brief={brief} onAsk={onAsk} disabled={disabled} />
            <Kinds brief={brief} />
            <Layers brief={brief} />
            <Hierarchy brief={brief} />
            <Types brief={brief} />
            <Connections brief={brief} />
            <Contents brief={brief} />
            <PageLists brief={brief} />
        </>
    )
}

function About({ brief }: { brief: ContextBrief }) {
    const [more, setMore] = useState(false)
    const { description, tags = [], owner, updatedAt, dataUpdatedAt } = brief.about
    const when = [
        owner ? `By ${owner}` : null,
        updatedAt ? `updated ${timeAgo(updatedAt)}` : null,
        dataUpdatedAt ? `data ${timeAgo(dataUpdatedAt)}` : null,
    ].filter(Boolean).join(' · ')
    if (!description && tags.length === 0 && !when) return null
    const long = !!description && description.length > 160
    return (
        <div className="space-y-2">
            {description && (
                <p className="text-xs leading-relaxed text-ink-secondary">
                    <span className={cn(!more && long && 'line-clamp-3')}>{description}</span>
                    {long && (
                        <button type="button" onClick={() => setMore((m) => !m)}
                                className="ml-1 font-medium text-accent-lineage hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                            {more ? 'less' : 'more'}
                        </button>
                    )}
                </p>
            )}
            {tags.length > 0 && (
                <ul className="flex flex-wrap gap-1" aria-label="Tags">
                    {tags.map((t) => <li key={t}><Badge tone="neutral">{t}</Badge></li>)}
                </ul>
            )}
            {when && <p className="text-[11px] text-ink-muted">{when.charAt(0).toUpperCase() + when.slice(1)}</p>}
        </div>
    )
}

function HeadsUp({ brief, onAsk, disabled }: { brief: ContextBrief; onAsk?: (q: string) => void; disabled: boolean }) {
    const caveats = brief.caveats ?? []
    const notes = brief.notes ?? []
    if (caveats.length === 0 && notes.length === 0) return null
    return (
        <section aria-label="Heads-up">
            <SectionLabel>Heads-up</SectionLabel>
            <ul className="space-y-1.5">
                {caveats.map((c) => (
                    <li key={c.code} className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-2.5 py-2">
                        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-ink">
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                            <span>{c.text}</span>
                        </p>
                        {c.action === 'confirm_type' && onAsk && (
                            <Button size="sm" variant="secondary" className="ml-5 mt-1.5" disabled={disabled}
                                    onClick={() => onAsk(CONFIRM_TYPE_QUESTION)}>
                                Tell it which property
                            </Button>
                        )}
                    </li>
                ))}
                {notes.map((n) => (
                    <li key={n} className="flex items-start gap-1.5 px-0.5 text-xs leading-relaxed text-ink-secondary">
                        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />
                        <span>{n}</span>
                    </li>
                ))}
            </ul>
        </section>
    )
}

/** The property that says what kind of thing each entity is, on a schema with one generic type. */
function Kinds({ brief }: { brief: ContextBrief }) {
    const tp = brief.typeProperty
    const { mono } = useNames(brief)
    if (!tp || tp.values.length === 0) return null
    return (
        <section aria-label="Kinds of thing">
            <SectionLabel aside={tp.status === 'confirmed'
                ? <Badge tone="success">Confirmed</Badge>
                : <Badge tone="warning">Suggested</Badge>}>
                Kinds of thing
            </SectionLabel>
            <ul className="flex flex-wrap gap-1">
                {tp.values.map((v) => (
                    <li key={v.value} className="inline-flex items-center gap-1.5 rounded-md border border-glass-border bg-black/[0.03] px-2 py-0.5 text-xs dark:bg-white/[0.04]">
                        <span className="font-medium text-ink">{v.value}</span>
                        <span className="tabular-nums text-ink-muted">{compact(v.count)}</span>
                    </li>
                ))}
            </ul>
            <p className="mt-1.5 text-[11px] text-ink-muted">
                Read from <span className={cn('text-ink-secondary', mono)}>{tp.key}</span> on every <span className={cn('text-ink-secondary', mono)}>{tp.on}</span>
                {tp.status === 'suggested' ? ' — a guess until you confirm it.' : '.'}
            </p>
        </section>
    )
}

function Layers({ brief }: { brief: ContextBrief }) {
    const { typeText } = useNames(brief)
    const layers = brief.layers ?? []
    if (layers.length === 0) return null
    return (
        <section aria-label="Layers">
            <SectionLabel>Layers</SectionLabel>
            <ol className="flex flex-wrap items-center gap-1">
                {layers.map((l, i) => (
                    <li key={`${i}-${l.name}`} className="flex items-center gap-1">
                        {i > 0 && <ChevronRight className="h-3 w-3 text-ink-muted/70" aria-hidden />}
                        <HoverTip
                            label={l.name}
                            detail={[l.description, l.types.length ? `Holds ${l.types.map(typeText).join(', ')}` : null].filter(Boolean).join(' — ') || undefined}
                        >
                            <span className="inline-flex items-center gap-1.5 rounded-full border border-glass-border bg-canvas py-0.5 pl-0.5 pr-2.5 text-xs text-ink">
                                <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-accent-lineage/10 text-[10px] font-semibold tabular-nums text-accent-lineage">{i + 1}</span>
                                {l.name}
                            </span>
                        </HoverTip>
                    </li>
                ))}
            </ol>
        </section>
    )
}

function Hierarchy({ brief }: { brief: ContextBrief }) {
    const { types, typeText, mono } = useNames(brief)
    const chains = (brief.hierarchy?.chains ?? []).filter((c) => c.length > 0)
    if (chains.length === 0) return null
    return (
        <section aria-label="Hierarchy">
            <SectionLabel>Hierarchy</SectionLabel>
            <div className="space-y-1.5">
                {chains.map((chain) => (
                    <ol key={chain.join('>')} className="flex flex-wrap items-center gap-1">
                        {chain.map((id, i) => {
                            const t = types.get(id)
                            const inView = t?.inView
                            const inSource = t?.inSource
                            return (
                                <li key={id} className="flex items-center gap-1">
                                    {i > 0 && <span aria-hidden className="text-xs text-ink-muted/70">›</span>}
                                    <HoverTip
                                        label={inView != null ? `${exact(inView)} in this view` : t?.name ?? id}
                                        detail={inSource != null ? `${exact(inSource)} in the whole data source` : undefined}
                                    >
                                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border bg-canvas px-2 py-1 text-xs">
                                            <TypeGlyph type={id} />
                                            <span className={cn('font-medium text-ink', mono)}>{typeText(id)}</span>
                                            {inView != null && <span className="font-semibold tabular-nums text-ink-secondary">{compact(inView)}</span>}
                                            {inSource != null && inSource !== inView && <span className="tabular-nums text-ink-muted">/ {compact(inSource)}</span>}
                                        </span>
                                    </HoverTip>
                                </li>
                            )
                        })}
                    </ol>
                ))}
            </div>
        </section>
    )
}

function Types({ brief }: { brief: ContextBrief }) {
    const { technical, typeText, mono } = useNames(brief)
    const all = brief.types ?? []
    if (all.length === 0) return null
    const counted = all.filter((t) => t.inView != null)
    return (
        <section aria-label="Types">
            <SectionLabel aside={<span className="text-[11px] text-ink-muted">{plural(all.length, 'type')}</span>}>Types</SectionLabel>
            {counted.length > 0 ? (
                <TypeBars limit={TYPES_SHOWN} mono={technical}
                          rows={counted.map((t) => ({ type: t.id, label: typeText(t.id), count: t.inView ?? 0 }))} />
            ) : (
                <ul className="flex flex-wrap gap-1">
                    {all.slice(0, TYPES_SHOWN * 2).map((t) => (
                        <li key={t.id}>
                            <HoverTip label={t.name} detail={t.description ?? undefined}>
                                <span className="inline-flex items-center gap-1.5 rounded-md border border-glass-border bg-canvas px-1.5 py-0.5 text-xs text-ink">
                                    <TypeGlyph type={t.id} /><span className={mono}>{typeText(t.id)}</span>
                                </span>
                            </HoverTip>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    )
}

function Connections({ brief }: { brief: ContextBrief }) {
    const { technical, typeText, mono } = useNames(brief)
    const all = brief.connections ?? []
    if (all.length === 0) return null
    const ends = (ids: string[]) => (ids.length ? ids.map(typeText).join(', ') : 'anything')
    return (
        <section aria-label="Connections">
            <SectionLabel>Connections</SectionLabel>
            <div className="space-y-2.5">
                {GROUPS.map(({ cls, label }) => {
                    const items = all.filter((c) => c.class === cls)
                    if (items.length === 0) return null
                    return (
                        <div key={cls}>
                            <h5 className="mb-1 text-[11px] font-medium text-ink-secondary">{label}</h5>
                            <ul className="space-y-1">
                                {items.map((c) => (
                                    <li key={c.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-2 text-xs">
                                        <HoverTip label={c.name} detail={c.description ?? undefined}>
                                            <span className={cn('font-semibold text-ink', technical ? mono : undefined)}>{technical ? c.id : c.name}</span>
                                        </HoverTip>
                                        <span className="truncate text-ink-muted">
                                            <span className={mono}>{ends(c.from)}</span> → <span className={mono}>{ends(c.to)}</span>
                                        </span>
                                        <span className="tabular-nums text-ink-secondary">{c.count != null ? `· ${compact(c.count)}` : ''}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )
                })}
            </div>
        </section>
    )
}

function Contents({ brief }: { brief: ContextBrief }) {
    const c = brief.contents
    if (!c) return null
    const props = c.properties.slice(0, PROPERTIES_SHOWN)
    const moreProps = c.properties.length - props.length + (c.propertiesNotShown ?? 0)
    const tags = c.tags.slice(0, TAGS_SHOWN)
    if (c.entities == null && props.length === 0 && tags.length === 0) return null
    return (
        <section aria-label="What’s in it">
            <SectionLabel aside={!c.complete ? <span className="text-[11px] text-ink-muted">Still counting…</span> : undefined}>What’s in it</SectionLabel>
            {c.entities != null && (
                <p className="text-xs text-ink-secondary">
                    <span className="text-sm font-semibold tabular-nums text-ink">{exact(c.entities)}</span> {c.entities === 1 ? 'entity' : 'entities'}
                </p>
            )}
            {props.length > 0 && (
                <ul className="mt-2 space-y-1.5" aria-label="Properties">
                    {props.map((p) => (
                        <li key={p.key} className="grid grid-cols-[minmax(0,1fr)_3rem_2.5rem] items-center gap-2 text-xs">
                            <span className="truncate font-mono text-[11px] text-ink-secondary">{p.key}</span>
                            <span aria-hidden className="h-1 overflow-hidden rounded-full bg-black/[0.05] dark:bg-white/[0.07]">
                                <span className="block h-full rounded-full bg-accent-lineage/60" style={{ width: `${Math.round((p.coverage ?? 0) * 100)}%` }} />
                            </span>
                            <span className="text-right tabular-nums text-ink-muted">{p.coverage != null ? percent(p.coverage) : compact(p.count)}</span>
                        </li>
                    ))}
                    {moreProps > 0 && <li className="text-[11px] text-ink-muted">and {plural(moreProps, 'more property', 'more properties')}</li>}
                </ul>
            )}
            {tags.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-1" aria-label="Tags in it">
                    {tags.map((t) => (
                        <li key={t.tag}>
                            <Badge tone="neutral">{t.tag}<span className="font-normal tabular-nums text-ink-muted">{compact(t.count)}</span></Badge>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    )
}

/** What the non-view pages add: a workspace's sources, a layer's users, the view a source reads through. */
function PageLists({ brief }: { brief: ContextBrief }) {
    const sources = brief.dataSources ?? []
    const usedBy = brief.usedBy ?? []
    const headings = brief.headings ?? []
    return (
        <>
            {brief.seenThrough && (
                <p className="flex items-center gap-1.5 text-xs text-ink-secondary">
                    <Eye className="h-3.5 w-3.5 shrink-0 text-accent-lineage" aria-hidden />
                    <span>Answers read through <span className="font-medium text-ink">{brief.seenThrough.name}</span>, its most used view.</span>
                </p>
            )}
            {sources.length > 0 && (
                <section aria-label="Data sources">
                    <SectionLabel>Data sources</SectionLabel>
                    <ul className="space-y-1">
                        {sources.map((d) => (
                            <li key={d.id} className="flex items-center gap-1.5 text-xs">
                                <Database className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />
                                <span className="truncate font-medium text-ink">{d.name}</span>
                                {d.semanticLayer && <span className="truncate text-ink-muted">· {d.semanticLayer}</span>}
                            </li>
                        ))}
                    </ul>
                </section>
            )}
            {usedBy.length > 0 && (
                <section aria-label="Used by">
                    <SectionLabel>Used by</SectionLabel>
                    <ul className="space-y-1">
                        {usedBy.map((u) => (
                            <li key={`${u.workspace}/${u.dataSource}`} className="truncate text-xs text-ink-secondary">
                                {u.workspace} › <span className="font-medium text-ink">{u.dataSource}</span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
            {headings.length > 0 && (
                <section aria-label="On this page">
                    <SectionLabel>On this page</SectionLabel>
                    <ul className="space-y-0.5">
                        {headings.map((h) => <li key={h} className="truncate text-xs text-ink-secondary">{h}</li>)}
                    </ul>
                </section>
            )}
        </>
    )
}

/** What of this reaches the model, per the administrator's data-sharing settings. */
function ModelSees({ brief }: { brief: ContextBrief }) {
    const policy = useAiStatus().data?.dataPolicy
    if (!policy) return null
    const confirmed = brief.typeProperty?.status === 'confirmed' ? brief.typeProperty.key : null
    const items: Array<{ label: string; on: boolean }> = [
        { label: 'Descriptions', on: policy.sendDescriptions },
        { label: 'Property values', on: policy.sendPropertyValues },
        { label: 'Sample values', on: policy.sendSampleValues },
    ]
    return (
        <div className="w-full space-y-1.5">
            <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-muted">
                <ShieldCheck className="mt-px h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden />
                <span>
                    <span className="font-semibold text-ink-secondary">What the model sees:</span> names, types, connections and counts, always
                    {confirmed && <>; the kinds in <span className="font-mono">{confirmed}</span>, as type names</>}.
                </span>
            </p>
            <ul className="flex flex-wrap gap-1 pl-5">
                {items.map((i) => (
                    <li key={i.label}>
                        <HoverTip label={i.on ? 'Sent to the model' : 'Not sent to the model'}
                                  detail={i.on ? undefined : 'An administrator chose not to share these'}>
                            <span className={cn('inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-medium',
                                i.on ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-black/[0.05] text-ink-muted dark:bg-white/[0.07]')}>
                                {i.on ? <Check className="h-2.5 w-2.5" aria-hidden /> : <X className="h-2.5 w-2.5" aria-hidden />}
                                {i.label}<span className="sr-only">{i.on ? ': sent' : ': not sent'}</span>
                            </span>
                        </HoverTip>
                    </li>
                ))}
            </ul>
        </div>
    )
}

/** The welcome's one line: name, how much is here, the hierarchy — and the way into the rest. */
function Summary({ brief, onOpen }: { brief: ContextBrief; onOpen?: () => void }) {
    const { typeText } = useNames(brief)
    const kind = KIND[brief.kind] ?? KIND.app
    const entities = brief.contents?.entities
    const stats = [
        entities != null ? plural(entities, 'entity', 'entities') : null,
        brief.types?.length ? plural(brief.types.length, 'type') : null,
        brief.layers?.length ? plural(brief.layers.length, 'layer') : null,
        brief.dataSources?.length ? plural(brief.dataSources.length, 'data source') : null,
    ].filter(Boolean) as string[]
    const chain = brief.hierarchy?.chains.find((c) => c.length > 1)
    const warnings = brief.caveats?.length ?? 0
    return (
        <section aria-label={`What I know about ${brief.about.name}`}
                 className="w-full rounded-xl border border-glass-border bg-canvas p-3 text-left shadow-sm shadow-black/5">
            <div className="flex items-start gap-2.5">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-lineage/10 text-accent-lineage">
                    <kind.icon className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink">{brief.about.name}</p>
                    {stats.length > 0 && <p className="text-xs text-ink-muted">{stats.join(' · ')}</p>}
                    {chain && <p className="mt-1 truncate text-xs text-ink-secondary">{chain.map(typeText).join(' › ')}</p>}
                </div>
            </div>
            <div className="mt-2.5 flex items-center gap-2 border-t border-glass-border pt-2">
                {warnings > 0 && (
                    <span className="flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="h-3 w-3" aria-hidden /> {warnings === 1 ? '1 heads-up' : `${warnings} heads-ups`}
                    </span>
                )}
                {onOpen && (
                    <button type="button" onClick={onOpen}
                            className="ml-auto inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-semibold text-accent-lineage transition-colors hover:bg-accent-lineage/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                        What I know <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                    </button>
                )}
            </div>
        </section>
    )
}

