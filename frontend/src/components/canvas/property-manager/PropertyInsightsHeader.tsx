/**
 * PropertyInsightsHeader — a premium overview strip at the top of the
 * Properties tab. Four stat tiles (Entities · Properties · Tags · Types)
 * plus 0-cost guidance chips derived from discovery. The entity total
 * comes from one eager ``searchAdvanced`` (catalogue overview); everything
 * else is already in discovery.
 */
import { AlertTriangle, Boxes, Database, Layers, Tag } from 'lucide-react'
import { type FC, type ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { compactNum } from '@/components/dashboard/dashboard-constants'
import { useCatalogOverview } from '@/hooks/usePropertyInsights'


export interface PropertyInsightsHeaderProps {
    viewId: string
    propertyCount: number
    tagCount: number
    entityTypeCount: number
    /** Subtle guidance chips (e.g. "3 types not yet migrated"). */
    warnings?: string[]
}

export const PropertyInsightsHeader: FC<PropertyInsightsHeaderProps> = ({
    viewId, propertyCount, tagCount, entityTypeCount, warnings = [],
}) => {
    const overview = useCatalogOverview(viewId)
    const totalEntities = overview.data?.totalEntities

    return (
        <div className={cn(
            'relative overflow-hidden rounded-2xl p-3',
            'bg-gradient-to-br from-accent-lineage/[0.08] via-canvas-elevated/30 to-purple-500/[0.06]',
            'border border-glass-border/60',
        )}>
            <div className="pointer-events-none absolute -top-10 -right-10 w-28 h-28 rounded-full bg-accent-lineage/10 blur-3xl" />
            <div className="relative grid grid-cols-4 gap-2">
                <StatTile
                    icon={<Boxes className="w-3.5 h-3.5" />}
                    value={overview.loading ? null : (totalEntities ?? 0)}
                    label="Entities"
                    tone="text-cyan-400"
                />
                <StatTile icon={<Database className="w-3.5 h-3.5" />} value={propertyCount} label="Properties" tone="text-accent-lineage" />
                <StatTile icon={<Tag className="w-3.5 h-3.5" />} value={tagCount} label="Tags" tone="text-fuchsia-400" />
                <StatTile icon={<Layers className="w-3.5 h-3.5" />} value={entityTypeCount} label="Types" tone="text-emerald-400" />
            </div>
            {warnings.length > 0 && (
                <div className="relative mt-2 flex flex-wrap gap-1.5">
                    {warnings.map((w) => (
                        <span
                            key={w}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] bg-amber-500/12 text-amber-300 border border-amber-500/25"
                            title={w}
                        >
                            <AlertTriangle className="w-2.5 h-2.5 shrink-0" />
                            <span className="truncate max-w-[160px]">{w}</span>
                        </span>
                    ))}
                </div>
            )}
        </div>
    )
}


function StatTile({ icon, value, label, tone }: {
    icon: ReactNode; value: number | null; label: string; tone: string
}) {
    return (
        <div className="flex flex-col items-center text-center gap-0.5 rounded-xl px-1 py-1.5">
            <span className={cn('inline-flex items-center justify-center w-6 h-6 rounded-lg bg-canvas-base/50', tone)}>
                {icon}
            </span>
            <span className="text-[15px] font-bold tabular-nums leading-none text-ink" title={value === null ? undefined : value.toLocaleString()}>
                {value === null ? <span className="inline-block w-5 h-3.5 rounded skeleton align-middle" /> : compactNum(value)}
            </span>
            <span className="text-[8.5px] font-semibold uppercase tracking-[0.12em] text-ink-muted/80">
                {label}
            </span>
        </div>
    )
}
