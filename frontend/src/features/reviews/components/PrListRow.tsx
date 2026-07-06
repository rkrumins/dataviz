/**
 * PrListRow — one merge request in the Review Center list. Premium, information-dense row:
 * who raised it (avatar + name), the REAL source branch → target, a lazy change-count chip
 * (added/modified/removed via usePrDiffSummary), reviewer avatar stack + approval, staleness,
 * data source, and relative time. Click opens the detail drawer.
 */
import { useState } from 'react'
import { ChevronRight, GitMerge, AlertTriangle, Plus, Minus, PencilLine, XCircle, Check, X, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import type { PullRequest } from '@/services/versioningApiService'
import { usePrDiffSummary, useCloseMergeRequest } from '@/features/versioning/hooks/useVersioning'
import { ownerName } from '@/features/versioning/model/branchVocab'
import { OwnerAvatar } from '@/features/versioning/components/BranchStatusBits'
import { PrStatusBadge, PrKindIcon, derivePrTitle, isDraftMr } from './PrMeta'

const COUNTED_STATUSES = new Set(['open', 'mergeable', 'approved', 'conflicts'])

/** Lazy per-row change-count chip. Only fetches for active PRs (a merged/closed PR's diff is
 *  historical); React Query dedups + caches so pagination re-renders are free. */
function ChangeCount({ wsId, pr }: { wsId: string; pr: PullRequest }) {
  const enabled = COUNTED_STATUSES.has(pr.status)
  const q = usePrDiffSummary(enabled ? wsId : undefined, enabled ? pr.prId : undefined, 1)
  if (!enabled) return null
  const c = q.data?.counts
  if (!c) {
    return <span className="text-[11px] text-ink-muted/50 tabular-nums">{q.isLoading ? '…' : ''}</span>
  }
  const total = c.added + c.modified + c.removed
  if (total === 0) return <span className="text-[11px] text-ink-muted/60">no changes</span>
  return (
    <span
      className="inline-flex items-center gap-2 text-[11px] font-medium tabular-nums"
      title={`${c.added} added · ${c.modified} modified · ${c.removed} removed`}
    >
      <span className="text-ink-muted">{total} change{total === 1 ? '' : 's'}</span>
      <span className="inline-flex items-center gap-1.5">
        {c.added > 0 && <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400"><Plus className="w-2.5 h-2.5" strokeWidth={3} />{c.added}</span>}
        {c.modified > 0 && <span className="inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400"><PencilLine className="w-2.5 h-2.5" strokeWidth={2.6} />{c.modified}</span>}
        {c.removed > 0 && <span className="inline-flex items-center gap-0.5 text-rose-500"><Minus className="w-2.5 h-2.5" strokeWidth={3} />{c.removed}</span>}
      </span>
    </span>
  )
}

/** Up to 3 reviewer avatars, overlapping, +N overflow. */
function ReviewerStack({ pr }: { pr: PullRequest }) {
  const reviewers = pr.reviewers ?? []
  if (reviewers.length === 0) return null
  const shown = reviewers.slice(0, 3)
  const overflow = reviewers.length - shown.length
  const approved = new Set(pr.approvedBy ?? [])
  return (
    <span className="flex items-center" title={`${(pr.approvedBy?.length ?? 0)}/${reviewers.length} approved`}>
      <span className="flex -space-x-1.5">
        {shown.map((r) => (
          <span key={r} className={cn('rounded-full ring-2 ring-canvas-elevated', approved.has(r) && 'ring-emerald-400/70')}>
            <OwnerAvatar owner={r} userNames={pr.userNames} size="sm" />
          </span>
        ))}
      </span>
      {overflow > 0 && <span className="ml-1 text-[10px] font-semibold text-ink-muted tabular-nums">+{overflow}</span>}
    </span>
  )
}

export function PrListRow({
  wsId,
  pr,
  sourceLabel,
  onOpen,
}: {
  wsId: string
  pr: PullRequest
  /** Which data source this PR belongs to (shown in the workspace inbox). */
  sourceLabel?: string
  onOpen: () => void
}) {
  const branchName = pr.sourceBranchName?.trim() || (isDraftMr(pr) ? 'draft' : pr.sourceBranchId?.slice(0, 8)) || 'fork'
  const author = ownerName(pr.actor, pr.userNames)
  const behind = pr.behind && (pr.behindBy ?? 0) > 0
  const closePr = useCloseMergeRequest(wsId)
  const [confirming, setConfirming] = useState(false)
  const canDismiss = COUNTED_STATUSES.has(pr.status) // only an active PR can be dismissed

  return (
    // A clickable <div> (not <button>) so the inline Dismiss controls can be real nested buttons.
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      className={cn(
        'group w-full flex items-center gap-3.5 rounded-2xl border border-glass-border bg-canvas-elevated/50 px-4 py-3 text-left cursor-pointer',
        'hover:border-accent-lineage/40 hover:bg-canvas-elevated/80 hover:shadow-sm transition-all duration-150',
      )}
    >
      {/* Identity — who raised it, with the PR kind as a corner badge */}
      <span className="relative shrink-0">
        <OwnerAvatar owner={pr.actor} userNames={pr.userNames} size="md" />
        <span className="absolute -bottom-1 -right-1 flex items-center justify-center w-4 h-4 rounded-full bg-canvas-elevated border border-glass-border">
          <PrKindIcon pr={pr} className="w-2.5 h-2.5 text-ink-muted" />
        </span>
      </span>

      <div className="min-w-0 flex-1">
        {/* Title + status */}
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-[14px] font-semibold text-ink truncate">{derivePrTitle(pr)}</p>
          <PrStatusBadge status={pr.status} />
          {behind && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 shrink-0"
              title={`Behind main by ${pr.behindBy} commit${pr.behindBy === 1 ? '' : 's'} — pull latest before merging`}
            >
              <AlertTriangle className="w-2.5 h-2.5" /> behind {pr.behindBy}
            </span>
          )}
        </div>

        {/* Meta line: branch → target · source · changes · by author · time */}
        <div className="flex items-center gap-2 mt-1 text-[11.5px] text-ink-muted min-w-0 flex-wrap">
          <span className="inline-flex items-center gap-1 font-mono text-[11px] text-ink/70 min-w-0">
            <span className="truncate max-w-[180px]" title={branchName}>{branchName}</span>
            <GitMerge className="w-3 h-3 text-ink-muted/60 shrink-0" />
            <span className="text-ink-muted">{pr.targetBranch}</span>
          </span>
          {sourceLabel && (<><span className="text-ink-muted/40">·</span><span className="truncate max-w-[160px]">{sourceLabel}</span></>)}
          <span className="text-ink-muted/40">·</span>
          <ChangeCount wsId={wsId} pr={pr} />
          <span className="text-ink-muted/40">·</span>
          <span>by <span className="text-ink/70 font-medium">{author}</span></span>
          <span className="text-ink-muted/40">·</span>
          <span title={new Date(pr.createdAt).toLocaleString()}>{timeAgo(pr.createdAt)}</span>
        </div>
      </div>

      <ReviewerStack pr={pr} />

      {/* Dismiss — reject the PR (close without merging; no changes are taken). Inline confirm. */}
      {canDismiss && (
        confirming ? (
          <span className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
            <span className="text-[11px] text-ink-muted mr-0.5 hidden sm:inline">Dismiss?</span>
            <button
              onClick={(e) => { e.stopPropagation(); closePr.mutate({ prId: pr.prId, graphId: pr.graphId }, { onSuccess: () => setConfirming(false) }) }}
              disabled={closePr.isPending}
              title="Reject these changes — closes the request without merging"
              className="p-1.5 rounded-lg bg-rose-500/15 text-rose-500 hover:bg-rose-500/25 transition-colors disabled:opacity-60"
            >{closePr.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" strokeWidth={2.6} />}</button>
            <button
              onClick={(e) => { e.stopPropagation(); setConfirming(false) }}
              title="Cancel"
              className="p-1.5 rounded-lg text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            ><X className="w-3.5 h-3.5" /></button>
          </span>
        ) : (
          <button
            onClick={(e) => { e.stopPropagation(); setConfirming(true) }}
            title="Dismiss — reject these changes without merging (nothing is applied to main)"
            className="p-1.5 rounded-lg text-ink-muted/50 hover:bg-rose-500/10 hover:text-rose-500 transition-all shrink-0"
          ><XCircle className="w-4 h-4" /></button>
        )
      )}

      <ChevronRight className="w-4 h-4 text-ink-muted/40 group-hover:text-accent-lineage transition-colors shrink-0" />
    </div>
  )
}
