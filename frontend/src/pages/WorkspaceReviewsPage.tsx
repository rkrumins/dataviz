/**
 * WorkspaceReviewsPage — the review inbox: every merge request / pull request across the
 * workspace's data sources in one place. Fans out one DataSourceReviewFeed per data source
 * (the backend lists PRs per graph), aggregates + sorts, and opens the PrDetailDrawer.
 * Deep-linkable via ?pr=<prId> (e.g. straight from the commit dialog after opening an MR).
 */
import { useState, useMemo, useCallback, useEffect } from 'react'
import { useParams, useSearchParams, Link } from 'react-router-dom'
import { GitPullRequestArrow, Inbox, Loader2, ArrowLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWorkspacesStore } from '@/store/workspaces'
import { useAuthStore } from '@/store/auth'
import { DataSourceReviewFeed, type ReviewItem } from '@/features/reviews/components/DataSourceReviewFeed'
import { PrListRow } from '@/features/reviews/components/PrListRow'
import { PrDetailDrawer } from '@/features/reviews/components/PrDetailDrawer'

const OPEN_STATUSES = new Set(['open', 'mergeable', 'approved', 'conflicts'])
type FilterKey = 'open' | 'mine' | 'all'

export function WorkspaceReviewsPage() {
  const { wsId } = useParams<{ wsId: string }>()
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const loadWorkspaces = useWorkspacesStore((s) => s.loadWorkspaces)
  const workspace = workspaces.find((w) => w.id === wsId)
  useEffect(() => {
    if (!workspace) loadWorkspaces()
  }, [workspace, loadWorkspaces])
  const dataSources = workspace?.dataSources ?? []
  const user = useAuthStore((s) => s.user)

  const [feeds, setFeeds] = useState<Record<string, ReviewItem[]>>({})
  const onLoaded = useCallback((dsId: string, items: ReviewItem[]) => {
    setFeeds((prev) => ({ ...prev, [dsId]: items }))
  }, [])

  const [filter, setFilter] = useState<FilterKey>('open')
  const [searchParams, setSearchParams] = useSearchParams()
  const openPrId = searchParams.get('pr')
  const setOpenPrId = (id: string | null) => {
    const next = new URLSearchParams(searchParams)
    if (id) next.set('pr', id)
    else next.delete('pr')
    setSearchParams(next, { replace: true })
  }

  const all = useMemo(
    () => Object.values(feeds).flat().sort((a, b) => b.pr.createdAt.localeCompare(a.pr.createdAt)),
    [feeds],
  )
  const filtered = useMemo(
    () =>
      all.filter(({ pr }) => {
        if (filter === 'open') return OPEN_STATUSES.has(pr.status)
        if (filter === 'mine') return (pr.reviewers ?? []).includes(user?.id ?? '') || pr.actor === user?.id
        return true
      }),
    [all, filter, user],
  )

  const loading = Object.keys(feeds).length < dataSources.length
  const counts = useMemo(
    () => ({
      open: all.filter(({ pr }) => OPEN_STATUSES.has(pr.status)).length,
      mine: all.filter(({ pr }) => (pr.reviewers ?? []).includes(user?.id ?? '') || pr.actor === user?.id).length,
      all: all.length,
    }),
    [all, user],
  )

  const TABS: Array<{ key: FilterKey; label: string }> = [
    { key: 'open', label: 'Open' },
    { key: 'mine', label: 'My reviews' },
    { key: 'all', label: 'All' },
  ]

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      {/* Headless fan-out — one per data source */}
      {dataSources.map((ds) => (
        <DataSourceReviewFeed
          key={ds.id}
          wsId={wsId!}
          dataSourceId={ds.id}
          sourceLabel={ds.label ?? 'Data source'}
          onLoaded={onLoaded}
        />
      ))}

      {/* Header */}
      <div className="mb-6">
        <Link to={`/workspaces/${wsId}`} className="inline-flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink mb-3">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to workspace
        </Link>
        <div className="flex items-center gap-2.5">
          <span className="flex items-center justify-center w-9 h-9 rounded-xl bg-accent-lineage/10 border border-accent-lineage/20">
            <GitPullRequestArrow className="w-5 h-5 text-accent-lineage" />
          </span>
          <div>
            <h1 className="text-xl font-bold text-ink leading-tight">Reviews</h1>
            <p className="text-sm text-ink-muted">Merge requests across {workspace?.name ?? 'this workspace'}</p>
          </div>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1 mb-4 border-b border-glass-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setFilter(t.key)}
            className={cn(
              'relative px-3 py-2 text-sm font-medium transition-colors',
              filter === t.key ? 'text-ink' : 'text-ink-muted hover:text-ink',
            )}
          >
            {t.label}
            <span className="ml-1.5 text-[11px] text-ink-muted tabular-nums">{counts[t.key]}</span>
            {filter === t.key && <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-accent-lineage rounded-full" />}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="space-y-1.5">
        {filtered.map(({ pr, sourceLabel }) => (
          <PrListRow key={pr.prId} pr={pr} sourceLabel={sourceLabel} onOpen={() => setOpenPrId(pr.prId)} />
        ))}

        {loading && filtered.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-ink-muted py-12 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading reviews…
          </div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="text-center py-16">
            <Inbox className="w-8 h-8 text-ink-muted/40 mx-auto mb-3" />
            <p className="text-sm font-medium text-ink">No {filter === 'all' ? '' : filter === 'mine' ? 'reviews for you' : 'open'} requests</p>
            <p className="text-xs text-ink-muted mt-1">Open a merge request from a draft to start a review.</p>
          </div>
        )}
      </div>

      {openPrId && wsId && <PrDetailDrawer wsId={wsId} prId={openPrId} onClose={() => setOpenPrId(null)} />}
    </div>
  )
}
