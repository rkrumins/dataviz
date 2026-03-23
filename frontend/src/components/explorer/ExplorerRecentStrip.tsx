/**
 * ExplorerRecentStrip — "Continue where you left off" horizontal scrollable
 * strip showing the user's recently visited views. Follows the Dashboard/Admin
 * glass-panel design language with gradient overlays, themed icon containers,
 * and polished micro-interactions.
 */

import { Link } from 'react-router-dom'
import {
    Clock,
    Network,
    GitBranch,
    Layers,
    Table2,
    LayoutGrid,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { ViewScopeBadge } from '@/components/explorer/ViewScopeBadge'
import { useRecentViews } from '@/hooks/useRecentViews'

// ─── View-type mappings ─────────────────────────────────────────────────────
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
                    const Icon = VIEW_TYPE_ICONS[entry.viewType] ?? Network
                    const typeColor = VIEW_TYPE_COLORS[entry.viewType] ?? FALLBACK_COLOR
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
                            {/* Gradient hover overlay */}
                            <div
                                className={cn(
                                    'absolute inset-0 bg-gradient-to-br opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none',
                                    typeColor.gradient,
                                )}
                            />

                            {/* Content layer */}
                            <div className="relative z-10 flex flex-col gap-3">
                                {/* Icon container */}
                                <div
                                    className={cn(
                                        'w-10 h-10 rounded-xl border flex items-center justify-center shrink-0',
                                        typeColor.icon,
                                    )}
                                >
                                    <Icon className="w-5 h-5" />
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
