/**
 * PrListRow — one merge request / pull request in a list (the inbox + the per-data-source
 * versioning tab). Click to open the detail drawer.
 */
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import type { PullRequest } from '@/services/versioningApiService'
import { PrStatusBadge, ApprovalPill, PrKindIcon, derivePrTitle, isDraftMr } from './PrMeta'

export function PrListRow({
  pr,
  sourceLabel,
  onOpen,
}: {
  pr: PullRequest
  /** Which data source this PR belongs to (shown in the workspace inbox). */
  sourceLabel?: string
  onOpen: () => void
}) {
  const branch = isDraftMr(pr) ? 'draft' : (pr.sourceBranchId?.slice(0, 8) ?? 'fork')
  return (
    <button
      onClick={onOpen}
      className={cn(
        'group w-full flex items-center gap-3 rounded-xl border border-glass-border bg-canvas-elevated/40 px-3.5 py-2.5 text-left',
        'hover:border-glass-border/80 hover:bg-canvas-elevated/70 transition-colors',
      )}
    >
      <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] shrink-0">
        <PrKindIcon pr={pr} className="w-4 h-4 text-ink-muted" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-sm font-medium text-ink truncate">{derivePrTitle(pr)}</p>
          <PrStatusBadge status={pr.status} />
        </div>
        <p className="text-[11px] text-ink-muted truncate mt-0.5 flex items-center gap-1.5">
          {sourceLabel && (
            <>
              <span className="truncate">{sourceLabel}</span>
              <span>·</span>
            </>
          )}
          <span className="font-mono">{branch} → {pr.targetBranch}</span>
          <span>·</span>
          <span>{timeAgo(pr.createdAt)}</span>
        </p>
      </div>
      <ApprovalPill pr={pr} />
      <ChevronRight className="w-4 h-4 text-ink-muted/40 group-hover:text-ink-muted shrink-0" />
    </button>
  )
}
