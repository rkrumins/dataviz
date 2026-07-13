/**
 * "Your work" — one component, one grid, one card per view.
 *
 * Replaces three stacked sections (unfinished drafts / pinned views / recently
 * visited) that all answered the same question — "which view do I open?" — and
 * that overlapped so heavily the same view was drawn three times down the page.
 * The merge is in `workItems.ts`; this is its presentation.
 *
 * Filters narrow to each subset, so nothing that used to have a section is now
 * unreachable — it's a click, not a scroll. The ~600px it gives back is what
 * lifts the activity feed to second on the page, without squeezing it: a first
 * attempt put activity in a narrow sticky rail beside this, and the timeline plus
 * its summary stacked into a column that ran taller than the work it sat next to.
 * Merging the repetition is what buys the room — cramming was never needed.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Briefcase, GitBranch, Star, Clock, ArrowRight, AlertTriangle } from 'lucide-react'
import { useMyDrafts } from '@/hooks/useMyDrafts'
import { usePinnedViews } from '@/hooks/usePinnedViews'
import { useRecentViews } from '@/hooks/useRecentViews'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { DynamicIcon, resolveViewIcon, viewTypeMeta } from '@/lib/viewUtils'
import {
    mergeWorkItems, filterWorkItems, countBadge, isStaleDraft,
    type WorkFilter, type WorkItem,
} from './workItems'

const FILTERS: { id: WorkFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'draft', label: 'Unfinished' },
    { id: 'pinned', label: 'Pinned' },
    { id: 'recent', label: 'Recent' },
]

function Badges({ item }: { item: WorkItem }) {
    return (
        <span className="flex items-center gap-1 shrink-0">
            {item.badges.includes('draft') && (
                <span
                    title="You have an unpublished draft on this view"
                    className="inline-flex items-center justify-center w-5 h-5 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400"
                >
                    <GitBranch className="w-3 h-3" />
                </span>
            )}
            {item.badges.includes('pinned') && (
                <span title="Pinned" className="inline-flex items-center justify-center w-5 h-5">
                    <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                </span>
            )}
            {item.badges.includes('recent') && !item.badges.includes('draft') && (
                <span
                    title="You opened this recently"
                    className="inline-flex items-center justify-center w-5 h-5 text-ink-muted"
                >
                    <Clock className="w-3 h-3" />
                </span>
            )}
        </span>
    )
}

function WorkCard({ item, index }: { item: WorkItem; index: number }) {
    const meta = viewTypeMeta(item.viewType)
    const icon = resolveViewIcon({ icon: item.icon, viewType: item.viewType })
    const stale = isStaleDraft(item)

    // A draft goes straight back INTO the draft, not to the published view — that
    // is the whole point of surfacing it. useBranchDeepLink applies ?branch= on
    // load, gated by the permission-filtered branch list.
    const to = item.draftId
        ? `/views/${item.viewId}?branch=${item.draftId}`
        : `/views/${item.viewId}`

    return (
        <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(index, 8) * 0.03, duration: 0.18 }}
        >
            <Link
                to={to}
                className={cn(
                    'group relative flex flex-col h-full rounded-2xl border p-3.5 overflow-hidden',
                    'glass-panel border-glass-border hover:-translate-y-0.5 hover:shadow-lg',
                    'transition-all duration-200',
                    meta.hoverBorder,
                )}
            >
                <div className={cn(
                    'absolute inset-0 bg-gradient-to-br opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none',
                    meta.gradient,
                )} />

                <div className="relative flex items-start gap-2.5 mb-3">
                    <span className={cn(
                        'w-8 h-8 rounded-lg border flex items-center justify-center shrink-0',
                        meta.iconBg,
                    )}>
                        <DynamicIcon name={icon} className="w-3.5 h-3.5" />
                    </span>

                    <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-bold text-ink truncate group-hover:text-accent-lineage transition-colors">
                            {item.name}
                        </span>
                        {item.subtitle && (
                            <span className="block text-[11px] text-ink-muted truncate mt-0.5">
                                {item.subtitle}
                            </span>
                        )}
                    </span>

                    <Badges item={item} />
                </div>

                <div className="relative mt-auto flex items-center justify-between gap-2">
                    <span className={cn(
                        'inline-flex items-center gap-1 text-[11px] font-medium truncate',
                        stale ? 'text-amber-600 dark:text-amber-400' : 'text-ink-muted',
                    )}>
                        {stale && <AlertTriangle className="w-3 h-3 shrink-0" />}
                        {stale
                            ? `Untouched ${timeAgo(item.timestamp)}`
                            : `${item.timeVerb} ${timeAgo(item.timestamp)}`}
                    </span>

                    <ArrowRight className="w-3.5 h-3.5 shrink-0 text-ink-muted opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all" />
                </div>
            </Link>
        </motion.div>
    )
}

export function DashboardWorkHub() {
    const { data: drafts, isLoading: loadingDrafts } = useMyDrafts()
    const { data: pinned, isLoading: loadingPinned } = usePinnedViews()
    const { recent } = useRecentViews()

    const [filter, setFilter] = useState<WorkFilter>('all')

    const items = useMemo(
        () => mergeWorkItems(drafts ?? [], pinned ?? [], recent ?? []),
        [drafts, pinned, recent],
    )

    const visible = useMemo(() => filterWorkItems(items, filter), [items, filter])
    const staleDrafts = useMemo(() => items.filter(i => isStaleDraft(i)).length, [items])

    const counts: Record<WorkFilter, number> = {
        all: items.length,
        draft: countBadge(items, 'draft'),
        pinned: countBadge(items, 'pinned'),
        recent: countBadge(items, 'recent'),
    }

    // No layout while loading, nothing when empty — the same contract as every
    // other data-driven section here. A panel that can still resolve to nothing
    // must not take up space first.
    if (loadingDrafts || loadingPinned) return null
    if (items.length === 0) return null

    return (
        <section className="px-4 md:px-0 mb-14">
            <div className="flex items-center gap-2.5 mb-4 flex-wrap">
                <div className="w-9 h-9 rounded-xl border border-glass-border bg-black/5 dark:bg-white/5 flex items-center justify-center shrink-0">
                    <Briefcase className="w-4 h-4 text-ink-muted" />
                </div>
                <div className="flex items-baseline gap-2 min-w-0">
                    <h2 className="text-ink text-sm font-bold whitespace-nowrap">Your work</h2>
                    {staleDrafts > 0 && (
                        <span className="text-[11px] font-semibold text-amber-600 dark:text-amber-400 truncate">
                            {staleDrafts} draft{staleDrafts === 1 ? '' : 's'} sitting over a week
                        </span>
                    )}
                </div>

                <div className="ml-auto flex items-center gap-0.5 p-0.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border">
                    {FILTERS.map(f => {
                        const active = f.id === filter
                        const count = counts[f.id]
                        return (
                            <button
                                key={f.id}
                                type="button"
                                onClick={() => setFilter(f.id)}
                                disabled={count === 0}
                                className={cn(
                                    'relative px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors',
                                    'disabled:opacity-40 disabled:cursor-not-allowed',
                                    active ? 'text-ink' : 'text-ink-muted hover:text-ink',
                                )}
                            >
                                {active && (
                                    <motion.span
                                        layoutId="work-hub-pill"
                                        className="absolute inset-0 rounded-lg bg-canvas-elevated shadow-sm border border-glass-border"
                                        transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                                    />
                                )}
                                <span className="relative flex items-center gap-1.5">
                                    {f.label}
                                    <span className="tabular-nums opacity-60">{count}</span>
                                </span>
                            </button>
                        )
                    })}
                </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {visible.map((item, i) => (
                    <WorkCard key={item.viewId} item={item} index={i} />
                ))}
            </div>
        </section>
    )
}
