/**
 * ExplorerHero — Premium featured/pinned views section rendered as a dramatic
 * hero strip at the top of the Explorer page. Follows the Dashboard/Admin
 * glass-panel design language with gradient overlays, themed icon containers,
 * and polished micro-interactions.
 */

import {
    Star,
    Tag,
    Sparkles,
    Network,
    GitBranch,
    Layers,
    Table2,
    LayoutGrid,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { workspaceColor } from '@/lib/workspaceColor'
import type { View } from '@/services/viewApiService'

// ─── Interface ──────────────────────────────────────────────────────────────
interface ExplorerHeroProps {
    views: View[] // pre-filtered to isPinned
    onToggleFavourite: (viewId: string) => void
    onPreview?: (view: View) => void
}

// ─── View-type mappings ─────────────────────────────────────────────────────
const VIEW_TYPE_LABELS: Record<string, string> = {
    graph: 'Graph',
    hierarchy: 'Hierarchy',
    lineage: 'Lineage',
    table: 'Table',
    context: 'Context',
}

const VIEW_TYPE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
    graph: Network,
    hierarchy: Layers,
    lineage: GitBranch,
    table: Table2,
    context: LayoutGrid,
}

const VIEW_TYPE_COLORS: Record<string, { icon: string; gradient: string }> = {
    graph: {
        icon: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20',
        gradient: 'from-indigo-500/20 to-indigo-500/0',
    },
    hierarchy: {
        icon: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
        gradient: 'from-amber-500/20 to-amber-500/0',
    },
    lineage: {
        icon: 'bg-violet-500/10 text-violet-500 border-violet-500/20',
        gradient: 'from-violet-500/20 to-violet-500/0',
    },
    table: {
        icon: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
        gradient: 'from-emerald-500/20 to-emerald-500/0',
    },
    context: {
        icon: 'bg-cyan-500/10 text-cyan-500 border-cyan-500/20',
        gradient: 'from-cyan-500/20 to-cyan-500/0',
    },
}

const FALLBACK_COLOR = {
    icon: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20',
    gradient: 'from-indigo-500/20 to-indigo-500/0',
}

// ─── Component ──────────────────────────────────────────────────────────────
export function ExplorerHero({ views, onToggleFavourite, onPreview }: ExplorerHeroProps) {
    if (views.length === 0) return null

    const featured = views.slice(0, 3)

    return (
        <section className="relative rounded-2xl p-6 mb-6 bg-gradient-to-br from-accent-lineage/8 via-violet-500/5 to-transparent overflow-hidden">
            {/* Section title — styled like DashboardHero subtitle pill */}
            <div className="flex items-center gap-3 mb-5">
                <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full glass-panel border border-accent-lineage/30 text-accent-lineage text-sm font-semibold">
                    <Sparkles className="w-3.5 h-3.5" />
                    Featured Views
                </div>
            </div>

            {/* Grid: 1 col mobile, 2 md, 3 lg */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {featured.map((view) => {
                    const wsColor = workspaceColor(view.workspaceId)
                    const typeColor = VIEW_TYPE_COLORS[view.viewType] ?? FALLBACK_COLOR
                    const TypeIcon = VIEW_TYPE_ICONS[view.viewType] ?? Network

                    return (
                        <div
                            key={view.id}
                            className={cn(
                                'glass-panel rounded-2xl border border-glass-border p-5 overflow-hidden group cursor-pointer',
                                'hover:-translate-y-1 hover:shadow-xl',
                                'transition-[transform,box-shadow,border-color] duration-200 ease-out',
                                'relative flex flex-col min-h-[200px]',
                            )}
                            onClick={() => onPreview?.(view)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={e => { if (e.key === 'Enter') onPreview?.(view) }}
                        >
                            {/* Gradient hover overlay */}
                            <div
                                className={cn(
                                    'absolute inset-0 bg-gradient-to-br opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none',
                                    typeColor.gradient,
                                )}
                            />

                            {/* Content layer */}
                            <div className="relative z-10 flex flex-col flex-1">
                                {/* Top row: icon container + workspace pill + view type badge */}
                                <div className="flex items-center gap-2.5 mb-4">
                                    <div
                                        className={cn(
                                            'w-9 h-9 rounded-xl border flex items-center justify-center shrink-0',
                                            typeColor.icon,
                                        )}
                                    >
                                        <TypeIcon className="w-4.5 h-4.5" />
                                    </div>

                                    <div className="flex items-center gap-2 min-w-0">
                                        {view.workspaceName && (
                                            <span
                                                className={cn(
                                                    'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border truncate',
                                                    wsColor.bg,
                                                    wsColor.text,
                                                    wsColor.border,
                                                )}
                                            >
                                                {view.workspaceName}
                                            </span>
                                        )}
                                        <span className="inline-flex items-center rounded-full bg-black/5 dark:bg-white/5 border border-glass-border px-2 py-0.5 text-[11px] font-medium text-ink-muted">
                                            {VIEW_TYPE_LABELS[view.viewType] ?? view.viewType}
                                        </span>
                                    </div>
                                </div>

                                {/* Name */}
                                <h3 className="text-ink font-bold text-base mb-1.5 group-hover:text-accent-lineage transition-colors duration-300">
                                    {view.name}
                                </h3>

                                {/* Description -- 3-line clamp */}
                                {view.description && (
                                    <p className="text-ink-muted text-sm leading-relaxed line-clamp-3 mb-auto">
                                        {view.description}
                                    </p>
                                )}

                                {/* Spacer when no description */}
                                {!view.description && <div className="flex-1" />}

                                {/* Bottom row: tags + favourite button */}
                                <div className="flex items-center justify-between mt-4 pt-3 border-t border-glass-border">
                                    <div className="flex items-center gap-1.5 overflow-hidden">
                                        {view.tags?.slice(0, 3).map((tag) => (
                                            <span
                                                key={tag}
                                                className="inline-flex items-center gap-1 rounded-full bg-black/5 dark:bg-white/5 border border-glass-border px-2 py-0.5 text-[11px] font-medium text-ink-muted truncate max-w-[100px]"
                                            >
                                                <Tag className="h-3 w-3 shrink-0" />
                                                {tag}
                                            </span>
                                        ))}
                                    </div>

                                    <button
                                        onClick={(e) => {
                                            e.preventDefault()
                                            e.stopPropagation()
                                            onToggleFavourite(view.id)
                                        }}
                                        className={cn(
                                            'inline-flex items-center gap-1.5 text-xs font-medium rounded-lg px-2 py-1 transition-all duration-200',
                                            view.isFavourited
                                                ? 'text-amber-500 bg-amber-500/10'
                                                : 'text-ink-muted hover:text-amber-500 hover:bg-amber-500/10',
                                        )}
                                    >
                                        <Star
                                            className="h-3.5 w-3.5"
                                            fill={view.isFavourited ? 'currentColor' : 'none'}
                                        />
                                        {view.favouriteCount > 0 && (
                                            <span>{view.favouriteCount}</span>
                                        )}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )
                })}
            </div>
        </section>
    )
}
