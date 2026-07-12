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
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { View } from '@/services/viewApiService'
import { ViewScopeBadge } from '@/components/explorer/ViewScopeBadge'
import { DynamicIcon, resolveViewIcon, viewTypeMeta } from '@/lib/viewUtils'

// ─── Interface ──────────────────────────────────────────────────────────────
interface ExplorerHeroProps {
    views: View[] // pre-filtered to isPinned
    onToggleFavourite: (viewId: string) => void
    onPreview?: (view: View) => void
}

// View type icon + label + colour come from the SHARED resolver in
// lib/viewUtils. The local maps here were keyed on 'lineage'/'context' —
// types that don't exist (they're 'layered-lineage'/'reference') — so every
// Context View fell through to a Network icon, and 'hierarchy' was mapped to
// the wrong icon+colour entirely. Same drift the recents strip had.

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
                    const meta = viewTypeMeta(view.viewType)
                    const iconName = resolveViewIcon({ icon: view.config?.icon, viewType: view.viewType })

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
                                    'absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none',
                                    meta.gradient,
                                )}
                            />

                            {/* Content layer */}
                            <div className="relative z-10 flex flex-col flex-1">
                                {/* Top row: icon container + workspace pill + view type badge */}
                                <div className="flex items-center gap-2.5 mb-4">
                                    <div
                                        className={cn(
                                            'w-9 h-9 rounded-xl border flex items-center justify-center shrink-0',
                                            meta.iconBg,
                                        )}
                                    >
                                        <DynamicIcon name={iconName} className="w-[18px] h-[18px]" />
                                    </div>

                                    <div className="flex items-center gap-2 min-w-0 flex-wrap">
                                        <ViewScopeBadge
                                            workspaceId={view.workspaceId}
                                            workspaceName={view.workspaceName}
                                            dataSourceId={view.dataSourceId}
                                            dataSourceName={view.dataSourceName}
                                            size="md"
                                        />
                                        <span className="inline-flex items-center rounded-full bg-black/5 dark:bg-white/5 border border-glass-border px-2 py-0.5 text-[11px] font-medium text-ink-muted">
                                            {meta.label}
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
