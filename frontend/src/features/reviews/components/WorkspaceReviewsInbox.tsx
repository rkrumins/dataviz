/**
 * WorkspaceReviewsInbox — the Review Center core: a workspace's reviews in the queues the reader
 * works by, as the server sorts them (`useReviewInbox`): what needs their review, their own requests
 * (waiting on reviewers, sent back, ready to merge), everything open, and what was merged or closed.
 * A queue navigator — a list beside the reviews on a wide screen, a row above them on a narrow one —
 * gives each queue its count and a dot while something in it is unread. Search, the data-source and
 * author filters and the order go to the server; "Load more" reads the next page.
 *
 * `?queue=` names the queue open (else the first with something for the reader); `?pr=` — an older
 * link — opens that review's quick peek. A row opens the review's own page; j / k move between the
 * rows and Enter opens the one focused. Self-contained (only needs `wsId`), reused by the standalone
 * page + the workspace Reviews tab.
 */
import { useState, useEffect, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AlertTriangle, Archive, CheckCheck, ChevronDown, Hourglass, Inbox, RotateCcw, Search, SearchX, Send, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWorkspacesStore } from '@/store/workspaces'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Segmented } from '@/components/ui/Segmented'
import { Skeleton } from '@/components/ui/Skeleton'
import type { ReviewInboxCounts, ReviewInboxQueue } from '@/services/versioningApiService'
import { useReviewInbox, useReviewInboxCounts } from '@/features/versioning/hooks/useVersioning'
import { ownerName } from '@/features/versioning/model/branchVocab'
import { useReviewKeys } from '../page/useReviewKeys'
import { PrListRow } from './PrListRow'
import { PrDetailDrawer } from './PrDetailDrawer'

type Sort = 'activity' | 'created'

const QUEUES: Array<{ key: ReviewInboxQueue; label: string; yours?: boolean }> = [
  { key: 'needs_review', label: 'Needs your review' },
  { key: 'waiting', label: 'Waiting on reviewers', yours: true },
  { key: 'sent_back', label: 'Sent back to you', yours: true },
  { key: 'ready', label: 'Ready to merge', yours: true },
  { key: 'open', label: 'Everything open' },
  { key: 'done', label: 'Merged & closed' },
]
const isQueue = (v: string | null): v is ReviewInboxQueue => QUEUES.some((q) => q.key === v)

/** What a queue with nothing in it says. */
const EMPTY: Record<ReviewInboxQueue, { icon: React.ComponentType<{ className?: string }>; title: string; description: string }> = {
  needs_review: { icon: CheckCheck, title: 'Nothing needs your review', description: 'When someone asks you, or a group of yours, to review their changes, it shows here.' },
  waiting: { icon: Hourglass, title: 'None of yours is waiting', description: 'A review you open waits here until its reviewers have answered.' },
  sent_back: { icon: RotateCcw, title: 'Nothing was sent back to you', description: 'When a reviewer asks for changes to one of yours, it shows here.' },
  ready: { icon: Send, title: 'Nothing of yours is ready to merge', description: 'Yours shows here once it has the approvals it needs and nothing holds it.' },
  open: { icon: Inbox, title: 'No open reviews', description: 'Open a review from a draft to propose its changes.' },
  done: { icon: Archive, title: 'Nothing merged or closed yet', description: 'Reviews show here once they are merged or closed.' },
}

/** The queue to open on: what needs the reader's review, else whichever of their own has something
 *  (what they must act on first), else everything open. */
function defaultQueue(counts: ReviewInboxCounts['counts']): ReviewInboxQueue {
  if (counts.needs_review > 0) return 'needs_review'
  return (['sent_back', 'ready', 'waiting'] as const).find((k) => counts[k] > 0) ?? 'open'
}

