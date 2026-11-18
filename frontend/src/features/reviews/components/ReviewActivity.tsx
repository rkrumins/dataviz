/**
 * ReviewActivity — what happened to a review, oldest first: opened, approved, merged (or published
 * past it), closed. Read from the review itself, not a log.
 */
import { useMemo } from 'react'
import { CheckCircle2, GitMerge, GitPullRequestArrow, ShieldAlert, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import type { PullRequest } from '@/services/versioningApiService'
import { ownerName } from '../../versioning/model/branchVocab'

export function ReviewActivity({ pr }: { pr: PullRequest }) {
  const events = useMemo(() => {
    type Ev = { Icon: React.ComponentType<{ className?: string }>; text: string; time?: string; tint: string }
    const evs: Ev[] = [{ Icon: GitPullRequestArrow, text: `Opened by ${ownerName(pr.actor, pr.userNames)}`, time: pr.createdAt, tint: 'bg-accent-lineage' }]
    for (const a of pr.approvedBy ?? []) evs.push({ Icon: CheckCircle2, text: `Approved by ${ownerName(a, pr.userNames)}`, time: pr.updatedAt, tint: 'bg-emerald-500' })
    if (pr.status === 'merged') {
      // A `direct_publish` merge means someone published the source branch straight to Published,
      // which lands exactly what this review proposed and so resolves it — but WITHOUT the reviewers
      // ever seeing it. Say that, rather than presenting a bypassed review as a reviewed merge.
      const bypassed = pr.mergedVia === 'direct_publish'
      const who = ownerName(pr.mergedBy, pr.userNames)
      const sha = pr.resultingCommitId ? ` · ${pr.resultingCommitId.slice(0, 8)}` : ''
      evs.push({
        Icon: bypassed ? ShieldAlert : GitMerge,
        text: bypassed
          ? `Published directly by ${who}, bypassing this review${sha}`
          : pr.mergedVia === 'review_partial'
            ? `What was accepted merged by ${who}${sha}; the rest stayed on the draft`
            : `Merged by ${who}${sha}`,
        time: pr.mergedAt ?? pr.updatedAt,
        tint: bypassed ? 'bg-amber-500' : 'bg-violet-500',
      })
    }
    if (pr.status === 'closed') evs.push({ Icon: XCircle, text: `Closed by ${ownerName(pr.closedBy, pr.userNames)}`, time: pr.closedAt ?? pr.updatedAt, tint: 'bg-ink-muted' })
    return evs
  }, [pr])

  return (
    <ol className="relative ml-1.5 border-l border-glass-border space-y-3 pl-4">
      {events.map((ev, i) => (
        <li key={i} className="relative">
          <span className={cn('absolute -left-[1.36rem] top-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-canvas-elevated', ev.tint)} />
          <p className="text-sm text-ink leading-tight flex items-center gap-1.5">
            <ev.Icon className="w-3.5 h-3.5 text-ink-muted" /> {ev.text}
          </p>
          {ev.time && <p className="text-[11px] text-ink-muted mt-0.5">{timeAgo(ev.time)}</p>}
        </li>
      ))}
    </ol>
  )
}
