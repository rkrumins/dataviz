/**
 * TemplateStatsBar — the library at a glance, in the summary banner Explorer
 * and Workspaces open with: a gradient accent strip over tiles that pair a big
 * number with a label. A tile shows what it counts when clicked; the last one
 * says when the library last changed.
 *
 * Everything is counted from the library the page already holds, so the bar
 * costs no request of its own.
 */
import { Clock, Eye, Heart, Inbox, LayoutTemplate, Sparkles } from 'lucide-react'
import { StatTile } from '@/components/explorer/ExplorerStatsBar'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import type { LayoutTemplate as Template } from '@/services/layoutTemplateService'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

function summarize(templates: readonly Template[]) {
    const weekAgo = Date.now() - WEEK_MS
    let views = 0
    let updatedThisWeek = 0
    let favourites = 0
    let latest: string | null = null
    for (const t of templates) {
        views += t.usageCount
        if (Date.parse(t.updatedAt) >= weekAgo) updatedThisWeek++
        if (t.isFavourite) favourites++
        if (!latest || t.updatedAt > latest) latest = t.updatedAt
    }
    return { views, updatedThisWeek, favourites, latest }
}

interface TemplateStatsBarProps {
    templates: readonly Template[]
    isLoading?: boolean
    /** Requests waiting on a template manager — null for everyone else. */
    pendingRequests: number | null
    requestsLoading?: boolean
    onShowAll: () => void
    onShowMostUsed: () => void
    onShowRecentlyUpdated: () => void
    onShowFavourites: () => void
    onShowRequests: () => void
}

export function TemplateStatsBar({
    templates, isLoading, pendingRequests, requestsLoading,
    onShowAll, onShowMostUsed, onShowRecentlyUpdated, onShowFavourites, onShowRequests,
}: TemplateStatsBarProps) {
    const { views, updatedThisWeek, favourites, latest } = summarize(templates)

    return (
        <div className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden">
            <div className="h-1 w-full bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-500" />

            <div className="p-5">
                <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
                    <StatTile
                        icon={LayoutTemplate}
                        iconClass="bg-indigo-500/10 border-indigo-500/20 text-indigo-500"
                        label="Templates"
                        value={templates.length}
                        loading={isLoading}
                        onClick={onShowAll}
                    />
                    <StatTile
                        icon={Eye}
                        iconClass="bg-cyan-500/10 border-cyan-500/20 text-cyan-500"
                        label="Views Using Them"
                        value={views}
                        loading={isLoading}
                        onClick={onShowMostUsed}
                    />
                    <StatTile
                        icon={Sparkles}
                        iconClass="bg-emerald-500/10 border-emerald-500/20 text-emerald-500"
                        label="Updated This Week"
                        value={updatedThisWeek}
                        loading={isLoading}
                        onClick={onShowRecentlyUpdated}
                    />
                    <StatTile
                        icon={Heart}
                        iconClass="bg-rose-500/10 border-rose-500/20 text-rose-500"
                        label="Your Favorites"
                        value={favourites}
                        loading={isLoading}
                        onClick={onShowFavourites}
                    />
                    {pendingRequests !== null && (
                        <StatTile
                            icon={Inbox}
                            iconClass={cn(
                                pendingRequests > 0
                                    ? 'bg-amber-500/10 border-amber-500/20 text-amber-500'
                                    : 'bg-ink-muted/5 border-glass-border text-ink-muted/60',
                            )}
                            label="Awaiting Your Decision"
                            value={pendingRequests}
                            loading={requestsLoading}
                            onClick={onShowRequests}
                            highlight={pendingRequests > 0}
                        />
                    )}

                    {/* Separator + passive "last updated" indicator. */}
                    <div className="w-px h-10 bg-glass-border hidden lg:block" />

                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center">
                            <Clock className="w-5 h-5 text-sky-500" />
                        </div>
                        <div>
                            <div className="text-lg font-bold text-ink">{!isLoading && latest ? timeAgo(latest) : '—'}</div>
                            <div className="text-[10px] text-ink-muted uppercase tracking-wider">Last Updated</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