// ── Compact filter dropdown (button + popover) ───────────────────────────────
function FilterSelect({
  label, value, options, onChange,
}: {
  label: string
  value: string | null
  options: Array<{ id: string; label: string }>
  onChange: (id: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const current = options.find((o) => o.id === value)
  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[13px] font-medium transition-colors',
          value
            ? 'border-accent-lineage/40 bg-accent-lineage/[0.06] text-ink'
            : 'border-glass-border bg-canvas-elevated/50 text-ink-muted hover:text-ink hover:border-glass-border/80',
        )}
      >
        <span className="text-ink-muted/70">{label}:</span>
        <span className="truncate max-w-[140px]">{current?.label ?? 'All'}</span>
        <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute z-20 mt-1.5 min-w-[200px] max-w-xs max-h-72 overflow-y-auto rounded-xl border border-glass-border bg-canvas-elevated shadow-xl shadow-black/10 py-1">
          <button
            onClick={() => { onChange(null); setOpen(false) }}
            className={cn('w-full text-left px-3 py-2 text-[13px] hover:bg-accent-lineage/[0.06] transition-colors', !value ? 'text-accent-lineage font-medium' : 'text-ink')}
          >All</button>
          {options.map((o) => (
            <button
              key={o.id}
              onClick={() => { onChange(o.id); setOpen(false) }}
              className={cn('w-full text-left px-3 py-2 text-[13px] truncate hover:bg-accent-lineage/[0.06] transition-colors', value === o.id ? 'text-accent-lineage font-medium' : 'text-ink')}
            >{o.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Queue navigator ──────────────────────────────────────────────────────────
function QueueNav({ value, tally, onPick }: {
  value: ReviewInboxQueue | null
  tally: ReviewInboxCounts | undefined
  onPick: (q: ReviewInboxQueue) => void
}) {
  const item = (q: (typeof QUEUES)[number]) => {
    const on = q.key === value
    const unread = tally?.unread[q.key] ?? 0
    return (
      <button
        key={q.key}
        type="button"
        onClick={() => onPick(q.key)}
        aria-current={on ? 'true' : undefined}
        className={cn(
          'shrink-0 lg:w-full flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
          q.yours && 'lg:pl-5',
          on ? 'bg-accent-lineage/10 text-accent-lineage'
            : 'text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06]',
        )}
      >
        <span className="lg:flex-1 text-left">{q.label}</span>
        {unread > 0 && <span role="img" aria-label="Unread" className="w-1.5 h-1.5 rounded-full bg-accent-lineage shrink-0" />}
        {tally && <span className="text-[11px] font-semibold tabular-nums">{tally.counts[q.key].toLocaleString()}</span>}
      </button>
    )
  }
  const [needs, waiting, sentBack, ready, open, done] = QUEUES
  return (
    <nav data-tour="reviews-queues" aria-label="Review queues"
      className="flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible pb-1 lg:pb-0 mb-4 lg:mb-0">
      {item(needs)}
      <p className="hidden lg:block mt-3 mb-0.5 px-3 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted">Your requests</p>
      {item(waiting)}
      {item(sentBack)}
      {item(ready)}
      <span className="hidden lg:block mt-3" aria-hidden />
      {item(open)}
      {item(done)}
    </nav>
  )
}

export function WorkspaceReviewsInbox({ wsId }: { wsId: string }) {
  const navigate = useNavigate()
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const loadWorkspaces = useWorkspacesStore((s) => s.loadWorkspaces)
  const workspace = workspaces.find((w) => w.id === wsId)
  useEffect(() => { if (!workspace) loadWorkspaces() }, [workspace, loadWorkspaces])
  const dataSources = workspace?.dataSources ?? []

  // The queue open, and a review peeked at, are in the address.
  const [searchParams, setSearchParams] = useSearchParams()
  const setParams = (changes: Record<string, string | null>) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev)
    for (const [k, v] of Object.entries(changes)) { if (v == null) next.delete(k); else next.set(k, v) }
    return next
  }, { replace: true })
  const asked = searchParams.get('queue')
  const peekId = searchParams.get('pr')

  // No queue asked for: the first with something for the reader, chosen once, so it doesn't move
  // under them as they work through it.
  const countsQ = useReviewInboxCounts(wsId)
  const [opened, setOpened] = useState<ReviewInboxQueue | null>(null)
  if (!isQueue(asked) && !opened && countsQ.data) setOpened(defaultQueue(countsQ.data.counts))
  const queue = isQueue(asked) ? asked : opened ?? (countsQ.isError ? 'open' : null)

  const [search, setSearch] = useState('')
  const q = useDebouncedValue(search.trim(), 300)
  const [sourceFilter, setSourceFilter] = useState<string | null>(null)
  const [authorFilter, setAuthorFilter] = useState<string | null>(null)
  const [sort, setSort] = useState<Sort>('activity')

  const inbox = useReviewInbox(wsId, {
    queue: queue ?? undefined, q: q || undefined, dataSourceId: sourceFilter, author: authorFilter, sort,
  })
  const pages = inbox.data?.pages
  const items = pages?.flatMap((p) => p.items) ?? []
  const first = pages?.[0]
  // The counts as filtered with the list; before it's read, the workspace's own.
  const tally = first ?? countsQ.data
  const total = first?.total ?? 0

  // Everyone seen raising a review, kept as the list narrows, so another author can be picked.
  const [authors, setAuthors] = useState<Record<string, string>>({})
  const fresh = items.filter((pr) => pr.actor && !(pr.actor in authors))
  if (fresh.length > 0) {
    setAuthors({ ...authors, ...Object.fromEntries(fresh.map((pr) => [pr.actor!, ownerName(pr.actor, pr.userNames)])) })
  }
  const authorOptions = Object.entries(authors).map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label))
  const sourceOptions = dataSources.map((ds) => ({ id: ds.id, label: ds.label ?? 'Data source' }))
  const sourceLabel = (id?: string) => dataSources.find((ds) => ds.id === id)?.label ?? undefined

  const hasFilters = !!(search.trim() || sourceFilter || authorFilter)
  const clearFilters = () => { setSearch(''); setSourceFilter(null); setAuthorFilter(null) }
  const openReview = (prId: string) => navigate(`/workspaces/${wsId}/reviews/${prId}`)

  // j / k move between the rows; Enter (the row's own) opens the one focused.
  const listRef = useRef<HTMLDivElement>(null)
  const moveFocus = (dir: 1 | -1) => {
    if (peekId) return
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-pr-row]') ?? [])
    if (rows.length === 0) return
    const at = rows.findIndex((r) => r.contains(document.activeElement))
    const to = at < 0 ? (dir === 1 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + dir))
    rows[to].focus()
    rows[to].scrollIntoView?.({ block: 'nearest' })
  }
  useReviewKeys({ next: () => moveFocus(1), prev: () => moveFocus(-1) })

  const empty = queue ? EMPTY[queue] : null

  return (
    <div className="lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-6">
      <QueueNav value={queue} tally={tally} onPick={(k) => setParams({ queue: k })} />

      <div className="min-w-0">
        {/* Filter bar */}
        <div data-tour="reviews-filters" className="flex flex-wrap items-center gap-2.5 mb-4">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted/60" aria-hidden />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search titles and descriptions…"
              aria-label="Search reviews"
              className="w-full pl-9 pr-8 py-2 rounded-xl border border-glass-border bg-canvas-elevated/50 text-[13px] text-ink placeholder:text-ink-muted/60 outline-none focus:border-accent-lineage/50 transition-colors"
            />
            {search && (
              <button onClick={() => setSearch('')} aria-label="Clear the search"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-ink-muted hover:text-ink"><X className="w-3.5 h-3.5" /></button>
            )}
          </div>
          {sourceOptions.length > 1 && <FilterSelect label="Data source" value={sourceFilter} options={sourceOptions} onChange={setSourceFilter} />}
          {authorOptions.length > 1 && <FilterSelect label="Author" value={authorFilter} options={authorOptions} onChange={setAuthorFilter} />}
          {hasFilters && (
            <button onClick={clearFilters} className="text-[12px] text-ink-muted hover:text-ink underline underline-offset-2">Clear</button>
          )}
          <span className="ml-auto flex items-center gap-2.5">
            <span className="text-[12px] text-ink-muted tabular-nums">{total.toLocaleString()} review{total === 1 ? '' : 's'}</span>
            <Segmented label="Order" value={sort} onChange={setSort}
              options={[{ value: 'activity', label: 'Last activity' }, { value: 'created', label: 'Opened' }]} />
          </span>
        </div>

        {tally?.capped && (
          <p role="note" className="mb-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[12px] text-ink-muted">
            More than 1,000 reviews are open in this workspace, so the oldest are left out of these queues and their
            counts. Search or filter to find one.
          </p>
        )}

        {/* List */}
        <div ref={listRef} data-tour="reviews-list"
          className={cn('space-y-2 transition-opacity', inbox.isPlaceholderData && 'opacity-60')}>
          {items.map((pr) => (
            <PrListRow key={pr.prId} wsId={wsId} pr={pr} sourceLabel={sourceLabel(pr.targetDataSourceId)}
              onOpen={() => openReview(pr.prId)} />
          ))}

          {!pages && !inbox.isError && (
            <div aria-busy className="space-y-2">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[66px] rounded-2xl" />)}
            </div>
          )}
          {inbox.isError && items.length === 0 && (
            <EmptyState icon={AlertTriangle} title="Couldn’t load the reviews" description="Try again in a moment."
              action={{ label: 'Try again', onClick: () => void inbox.refetch() }} />
          )}
          {pages && !inbox.isPlaceholderData && items.length === 0 && empty && (
            hasFilters
              ? <EmptyState icon={SearchX} title="No reviews match" description="Try another search, or clear the filters."
                  action={{ label: 'Clear filters', onClick: clearFilters }} />
              : <EmptyState icon={empty.icon} title={empty.title} description={empty.description} />
          )}
        </div>

        {/* Load more */}
        {inbox.hasNextPage && !inbox.isPlaceholderData && (
          <div className="flex justify-center mt-5">
            <Button onClick={() => void inbox.fetchNextPage()} loading={inbox.isFetchingNextPage}>
              Load more <span className="text-ink-muted/70 tabular-nums">({(total - items.length).toLocaleString()} left)</span>
            </Button>
          </div>
        )}
      </div>

      {peekId && <PrDetailDrawer wsId={wsId} prId={peekId} onClose={() => setParams({ pr: null, thread: null })}
        focusThreadId={searchParams.get('thread')} />}
    </div>
  )
}
