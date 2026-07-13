/**
 * "Your unfinished work" — the caller's open, unpublished drafts.
 *
 * This is the thing a landing page in a VERSIONED tool should say and never did.
 * Draft edits live on a branch, and until now that branch was invisible the
 * moment you navigated away from the view you were editing: every branch endpoint
 * is scoped to one graph, so nothing could answer "what have I left open?".
 *
 * The cost of that silence isn't cosmetic. Drafts don't expire — they sit at the
 * commit they were forked from while main moves on, so an abandoned one quietly
 * becomes tomorrow's merge conflict. Surfacing them, with their age, is the whole
 * point: a draft you haven't touched in a fortnight is a decision waiting to be
 * made (finish it, or bin it).
 *
 * Each card deep-links to /views/{viewId}?branch={draftId}, which the existing
 * useBranchDeepLink already understands — it applies the branch on load, gated by
 * the same permission-filtered branch list as the switcher. So a link here can
 * never open a draft the viewer isn't allowed to see.
 */
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { GitBranch, ArrowRight, Clock } from 'lucide-react'
import { useMyDrafts } from '@/hooks/useMyDrafts'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { viewTypeMeta } from '@/lib/viewUtils'
import type { MyDraftEntry } from '@/services/viewApiService'

/** A draft nobody has touched for this long is worth flagging, not just listing. */
const STALE_AFTER_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

export function isStale(updatedAt: string, now: number = Date.now()): boolean {
    const t = new Date(updatedAt).getTime()
    if (Number.isNaN(t)) return false
    return now - t > STALE_AFTER_DAYS * DAY_MS
}

function DraftCard({ draft, index }: { draft: MyDraftEntry; index: number }) {
    const meta = viewTypeMeta(draft.viewType)
    const stale = isStale(draft.updatedAt)

    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(index, 6) * 0.04, duration: 0.2 }}
        >
            <Link
                to={`/views/${draft.viewId}?branch=${draft.draftId}`}
                className={cn(
                    'group relative flex flex-col h-full rounded-2xl border p-4',
                    'glass-panel border-glass-border hover:-translate-y-0.5 hover:shadow-lg',
                    'transition-all duration-200',
                    meta.hoverBorder,
                )}
            >
                <div className="flex items-start gap-3 mb-3">
                    <span className={cn(
                        'w-9 h-9 rounded-xl border flex items-center justify-center shrink-0',
                        meta.iconBg,
                    )}>
                        <GitBranch className="w-4 h-4" />
                    </span>

                    <span className="min-w-0 flex-1">
                        {/* The VIEW is the label — drafts are usually unnamed, and
                            "Untitled draft" tells you nothing about what's in it. */}
                        <span className="block text-sm font-bold text-ink truncate group-hover:text-accent-lineage transition-colors">
                            {draft.viewName}
                        </span>
                        <span className="block text-[11px] text-ink-muted truncate mt-0.5">
                            {draft.name ?? 'Unnamed draft'}
                        </span>
                    </span>
                </div>

                <div className="mt-auto flex items-center justify-between gap-2">
                    <span className={cn(
                        'inline-flex items-center gap-1.5 text-[11px] font-medium',
                        stale ? 'text-amber-600 dark:text-amber-400' : 'text-ink-muted',
                    )}>
                        <Clock className="w-3 h-3" />
                        {stale ? `Untouched ${timeAgo(draft.updatedAt)}` : `Edited ${timeAgo(draft.updatedAt)}`}
                    </span>

                    <span className="inline-flex items-center gap-1 text-[11px] font-bold text-ink-muted group-hover:text-accent-lineage transition-colors">
                        Continue
                        <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
                    </span>
                </div>
            </Link>
        </motion.div>
    )
}

export function DashboardDrafts() {
    const { data, isLoading } = useMyDrafts()

    const drafts = data ?? []

    // Same contract as the activity feed: no layout while loading, nothing when
    // empty. A section that can still resolve to nothing must not occupy space
    // first — that is what makes a panel flash in and vanish.
    if (isLoading || drafts.length === 0) return null

    const staleCount = drafts.filter(d => isStale(d.updatedAt)).length

    return (
        <section className="px-4 md:px-0 mb-14">
            <div className="flex items-center gap-2.5 mb-4">
                <div className="w-9 h-9 rounded-xl border border-glass-border bg-black/5 dark:bg-white/5 flex items-center justify-center">
                    <GitBranch className="w-4 h-4 text-ink-muted" />
                </div>
                <div className="flex items-baseline gap-2 flex-1 min-w-0">
                    <h2 className="text-ink text-sm font-bold">Your unfinished work</h2>
                    <span className="text-ink-muted text-xs hidden sm:inline">
                        Drafts only you can see, not published yet
                    </span>
                </div>

                {staleCount > 0 && (
                    <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1
                                     bg-amber-500/10 text-amber-600 dark:text-amber-400
                                     text-[11px] font-bold">
                        {staleCount} sitting over a week
                    </span>
                )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {drafts.map((d, i) => (
                    <DraftCard key={d.draftId} draft={d} index={i} />
                ))}
            </div>
        </section>
    )
}
