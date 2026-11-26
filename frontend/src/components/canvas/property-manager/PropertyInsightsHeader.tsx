/**
 * PropertyInsightsHeader — the overview strip at the top of the
 * Properties tab. Four stat tiles (Entities · Properties · Tags · Types),
 * all exact — read from every entity in the view by the property catalog —
 * and, below them, how the numbers were come by: how far a read that is
 * still running has got, or when the catalog was read, with a refresh.
 *
 * For the relationships between the view's entities (``subject``), three:
 * Relationships · Properties · Relationship types, under a line saying what
 * they are read from — and what they leave out.
 */
import { AlertTriangle, Boxes, Database, Info, Layers, RefreshCw, Spline, Tag, Waypoints } from 'lucide-react'
import { type FC, type ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { compactNum } from '@/components/dashboard/dashboard-constants'
import { HoverTip } from '@/components/ui/HoverTip'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { formatUtc, timeAgo } from '@/lib/timeAgo'
import type { CatalogSubject, SearchCatalogResult } from '@/types/search'


export interface PropertyInsightsHeaderProps {
    catalog: SearchCatalogResult
    /** How far a running read has got, 0–100; null when none runs. */
    reading: number | null
    /** Why the last read failed, when the catalog shown is an older one. */
    error?: string | null
    onRefresh: () => void
    /** Whose properties the catalog lists. */
    subject?: CatalogSubject
    /** For relationships: how many entities in the view they run between, when known. */
    entities?: number | null
}

export const PropertyInsightsHeader: FC<PropertyInsightsHeaderProps> = ({
    catalog, reading, error, onRefresh, subject = 'entities', entities = null,
}) => {
    // Until the first read completes, every number is what has been read so
    // far — a floor, shown as "≥ N".
    const floor = catalog.status !== 'complete'
    const edges = subject === 'relationships'
    const every = edges ? 'every relationship' : 'every entity'

    return (
        <div className={cn(
            'relative overflow-hidden rounded-2xl p-3',
            'bg-gradient-to-br from-accent-lineage/[0.08] via-canvas-elevated to-purple-500/[0.06]',
            'border border-glass-border',
        )}>
            <div className="pointer-events-none absolute -top-10 -right-10 w-28 h-28 rounded-full bg-accent-lineage/10 blur-3xl" />
            {edges && (
                <div className="relative mb-2 flex items-center gap-1.5 text-[11px] text-ink-secondary">
                    <Waypoints className="w-3.5 h-3.5 shrink-0 text-accent-lineage" aria-hidden />
                    <span className="min-w-0">
                        Relationships between the{' '}
                        {entities !== null && <span className="font-semibold text-ink tabular-nums">{entities.toLocaleString()} </span>}
                        entities in this view
                    </span>
                    <HoverTip
                        label="Combined flows aren't counted"
                        detail="The canvas's rollups of many relationships into one carry no properties of their own — the relationships they combine are counted instead."
                        className="ml-auto shrink-0 inline-flex"
                    >
                        <button type="button" aria-label="What is counted" className="inline-flex w-5 h-5 items-center justify-center rounded-md text-ink-muted hover:text-ink hover:bg-glass transition-colors">
                            <Info className="w-3 h-3" aria-hidden />
                        </button>
                    </HoverTip>
                </div>
            )}
            <div className={cn('relative grid gap-2', edges ? 'grid-cols-3' : 'grid-cols-4')}>
                {edges ? (
                    <>
                        <StatTile icon={<Waypoints className="w-3.5 h-3.5" />} value={catalog.entities}
                            label="Relationships" tone="text-cyan-400" atLeast={floor} />
                        <StatTile icon={<Database className="w-3.5 h-3.5" />} value={catalog.properties.length}
                            label="Properties" tone="text-accent-lineage" atLeast={floor} />
                        <StatTile icon={<Spline className="w-3.5 h-3.5" />} value={catalog.entityTypes.length}
                            label="Relationship types" tone="text-emerald-400" atLeast={floor} />
                    </>
                ) : (
                    <>
                        <StatTile icon={<Boxes className="w-3.5 h-3.5" />} value={catalog.entities}
                            label="Entities" tone="text-cyan-400" atLeast={floor} />
                        <StatTile icon={<Database className="w-3.5 h-3.5" />} value={catalog.properties.length}
                            label="Properties" tone="text-accent-lineage" atLeast={floor} />
                        <StatTile icon={<Tag className="w-3.5 h-3.5" />} value={catalog.tags.length}
                            label="Tags" tone="text-fuchsia-400" atLeast={floor} />
                        <StatTile icon={<Layers className="w-3.5 h-3.5" />} value={catalog.entityTypes.length}
                            label="Types" tone="text-emerald-400" atLeast={floor} />
                    </>
                )}
            </div>
            <div className="relative mt-2.5">
                {reading !== null ? (
                    <div className="flex flex-col gap-1.5">
                        <ProgressBar value={reading} label={`Reading ${every} in this view`} />
                        <span className="text-[10.5px] text-ink-muted tabular-nums">
                            {floor ? `Reading ${every} in this view` : 'Reading the view again'}
                            {' · '}{reading}%
                        </span>
                    </div>
                ) : (
                    <div className="flex items-center gap-2 text-[10.5px] text-ink-muted">
                        <span className="min-w-0 truncate" title={catalog.asOf ? formatUtc(catalog.asOf) : undefined}>
                            Exact — {every} read{catalog.asOf ? ` ${timeAgo(catalog.asOf)}` : ''}
                        </span>
                        <button
                            type="button"
                            onClick={onRefresh}
                            aria-label="Read the view again"
                            className="ml-auto shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-ink-muted hover:text-ink hover:bg-glass transition-colors"
                        >
                            <RefreshCw className="w-3 h-3" /> Refresh
                        </button>
                    </div>
                )}
                {/* Its own line, never cut short: what it says matters more than when. */}
                {reading === null && catalog.stale && (
                    <p className="mt-1 flex items-start gap-1 text-[10.5px] leading-snug text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="mt-px w-3 h-3 shrink-0" aria-hidden />
                        Out of date — the data has changed since. Refresh to read it again.
                    </p>
                )}
                {error && (
                    <p className="mt-1 text-[10.5px] text-rose-400">
                        Couldn't read the view again — {error}
                    </p>
                )}
                {/* How the numbers were come by, where it matters: part of the view left
                    out, or — on a draft — what of it is still the published graph's. */}
                {(catalog.notes ?? []).map((note) => (
                    <p key={note} className="mt-1 flex items-start gap-1 text-[10.5px] leading-snug text-ink-muted">
                        <Info className="mt-px w-3 h-3 shrink-0" aria-hidden /> {note}
                    </p>
                ))}
            </div>
        </div>
    )
}


function StatTile({ icon, value, label, tone, atLeast = false }: {
    icon: ReactNode; value: number; label: string; tone: string
    /** The value is a floor (still counting) — shown as "≥ N". */
    atLeast?: boolean
}) {
    return (
        <div className="flex flex-col items-center text-center gap-0.5 rounded-xl px-1 py-1.5">
            <span className={cn('inline-flex items-center justify-center w-6 h-6 rounded-lg bg-canvas-base', tone)}>
                {icon}
            </span>
            <HoverTip label={`${atLeast ? 'At least ' : ''}${value.toLocaleString()}`} className="inline-flex">
                <span className="text-[15px] font-bold tabular-nums leading-none text-ink">
                    {`${atLeast ? '≥' : ''}${compactNum(value)}`}
                </span>
            </HoverTip>
            <span className="text-[8.5px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                {label}
            </span>
        </div>
    )
}
