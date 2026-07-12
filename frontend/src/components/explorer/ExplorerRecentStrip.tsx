/**
 * ExplorerRecentStrip — "Continue where you left off" horizontal scrollable
 * strip showing the user's recently visited views. Follows the Dashboard/Admin
 * glass-panel design language with gradient overlays, themed icon containers,
 * and polished micro-interactions.
 */

import { Link } from 'react-router-dom'
import { Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { ViewScopeBadge } from '@/components/explorer/ViewScopeBadge'
import { useRecentViews } from '@/hooks/useRecentViews'
// Icon + colour come from the SHARED resolver — never a local map. This strip
// used to keep its own type→icon/colour tables keyed on `lineage`/`context`,
// which don't exist (the real types are `layered-lineage`/`reference`), so every
// Context View fell through to a purple Network icon while the grid rendered the
// same view as a rose "Context View". It also ignored the user's config.icon.
import { DynamicIcon, resolveViewIcon, viewTypeMeta } from '@/lib/viewUtils'

// ─── Component ──────────────────────────────────────────────────────────────
export function ExplorerRecentStrip() {
    const { recent: recentViews } = useRecentViews()

    if (recentViews.length === 0) return null

    return (
        <section className="mb-6">
            {/* Section header: Icon + bold title + muted subtitle */}
            <div className="flex items-center gap-2.5 mb-4">
                <div className="w-9 h-9 rounded-xl border border-glass-border bg-black/5 dark:bg-white/5 flex items-center justify-center">
                    <Clock className="h-4.5 w-4.5 text-ink-muted" />
                </div>
                <div className="flex items-baseline gap-2">
                    <h2 className="text-ink text-sm font-bold">
                        Continue where you left off
                    </h2>
                    <span className="text-ink-muted text-xs">
                        Your recent views
                    </span>
                </div>
            </div>

            {/* Horizontal scrollable strip */}
            <div
                className={cn(
                    'flex gap-3 overflow-x-auto pb-2',
                    'scrollbar-none [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]',
                )}
            >
                {recentViews.map((entry) => {
                    // Identical resolution to ExplorerViewCard / ExplorerListRow.
                    const iconName = resolveViewIcon({ icon: entry.icon, viewType: entry.viewType })
                    const meta = viewTypeMeta(entry.viewType)
                    return (
                        <Link
                            key={entry.viewId}
                            to={`/views/${entry.viewId}`}
                            className={cn(
                                'glass-panel rounded-2xl border border-glass-border p-4 overflow-hidden group',
                                'hover:-translate-y-1 hover:shadow-xl transition-all duration-300',
                                'relative flex-shrink-0 flex flex-col gap-3',
                                'min-w-[260px] max-w-[320px]',
                            )}
                        >
                            {/* Gradient hover overlay — shared type tint */}
                            <div
                                className={cn(
                                    'absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none',
                                    meta.gradient,
                                )}
                            />

                            {/* Content layer */}
                            <div className="relative z-10 flex flex-col gap-3">
                                {/* Icon container + type label — same chip and label
                                    the grid card uses, so a view looks identical here. */}
                                <div className="flex items-center gap-2.5">
                                    <div
                                        className={cn(
                                            'w-10 h-10 rounded-xl border flex items-center justify-center shrink-0',
                                            meta.iconBg,
                                        )}
                                    >
                                        <DynamicIcon name={iconName} className="w-5 h-5" />
                                    </div>
                                    <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                                        {meta.label}
                                    </span>
                                </div>

                                {/* View name */}
                                <h3 className="text-ink font-bold text-sm truncate group-hover:text-accent-lineage transition-colors duration-300">
                                    {entry.viewName}
                                </h3>

                                {/* Workspace + data source pills + timestamp */}
                                <div className="flex items-center gap-2 flex-wrap">
                                    {entry.workspaceId && (
                                        <ViewScopeBadge
                                            workspaceId={entry.workspaceId}
                                            workspaceName={entry.workspaceName}
                                            dataSourceId={entry.dataSourceId}
                                            dataSourceName={entry.dataSourceName}
                                        />
                                    )}
                                    <span className="text-ink-muted text-[11px]">
                                        Visited {timeAgo(entry.visitedAt)}
                                    </span>
                                </div>
                            </div>
                        </Link>
                    )
                })}
            </div>
        </section>
    )
}
