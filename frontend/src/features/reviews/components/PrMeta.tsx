/**
 * Shared PR presentation: a status badge (the 7 lifecycle states), an approval pill
 * (x/y reviewers), and the small helpers for deriving a human title + the PR "kind"
 * (draft→main MR vs fork→parent PR) that the backend decides server-side but the UI
 * labels client-side.
 */
import { GitMerge, CircleDot, CheckCircle2, XCircle, AlertTriangle, GitPullRequestArrow, GitFork } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import type { PullRequest } from '@/services/versioningApiService'
import { ownerName } from '../../versioning/model/branchVocab'

type StatusMeta = { label: string; cls: string; Icon: React.ComponentType<{ className?: string }> }

const STATUS_META: Record<string, StatusMeta> = {
  open: { label: 'Open', cls: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20', Icon: CircleDot },
  mergeable: { label: 'Ready to merge', cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20', Icon: GitMerge },
  approved: { label: 'Approved', cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20', Icon: CheckCircle2 },
  conflicts: { label: 'Conflicts', cls: 'bg-amber-500/10 text-amber-600 border-amber-500/20', Icon: AlertTriangle },
  // A fork's review a job is merging: in progress until the job lands it or hands it back.
  merging: { label: 'Merging', cls: 'bg-violet-500/10 text-violet-500 border-violet-500/20', Icon: GitMerge },
  merged: { label: 'Merged', cls: 'bg-violet-500/10 text-violet-500 border-violet-500/20', Icon: GitMerge },
  closed: { label: 'Closed', cls: 'bg-ink/5 text-ink-muted border-glass-border', Icon: XCircle },
}

export function PrStatusBadge({ status, className }: { status: string; className?: string }) {
  const m = STATUS_META[status] ?? STATUS_META.open
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold shrink-0', m.cls, className)}>
      <m.Icon className="w-3 h-3" />
      {m.label}
    </span>
  )
}

/** x/y approvals — as the review's rule counts them (everyone asked, or N of anyone's) where the
 *  server says, else reviewers approved; hidden when it needs no approval. */
export function ApprovalPill({ pr, className }: { pr: PullRequest; className?: string }) {
  const counted = pr.review?.approvals
  const total = counted ? counted.required : pr.reviewers?.length ?? 0
  if (total === 0) return null
  const done = counted ? counted.have : pr.approvedBy?.length ?? 0
  const complete = counted ? counted.satisfied : pr.approvalStatus === 'approved'
  const asked = pr.review ? pr.review.requiredApprovals === 0 : true
  return (
    <HoverTip label={asked ? `${done} of ${total} reviewer(s) approved` : `${done} of ${total} approvals needed`}
      className="inline-flex shrink-0">
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums shrink-0',
          complete ? 'bg-emerald-500/10 text-emerald-600' : 'bg-amber-500/10 text-amber-600',
          className,
        )}
      >
        <CheckCircle2 className="w-3 h-3" />
        {done}/{total}
      </span>
    </HoverTip>
  )
}

/** A draft→main MR has the same source and target graph; a fork PR targets a parent. */
export const isDraftMr = (pr: PullRequest) => pr.graphId === pr.targetGraphId

export const PrKindIcon = ({ pr, className }: { pr: PullRequest; className?: string }) =>
  isDraftMr(pr) ? <GitPullRequestArrow className={className} /> : <GitFork className={className} />

/** The author-supplied title if any, else a readable fallback derived from kind + author. */
export function derivePrTitle(pr: PullRequest): string {
  if (pr.title && pr.title.trim()) return pr.title.trim()
  const actor = ownerName(pr.actor, pr.userNames)
  return isDraftMr(pr) ? `Publish draft by ${actor}` : `Incoming changes from ${actor}`
}
