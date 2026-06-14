/**
 * PullBeforeMergeBanner — the on-demand "main moved under you" strip for a draft that has
 * fallen behind main. Shown only when the draft's base trails main's head; the comparison is
 * derived from data the bar already holds (branch base vs main head), so there is NO background
 * polling — the user simply learns main advanced the next time the bar re-renders (their own
 * actions, a window focus refetch, navigation).
 *
 * The headline count comes for free from the seq gap. "What changed" lazily fetches main's
 * commit log ONLY when expanded, then lists the commits newer than the draft's base — so the
 * user can see what landed in the background and confirm it's reflected before they merge.
 */
import { useMemo, useState } from 'react'
import { ChevronDown, GitMerge } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { useCommitLog } from '../hooks/useVersioning'
import { PullLatestButton } from './PullLatestButton'

const who = (a?: unknown) => (typeof a === 'string' && a ? a.split('@')[0] : 'system')

export function PullBeforeMergeBanner({
  wsId,
  graphId,
  branchId,
  baseCommitSeq,
  mainHead,
}: {
  wsId: string
  graphId: string
  branchId: string
  baseCommitSeq: number
  mainHead: number
}) {
  const [open, setOpen] = useState(false)
  const aheadBy = Math.max(0, mainHead - baseCommitSeq)

  // Fetched ONLY once the user opens "What changed" — never in the background.
  const logQ = useCommitLog(open ? wsId : undefined, open ? graphId : undefined)
  const newCommits = useMemo(() => {
    const all = (logQ.data?.commits ?? []) as Array<Record<string, unknown>>
    return all
      .filter((c) => Number(c.commit_seq ?? 0) > baseCommitSeq)
      .sort((a, b) => Number(b.commit_seq ?? 0) - Number(a.commit_seq ?? 0))
  }, [logQ.data, baseCommitSeq])

  if (aheadBy <= 0) return null

  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 shrink-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
        <span className="flex items-center justify-center w-6 h-6 rounded-md bg-amber-500/20 shrink-0">
          <GitMerge className="w-3.5 h-3.5 text-amber-600 dark:text-amber-300" />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-ink leading-tight">
            Main was updated in the background — {aheadBy} new {aheadBy === 1 ? 'change' : 'changes'}
          </p>
          <p className="text-[11px] text-ink-muted leading-tight">
            Pull the latest into your draft and confirm it’s reflected before raising a merge request.
          </p>
        </div>
        <div className="flex-1" />
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-500/15 transition-colors"
        >
          <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', open && 'rotate-180')} />
          What changed
        </button>
        <PullLatestButton variant="bar" wsId={wsId} graphId={graphId} branchId={branchId} behind />
      </div>

      {open && (
        <div className="px-3 pb-2.5 pt-0.5">
          <div className="max-h-48 overflow-y-auto custom-scrollbar rounded-lg border border-amber-500/20 bg-canvas/60 divide-y divide-amber-500/10">
            {logQ.isLoading ? (
              <p className="px-3 py-2 text-[11px] text-ink-muted">Loading main’s recent changes…</p>
            ) : newCommits.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-ink-muted">No commit details available.</p>
            ) : (
              newCommits.map((c) => {
                const stats = (c.stats ?? {}) as Record<string, unknown>
                const n = Number(stats.nodes ?? 0)
                const e = Number(stats.edges ?? 0)
                return (
                  <div key={String(c.commit_id ?? c.commit_seq)} className="px-3 py-1.5">
                    <p className="text-[11px] font-medium text-ink truncate">
                      {(c.message as string) || `${c.kind ?? 'commit'} #${c.commit_seq ?? ''}`}
                    </p>
                    <p className="text-[10px] text-ink-muted">
                      {who(c.actor)} · {timeAgo(c.created_at as string)}
                      {n || e ? ` · ${n} node${n === 1 ? '' : 's'}, ${e} edge${e === 1 ? '' : 's'}` : ''}
                    </p>
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
