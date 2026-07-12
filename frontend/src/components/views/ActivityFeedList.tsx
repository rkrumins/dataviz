/**
 * ActivityFeedList — the shared presentation for a compact activity feed.
 *
 * SINGLE source of the action→icon/tint mapping and the row markup, consumed by
 * both WorkspaceActivityFeed (workspace-scoped) and DashboardActivityFeed
 * (everything the user can see). Purely presentational — each caller brings its
 * own hook — so the two feeds can never drift apart the way the view-type maps
 * did across the Explorer surfaces.
 */
import { Link } from 'react-router-dom'
import {
    Plus, Pencil, Eye, Share2, UserMinus, Heart, HeartOff, Trash2, RotateCcw,
    Database, History,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import type { ViewActivityAction, ViewActivityEntry } from '@/services/viewApiService'

const META: Record<ViewActivityAction, { icon: React.ElementType; tint: string }> = {
    data_changed: { icon: Database, tint: 'bg-blue-500/10 text-blue-500' },
    created: { icon: Plus, tint: 'bg-indigo-500/10 text-indigo-500' },
    updated: { icon: Pencil, tint: 'bg-violet-500/10 text-violet-500' },
    visibility_changed: { icon: Eye, tint: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
    deleted: { icon: Trash2, tint: 'bg-red-500/10 text-red-500' },
    restored: { icon: RotateCcw, tint: 'bg-emerald-500/10 text-emerald-500' },
    shared: { icon: Share2, tint: 'bg-emerald-500/10 text-emerald-500' },
    unshared: { icon: UserMinus, tint: 'bg-slate-500/10 text-slate-500' },
    favourited: { icon: Heart, tint: 'bg-rose-500/10 text-rose-500' },
    unfavourited: { icon: HeartOff, tint: 'bg-slate-500/10 text-slate-500' },
}

export function ActivityFeedList({ entries, isLoading, emptyText, skeletonRows = 4 }: {
    entries: ViewActivityEntry[]
    isLoading?: boolean
    emptyText: string
    skeletonRows?: number
}) {
    if (isLoading) {
        return (
            <div className="space-y-2.5 py-1">
                {Array.from({ length: skeletonRows }).map((_, i) => (
                    <div key={i} className="flex items-center gap-2.5 animate-pulse">
                        <div className="w-6 h-6 rounded-lg bg-black/5 dark:bg-white/10 shrink-0" />
                        <div className="h-3 flex-1 rounded bg-black/5 dark:bg-white/10" />
                    </div>
                ))}
            </div>
        )
    }

    if (entries.length === 0) {
        return (
            <div className="py-8 text-center">
                <History className="w-7 h-7 mx-auto text-ink-muted opacity-30 mb-2" />
                <p className="text-xs text-ink-muted">{emptyText}</p>
            </div>
        )
    }

    return (
        <ul className="divide-y divide-glass-border/50">
            {entries.map(e => {
                const meta = META[e.action] ?? META.updated
                const Icon = meta.icon
                const who = e.actorName ?? (e.actor && e.actor !== 'anonymous' ? 'A teammate' : 'System')
                return (
                    <li key={e.id} className="flex items-center gap-2.5 py-2">
                        <span className={cn('w-6 h-6 rounded-lg flex items-center justify-center shrink-0', meta.tint)}>
                            <Icon className="w-3.5 h-3.5" />
                        </span>
                        <div className="min-w-0 flex-1 text-xs">
                            <span className="text-ink">
                                <span className="font-semibold">{who}</span>{' '}
                                <span className="text-ink-muted">{e.summary ?? e.action.replace(/_/g, ' ')}</span>
                            </span>
                            {e.viewName && (
                                <>
                                    <span className="text-ink-muted"> · </span>
                                    <Link to={`/views/${e.viewId}`} className="text-indigo-500 hover:underline font-medium">
                                        {e.viewName}
                                    </Link>
                                </>
                            )}
                        </div>
                        <span className="text-[10px] text-ink-muted shrink-0" title={new Date(e.createdAt).toLocaleString()}>
                            {timeAgo(e.createdAt)}
                        </span>
                    </li>
                )
            })}
        </ul>
    )
}
