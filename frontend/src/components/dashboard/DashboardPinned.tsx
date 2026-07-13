/**
 * "Your pinned views" — the views the user deliberately starred.
 *
 * The dashboard already answers "what did I touch recently?" (visit history) and
 * "what have I left unfinished?" (drafts). Neither is a statement of INTENT:
 * recents are a side-effect of browsing, and drafts are work in progress. A pin
 * is the one signal the user gives on purpose, so it outranks both as a way back
 * into the thing they actually care about.
 *
 * No backend work: `favouritedOnly` already existed on the views list endpoint
 * and nothing on the dashboard had ever asked for it.
 *
 * Icon and colour come from the SHARED resolver, never a local map — the exact
 * duplication that once had the same view rendering as a purple Network icon in
 * one strip and a rose "Context View" in the grid beside it.
 */
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Star, ArrowRight } from 'lucide-react'
import { usePinnedViews } from '@/hooks/usePinnedViews'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { DynamicIcon, resolveViewIcon, viewTypeMeta, viewTypeLabel } from '@/lib/viewUtils'
import type { View } from '@/services/viewApiService'

/** The freshest thing we can honestly say about a view's data. */
function freshness(view: View): string | null {
    const stamp = view.dataUpdatedAt ?? view.updatedAt
    if (!stamp) return null
    const ago = timeAgo(stamp)
    return ago ? `Updated ${ago}` : null
}

function PinnedCard({ view, index }: { view: View; index: number }) {
    const meta = viewTypeMeta(view.viewType)
    const icon = resolveViewIcon({ icon: view.config?.icon, viewType: view.viewType })
    const updated = freshness(view)

    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(index, 6) * 0.04, duration: 0.2 }}
        >
            <Link
                to={`/views/${view.id}`}
                className={cn(
                    'group relative flex flex-col h-full rounded-2xl border p-4 overflow-hidden',
                    'glass-panel border-glass-border hover:-translate-y-0.5 hover:shadow-lg',
                    'transition-all duration-200',
                    meta.hoverBorder,
                )}
            >
                <div className={cn(
                    'absolute inset-0 bg-gradient-to-br opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none',
                    meta.gradient,
                )} />

                <div className="relative flex items-start gap-3 mb-3">
                    <span className={cn(
                        'w-9 h-9 rounded-xl border flex items-center justify-center shrink-0',
                        meta.iconBg,
                    )}>
                        <DynamicIcon name={icon} className="w-4 h-4" />
                    </span>

                    <span className="min-w-0 flex-1">
                        <span className="block text-sm font-bold text-ink truncate group-hover:text-accent-lineage transition-colors">
                            {view.name}
                        </span>
                        <span className="block text-[11px] text-ink-muted truncate mt-0.5">
                            {view.workspaceName ?? viewTypeLabel(view.viewType)}
                        </span>
                    </span>

                    <Star className="w-3.5 h-3.5 shrink-0 fill-amber-400 text-amber-400" />
                </div>

                <div className="relative mt-auto flex items-center justify-between gap-2">
                    <span className="text-[11px] text-ink-muted truncate">
                        {updated ?? viewTypeLabel(view.viewType)}
                    </span>
                    <ArrowRight className="w-3.5 h-3.5 shrink-0 text-ink-muted opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all" />
                </div>
            </Link>
        </motion.div>
    )
}

export function DashboardPinned() {
    const { data, isLoading } = usePinnedViews()

    const views = data ?? []

    // Same contract as the other data-driven sections: no layout while loading,
    // nothing when empty. A section that can still resolve to nothing must not
    // take up space first — that is what makes a panel flash in and vanish.
    if (isLoading || views.length === 0) return null

    return (
        <section className="px-4 md:px-0 mb-14">
            <div className="flex items-center gap-2.5 mb-4">
                <div className="w-9 h-9 rounded-xl border border-glass-border bg-black/5 dark:bg-white/5 flex items-center justify-center">
                    <Star className="w-4 h-4 text-ink-muted" />
                </div>
                <div className="flex items-baseline gap-2 flex-1 min-w-0">
                    <h2 className="text-ink text-sm font-bold">Your pinned views</h2>
                    <span className="text-ink-muted text-xs hidden sm:inline">
                        The ones you starred
                    </span>
                </div>

                <Link
                    to="/explorer?category=my-favourites"
                    className="group inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted hover:text-ink transition-colors shrink-0"
                >
                    See all
                    <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
                </Link>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {views.map((v, i) => (
                    <PinnedCard key={v.id} view={v} index={i} />
                ))}
            </div>
        </section>
    )
}
