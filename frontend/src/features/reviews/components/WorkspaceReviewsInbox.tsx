/**
 * WorkspaceReviewsInbox — the Review Center core: fans out one DataSourceReviewFeed per data
 * source (the backend lists PRs per graph), aggregates them, and layers a premium review
 * experience on top: summary stat cards, scope + author + data-source filters, search, and
 * load-more pagination. Backend-driven data; rich client-side slicing (fine at this volume).
 * Self-contained (only needs `wsId`), reused by the standalone page + the workspace Reviews tab.
 */
import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import {
  Inbox, Loader2, Search, X, ChevronDown, GitPullRequestArrow, GitMerge,
  AlertTriangle, CircleUserRound,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWorkspacesStore } from '@/store/workspaces'
import { useAuthStore } from '@/store/auth'
import { ownerName } from '@/features/versioning/model/branchVocab'
import { DataSourceReviewFeed, type ReviewItem } from './DataSourceReviewFeed'
import { PrListRow } from './PrListRow'
import { PrDetailDrawer } from './PrDetailDrawer'

const OPEN_STATUSES = new Set(['open', 'mergeable', 'approved', 'conflicts'])
const READY_STATUSES = new Set(['mergeable', 'approved'])
const PAGE = 20
type Scope = 'open' | 'mine' | 'all'

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
        <div className="absolute z-20 mt-1.5 min-w-[200px] max-h-72 overflow-y-auto rounded-xl border border-glass-border bg-canvas-elevated shadow-xl shadow-black/10 py-1">
          <button
            onClick={() => { onChange(null); setOpen(false) }}
            className={cn('w-full text-left px-3 py-2 text-[13px] hover:bg-accent-lineage/[0.06] transition-colors', !value ? 'text-accent-lineage font-medium' : 'text-ink')}
          >All {label.toLowerCase()}s</button>
          {options.map((o) => (
            <button
              key={o.id}
              onClick={() => { onChange(o.id); setOpen(false) }}
              className={cn('w-full text-left px-3 py-2 text-[13px] truncate hover:bg-accent-lineage/[0.06] transition-colors', value === o.id ? 'text-accent-lineage font-medium' : 'text-ink')}
              title={o.label}
            >{o.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Summary stat card ────────────────────────────────────────────────────────
function StatCard({
  icon: Icon, label, count, tone, active, onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  count: number
  tone: 'indigo' | 'emerald' | 'amber' | 'violet'
  active?: boolean
  onClick?: () => void
}) {
  const tones = {
    indigo: 'text-accent-lineage bg-accent-lineage/10 border-accent-lineage/20',
    emerald: 'text-emerald-600 bg-emerald-500/10 border-emerald-500/20',
    amber: 'text-amber-600 bg-amber-500/10 border-amber-500/20',
    violet: 'text-violet-500 bg-violet-500/10 border-violet-500/20',
  }[tone]
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-all',
        active ? 'border-accent-lineage/50 bg-canvas-elevated shadow-sm' : 'border-glass-border bg-canvas-elevated/40 hover:bg-canvas-elevated/70',
      )}
    >
      <span className={cn('flex items-center justify-center w-9 h-9 rounded-xl border shrink-0', tones)}>
        <Icon className="w-[18px] h-[18px]" />
      </span>
      <span className="min-w-0">
        <span className="block text-xl font-bold text-ink leading-none tabular-nums">{count}</span>
        <span className="block text-[11.5px] text-ink-muted mt-1 truncate">{label}</span>
      </span>
    </button>
  )
}

export function WorkspaceReviewsInbox({ wsId, initialPrId }: { wsId: string; initialPrId?: string | null }) {
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const loadWorkspaces = useWorkspacesStore((s) => s.loadWorkspaces)
  const workspace = workspaces.find((w) => w.id === wsId)
  useEffect(() => { if (!workspace) loadWorkspaces() }, [workspace, loadWorkspaces])
  const dataSources = workspace?.dataSources ?? []
  const user = useAuthStore((s) => s.user)

  const [feeds, setFeeds] = useState<Record<string, ReviewItem[]>>({})
  const onLoaded = useCallback((dsId: string, items: ReviewItem[]) => {
    setFeeds((prev) => ({ ...prev, [dsId]: items }))
  }, [])

  const [scope, setScope] = useState<Scope>('open')
  const [authorFilter, setAuthorFilter] = useState<string | null>(null)
  const [sourceFilter, setSourceFilter] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [visible, setVisible] = useState(PAGE)
  const [openPrId, setOpenPrId] = useState<string | null>(initialPrId ?? null)

  // "Raised by you" = PRs you authored. (Swapped in for the old reviewer-inbox scope, which is
  // always empty in workflows that don't assign reviewers; the Author filter still covers everyone.)
  const raisedByMe = useCallback(
    (pr: ReviewItem['pr']) => !!user?.id && pr.actor === user.id,
    [user],
  )

  const all = useMemo(
    () => Object.values(feeds).flat().sort((a, b) => b.pr.createdAt.localeCompare(a.pr.createdAt)),
    [feeds],
  )

  const authorOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const { pr } of all) if (pr.actor && !seen.has(pr.actor)) seen.set(pr.actor, ownerName(pr.actor, pr.userNames))
    return [...seen].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label))
  }, [all])
  const sourceOptions = useMemo(() => {
    const seen = new Set<string>()
    for (const { sourceLabel } of all) if (sourceLabel) seen.add(sourceLabel)
    return [...seen].sort().map((s) => ({ id: s, label: s }))
  }, [all])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return all.filter(({ pr, sourceLabel }) => {
      if (scope === 'open' && !OPEN_STATUSES.has(pr.status)) return false
      if (scope === 'mine' && !raisedByMe(pr)) return false
      if (authorFilter && pr.actor !== authorFilter) return false
      if (sourceFilter && sourceLabel !== sourceFilter) return false
      if (q) {
        const hay = `${pr.title ?? ''} ${pr.sourceBranchName ?? ''} ${ownerName(pr.actor, pr.userNames)} ${sourceLabel}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [all, scope, authorFilter, sourceFilter, search, raisedByMe])

  // Reset the visible window whenever the active filter set changes.
  useEffect(() => { setVisible(PAGE) }, [scope, authorFilter, sourceFilter, search])

  const stats = useMemo(() => ({
    open: all.filter(({ pr }) => OPEN_STATUSES.has(pr.status)).length,
    ready: all.filter(({ pr }) => READY_STATUSES.has(pr.status)).length,
    attention: all.filter(({ pr }) => pr.status === 'conflicts' || (pr.behind && (pr.behindBy ?? 0) > 0)).length,
    mine: all.filter(({ pr }) => raisedByMe(pr)).length,
  }), [all, raisedByMe])

  const loading = Object.keys(feeds).length < dataSources.length
  const hasFilters = !!(authorFilter || sourceFilter || search.trim())
  const shown = filtered.slice(0, visible)

  const SCOPES: Array<{ key: Scope; label: string }> = [
    { key: 'open', label: 'Open' },
    { key: 'mine', label: 'Raised by you' },
    { key: 'all', label: 'All' },
  ]

  return (
    <div>
      {/* Headless fan-out — one query per data source */}
      {dataSources.map((ds) => (
        <DataSourceReviewFeed key={ds.id} wsId={wsId} dataSourceId={ds.id} sourceLabel={ds.label ?? 'Data source'} onLoaded={onLoaded} />
      ))}

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard icon={GitPullRequestArrow} label="Open requests" count={stats.open} tone="indigo" active={scope === 'open'} onClick={() => setScope('open')} />
        <StatCard icon={GitMerge} label="Ready to merge" count={stats.ready} tone="emerald" onClick={() => { setScope('all'); }} />
        <StatCard icon={AlertTriangle} label="Needs attention" count={stats.attention} tone="amber" onClick={() => { setScope('all'); }} />
        <StatCard icon={CircleUserRound} label="Raised by you" count={stats.mine} tone="violet" active={scope === 'mine'} onClick={() => setScope('mine')} />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2.5 mb-5">
        {/* Scope segmented */}
        <div className="inline-flex items-center rounded-xl border border-glass-border bg-canvas-elevated/50 p-0.5">
          {SCOPES.map((s) => (
            <button
              key={s.key}
              onClick={() => setScope(s.key)}
              className={cn('px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors', scope === s.key ? 'bg-accent-lineage/12 text-accent-lineage' : 'text-ink-muted hover:text-ink')}
            >{s.label}</button>
          ))}
        </div>

        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted/60" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by title, branch, or author…"
            className="w-full pl-9 pr-8 py-2 rounded-xl border border-glass-border bg-canvas-elevated/50 text-[13px] text-ink placeholder:text-ink-muted/60 outline-none focus:border-accent-lineage/50 transition-colors"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-ink-muted hover:text-ink"><X className="w-3.5 h-3.5" /></button>
          )}
        </div>

        {authorOptions.length > 1 && <FilterSelect label="Author" value={authorFilter} options={authorOptions} onChange={setAuthorFilter} />}
        {sourceOptions.length > 1 && <FilterSelect label="Source" value={sourceFilter} options={sourceOptions} onChange={setSourceFilter} />}
        {hasFilters && (
          <button onClick={() => { setAuthorFilter(null); setSourceFilter(null); setSearch('') }} className="text-[12px] text-ink-muted hover:text-ink underline underline-offset-2">Clear</button>
        )}
        <span className="ml-auto text-[12px] text-ink-muted tabular-nums">{filtered.length} request{filtered.length === 1 ? '' : 's'}</span>
      </div>

      {/* List */}
      <div className="space-y-2">
        {shown.map(({ pr, sourceLabel }) => (
          <PrListRow key={pr.prId} wsId={wsId} pr={pr} sourceLabel={sourceLabel} onOpen={() => setOpenPrId(pr.prId)} />
        ))}

        {loading && filtered.length === 0 && (
          <div className="flex items-center gap-2 text-sm text-ink-muted py-16 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading reviews…
          </div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="text-center py-20">
            <Inbox className="w-9 h-9 text-ink-muted/40 mx-auto mb-3" />
            <p className="text-sm font-semibold text-ink">
              {hasFilters ? 'No requests match your filters' : scope === 'mine' ? "You haven't raised any requests" : scope === 'open' ? 'No open requests' : 'No requests yet'}
            </p>
            <p className="text-xs text-ink-muted mt-1 max-w-md mx-auto leading-relaxed">
              {hasFilters
                ? 'Try clearing a filter or search term.'
                : scope === 'mine'
                  ? 'Merge requests you open from a draft will appear here.'
                  : 'Open a merge request from a draft to start a review.'}
            </p>
          </div>
        )}
      </div>

      {/* Load more */}
      {filtered.length > visible && (
        <div className="flex justify-center mt-5">
          <button
            onClick={() => setVisible((v) => v + PAGE)}
            className="inline-flex items-center gap-2 rounded-xl border border-glass-border bg-canvas-elevated/60 px-4 py-2 text-[13px] font-medium text-ink-muted hover:text-ink hover:border-glass-border/80 transition-colors"
          >
            Show more <span className="text-ink-muted/60 tabular-nums">({filtered.length - visible} left)</span>
          </button>
        </div>
      )}

      {openPrId && <PrDetailDrawer wsId={wsId} prId={openPrId} onClose={() => setOpenPrId(null)} />}
    </div>
  )
}
