/**
 * A view, as a tile to open it: its icon and colour by type, its name, what it is
 * built on, and one quiet line of context (when it changed, how much it is used).
 * The Overview's shelves are for getting back to work, so a tile is one link,
 * not a card full of controls — the Views tab has those.
 */
import type { ComponentType } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, Star } from 'lucide-react'
import { cn } from '@/lib/utils'
import { viewTypeColor, viewTypeIconComponent, viewTypeLabel } from '@/lib/viewUtils'

export interface ViewTileData {
    id: string
    name: string
    viewType?: string | null
    dataSourceName?: string | null
    favourite?: boolean
}

/** The type's glyph, handed in as a prop so it is never a component made during render. */
function Glyph({ icon: Icon, className }: { icon: ComponentType<{ className?: string }>; className?: string }) {
    return <Icon className={className} aria-hidden />
}

export function ViewTile({ view, meta }: { view: ViewTileData; meta?: string }) {
    return (
        <Link
            to={`/views/${view.id}`}
            className={cn(
                'group relative flex items-start gap-3 rounded-2xl border border-glass-border bg-canvas-elevated p-3.5',
                'transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_10px_30px_-12px_rgba(79,70,229,0.35)] hover:border-accent-lineage/30',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
            )}
        >
            <span className={cn('w-9 h-9 rounded-xl border flex items-center justify-center shrink-0', viewTypeColor(view.viewType ?? 'graph'))}>
                <Glyph icon={viewTypeIconComponent(view.viewType)} className="w-4 h-4" />
            </span>
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-semibold text-ink group-hover:text-accent-lineage">{view.name}</span>
                    {view.favourite && <Star className="w-3 h-3 shrink-0 fill-amber-400 text-amber-400" aria-label="In your favourites" />}
                </span>
                <span className="block truncate text-[11px] text-ink-muted">
                    {viewTypeLabel(view.viewType)}{view.dataSourceName ? ` · ${view.dataSourceName}` : ''}
                </span>
                {meta && <span className="mt-1 block truncate text-[11px] text-ink-secondary">{meta}</span>}
            </span>
            <ArrowUpRight className="w-4 h-4 shrink-0 text-ink-muted opacity-0 -translate-x-1 transition-all duration-200 group-hover:opacity-100 group-hover:translate-x-0 group-hover:text-accent-lineage" aria-hidden />
        </Link>
    )
}
