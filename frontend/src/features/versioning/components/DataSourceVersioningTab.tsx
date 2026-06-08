/**
 * DataSourceVersioningTab — the data-source-level versioning hub (a tab in
 * DataSourceDetailPanel). Shows whether version control is on, lets a manager enable
 * it, and surfaces the branch list + recent commit history. Read-only overview; the
 * editing loop lives on the canvas.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { GitBranch, GitCommitHorizontal, History, Loader2, Sparkles, GitMerge, User, GitPullRequestArrow, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/toast'
import { usePermission } from '@/store/auth'
import { useBootstrapGraph, useBranches, useCommitLog, useMergeRequests, useResolveGraph } from '../hooks/useVersioning'
import type { Branch } from '@/services/versioningApiService'
import { PrListRow } from '@/features/reviews/components/PrListRow'
import { PrDetailDrawer } from '@/features/reviews/components/PrDetailDrawer'

function timeAgo(iso?: string): string {
  if (!iso) return ''
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (Number.isNaN(s)) return ''
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function DataSourceVersioningTab({ wsId, dataSourceId }: { wsId: string; dataSourceId: string }) {
  const { showToast } = useToast()
  const canManage = usePermission('workspace:datasource:manage', wsId)
  const resolve = useResolveGraph(wsId, dataSourceId)
  const graphId = resolve.data?.graphId ?? null
  const bootstrap = useBootstrapGraph(wsId)
  const branchesQ = useBranches(wsId, graphId)
  const commitsQ = useCommitLog(wsId, graphId, resolve.data?.mainBranchId ?? null)
  const mrsQ = useMergeRequests(wsId, graphId)
  const [openPrId, setOpenPrId] = useState<string | null>(null)

  if (resolve.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-muted py-10 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" /> Checking version control…
      </div>
    )
  }

  // Not enabled — or a graph that exists but was never seeded (genesis only). Both
  // need the seed step; treating "exists but empty" as not-enabled self-heals a
  // bootstrap that failed partway.
  const needsSeed = !graphId || (resolve.data?.mainHeadCommitSeq ?? 0) <= 1
  if (needsSeed) {
    return (
      <div className="rounded-2xl border border-glass-border bg-gradient-to-br from-accent-lineage/[0.06] to-transparent p-6 text-center">
        <span className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-accent-lineage/10 border border-accent-lineage/20 mb-3">
          <GitBranch className="w-6 h-6 text-accent-lineage" />
        </span>
        <h4 className="text-base font-semibold text-ink">Version control is off</h4>
        <p className="text-sm text-ink-muted mt-1 max-w-md mx-auto">
          Enable it to edit this data source safely in drafts, review every change against the published
          graph, and publish with a full, auditable history.
        </p>
        {canManage ? (
          <button
            onClick={() =>
              bootstrap.mutate(dataSourceId, {
                onSuccess: () => showToast('success', 'Version control enabled.'),
                onError: (e) => showToast('error', (e as Error).message),
              })
            }
            disabled={bootstrap.isPending}
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700 shadow-sm shadow-indigo-500/20 transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-60"
          >
            {bootstrap.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {bootstrap.isPending ? 'Setting up…' : 'Enable version control'}
          </button>
        ) : (
          <p className="mt-4 text-xs text-ink-muted/70">Ask a workspace manager to enable it.</p>
        )}
      </div>
    )
  }

  const branches = branchesQ.data ?? []
  const drafts = branches.filter((b) => b.kind !== 'main')
  const commits = (commitsQ.data?.commits ?? []) as Array<Record<string, unknown>>

  return (
    <div className="space-y-6">
      {/* Status header */}
      <div className="flex items-center gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
        <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
          <GitBranch className="w-4 h-4 text-emerald-500" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">Version control is on</p>
          <p className="text-[11px] text-ink-muted">
            main at commit #{resolve.data?.mainHeadCommitSeq ?? 0} · {drafts.length} open draft{drafts.length === 1 ? '' : 's'}
          </p>
        </div>
      </div>

      {/* Branches */}
      <section>
        <h4 className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-muted uppercase tracking-wider mb-2">
          <GitMerge className="w-3.5 h-3.5" /> Branches
        </h4>
        <div className="space-y-1.5">
          {branches.map((b) => (
            <BranchRow key={b.branchId} branch={b} />
          ))}
          {branchesQ.isLoading && <RowSkeleton />}
        </div>
      </section>

      {/* Merge requests */}
      <section>
        <div className="flex items-center justify-between gap-2 mb-2">
          <h4 className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-muted uppercase tracking-wider">
            <GitPullRequestArrow className="w-3.5 h-3.5" /> Merge requests
          </h4>
          <Link to={`/workspaces/${wsId}/reviews`} className="inline-flex items-center gap-0.5 text-[11px] text-accent-lineage hover:underline">
            View all <ChevronRight className="w-3 h-3" />
          </Link>
        </div>
        {(() => {
          const active = (mrsQ.data ?? []).filter((p) => !['merged', 'closed'].includes(p.status))
          if (mrsQ.isLoading) return <RowSkeleton />
          if (active.length === 0) return <p className="text-xs text-ink-muted px-1 py-2">No open merge requests.</p>
          return (
            <div className="space-y-1.5">
              {active.slice(0, 4).map((pr) => (
                <PrListRow key={pr.prId} pr={pr} onOpen={() => setOpenPrId(pr.prId)} />
              ))}
            </div>
          )
        })()}
      </section>

      {/* History */}
      <section>
        <h4 className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-muted uppercase tracking-wider mb-2">
          <History className="w-3.5 h-3.5" /> Recent history (main)
        </h4>
        {commits.length === 0 ? (
          <p className="text-xs text-ink-muted px-1 py-3">No commits yet.</p>
        ) : (
          <ol className="relative ml-1.5 border-l border-glass-border space-y-3 pl-4">
            {commits.slice(0, 12).map((c, i) => {
              const stats = (c.stats ?? {}) as Record<string, number>
              const total = (stats.created ?? 0) + (stats.updated ?? 0) + (stats.deleted ?? 0)
              return (
                <li key={(c.commit_id as string) ?? i} className="relative">
                  <span className="absolute -left-[1.36rem] top-0.5 w-2.5 h-2.5 rounded-full bg-accent-lineage ring-2 ring-canvas-elevated" />
                  <p className="text-sm text-ink leading-tight">
                    {(c.message as string) || `${c.kind ?? 'commit'} #${c.commit_seq ?? ''}`}
                  </p>
                  <p className="text-[11px] text-ink-muted flex items-center gap-2 mt-0.5">
                    <span className="inline-flex items-center gap-1">
                      <User className="w-3 h-3" />
                      {((c.actor as string) ?? 'system').split('@')[0]}
                    </span>
                    <span>·</span>
                    <span>{timeAgo(c.created_at as string)}</span>
                    {total > 0 && (
                      <>
                        <span>·</span>
                        <span className="tabular-nums">{total} change{total === 1 ? '' : 's'}</span>
                      </>
                    )}
                  </p>
                </li>
              )
            })}
          </ol>
        )}
      </section>

      {openPrId && <PrDetailDrawer wsId={wsId} prId={openPrId} onClose={() => setOpenPrId(null)} />}
    </div>
  )
}

function BranchRow({ branch }: { branch: Branch }) {
  const isMain = branch.kind === 'main'
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-glass-border bg-canvas-elevated/40 px-3 py-2">
      {isMain ? (
        <GitCommitHorizontal className="w-4 h-4 text-ink-muted shrink-0" />
      ) : (
        <GitBranch className="w-4 h-4 text-amber-500 shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-ink truncate">{isMain ? 'main' : branch.name || 'Untitled draft'}</p>
        <p className="text-[11px] text-ink-muted truncate">
          {isMain
            ? 'The published graph'
            : [
                branch.owner ? `by ${branch.owner.split('@')[0]}` : null,
                branch.originatingViewId ? 'from a view' : null,
              ]
                .filter(Boolean)
                .join(' · ') || 'draft'}
        </p>
      </div>
      <span
        className={cn(
          'text-[10px] font-medium px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0',
          branch.status === 'open' ? 'bg-amber-500/10 text-amber-500' : 'bg-ink/5 text-ink-muted',
        )}
      >
        {isMain ? 'published' : branch.status}
      </span>
    </div>
  )
}

function RowSkeleton() {
  return <div className="h-10 rounded-lg bg-canvas-overlay/40 animate-pulse" />
}
