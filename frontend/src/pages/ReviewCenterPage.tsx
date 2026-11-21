/**
 * ReviewCenterPage — every review waiting on the reader, at /reviews.
 *
 * The sidebar's Reviews used to open one workspace's inbox: whichever workspace
 * the browser happened to hold active, so a reviewer asked in three workspaces
 * saw one of them and had to guess there were others. Here the reader chooses:
 * **All workspaces** — every review they may see, each row naming where it lives —
 * or one workspace. Each choice shows how many reviews wait on them there. The
 * choice is in the address (`?workspace=`) and remembered for next time.
 *
 * A review's own page stays at /workspaces/:wsId/reviews/:prId; the older
 * /workspaces/:wsId/reviews links land here, scoped to that workspace.
 */
import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { GitPullRequestArrow, Layers } from 'lucide-react'
import { cn } from '@/lib/utils'
import { workspaceColor } from '@/lib/workspaceColor'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { useWorkspacesStore } from '@/store/workspaces'
import { useReviewCenterCounts } from '@/features/versioning/hooks/useVersioning'
import type { ReviewInboxCounts } from '@/services/versioningApiService'
import { WorkspaceReviewsInbox } from '@/features/reviews/components/WorkspaceReviewsInbox'
import { PageContainer } from '@/components/layout/PageContainer'
import { TourLaunchButton } from '@/features/tour/TourLaunchButton'

const ALL = 'all'
const REMEMBER = 'nx-review-center-scope'

function remembered(): string {
    try { return window.localStorage.getItem(REMEMBER) ?? ALL } catch { return ALL }
}

/** What waits on the reader in a scope: reviews asked of them, and theirs sent back. */
const waiting = (c?: ReviewInboxCounts) => (c ? (c.counts.needs_review ?? 0) + (c.counts.sent_back ?? 0) : 0)

export function ReviewCenterPage() {
    const [searchParams, setSearchParams] = useSearchParams()
    const workspaces = useWorkspacesStore((s) => s.workspaces)
    const loadWorkspaces = useWorkspacesStore((s) => s.loadWorkspaces)
    // The picker names workspaces from the store; arriving here first, it may not be loaded yet.
    useEffect(() => { if (workspaces.length === 0) void loadWorkspaces() }, [workspaces.length, loadWorkspaces])
    const counts = useReviewCenterCounts().data
    // The workspaces this reader can review in — as the server counted them, once it has.
    const scopes = counts ? workspaces.filter((w) => w.id in counts.byWorkspace) : workspaces
    const asked = searchParams.get('workspace')
    const fallback = remembered()
    const scope = asked ?? (fallback === ALL || scopes.some((w) => w.id === fallback) ? fallback : ALL)
    const current = scopes.find((w) => w.id === scope)

    useDocumentTitle(current ? `Reviews · ${current.name}` : 'Reviews')

    const choose = (next: string) => {
        try { window.localStorage.setItem(REMEMBER, next) } catch { /* this browser keeps no state */ }
        setSearchParams((prev) => {
            const p = new URLSearchParams(prev)
            p.delete('queue'); p.delete('pr'); p.delete('thread')
            if (next === ALL) p.delete('workspace'); else p.set('workspace', next)
            return p
        }, { replace: true })
    }

    const chip = (id: string, label: string, n: number, dot?: string) => {
        const on = scope === id
        return (
            <button
                key={id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => choose(id)}
                className={cn(
                    'shrink-0 inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-all',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                    on ? 'border-accent-lineage/40 bg-accent-lineage/10 text-accent-lineage shadow-sm'
                        : 'border-black/[0.08] dark:border-white/10 bg-white/80 dark:bg-white/[0.04] text-ink-secondary shadow-sm hover:text-ink hover:border-accent-lineage/30',
                )}
            >
                {dot ? <span className={cn('w-2 h-2 rounded-full', dot)} aria-hidden /> : <Layers className="w-3.5 h-3.5" aria-hidden />}
                {label}
                {n > 0 && (
                    <span className="rounded-full bg-rose-500 px-1.5 text-[10px] font-bold leading-4 text-white">
                        {n}<span className="sr-only"> waiting on you</span>
                    </span>
                )}
            </button>
        )
    }

    return (
        <div className="absolute inset-0 overflow-y-auto bg-canvas">
            <PageContainer className="py-8">
                <header className="relative mb-6 overflow-hidden rounded-3xl border border-glass-border bg-canvas-elevated p-6 sm:p-7">
                    <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-teal-500/[0.07] via-transparent to-indigo-500/[0.05]" />
                    <div className="relative flex items-start gap-4">
                        <span className="flex items-center justify-center w-12 h-12 rounded-2xl bg-gradient-to-br from-teal-500 to-emerald-600 text-white shadow-lg shadow-teal-500/20 shrink-0">
                            <GitPullRequestArrow className="w-6 h-6" />
                        </span>
                        <div className="min-w-0 flex-1">
                            <h1 className="font-display text-2xl font-bold text-ink leading-tight">Review Center</h1>
                            <p className="text-sm text-ink-muted mt-0.5">
                                {current
                                    ? <>Changes proposed in <span className="font-semibold text-ink">{current.name}</span>, waiting to be reviewed and merged.</>
                                    : 'Changes proposed across your workspaces, waiting to be reviewed and merged.'}
                            </p>
                        </div>
                        <TourLaunchButton tourId="reviews" className="ml-auto" />
                    </div>

                    {/* Where to look: all of them, or one. */}
                    <div role="radiogroup" aria-label="Which workspaces" className="relative mt-5 flex gap-2 overflow-x-auto pb-1 custom-scrollbar" data-tour="reviews-scope">
                        {chip(ALL, 'All workspaces', counts ? waiting(counts) : 0)}
                        {scopes.map((w) => chip(w.id, w.name, waiting(counts?.byWorkspace[w.id]), workspaceColor(w.id).accent))}
                    </div>
                </header>

                <WorkspaceReviewsInbox key={scope} wsId={scope === ALL ? null : scope} />
            </PageContainer>
        </div>
    )
}
