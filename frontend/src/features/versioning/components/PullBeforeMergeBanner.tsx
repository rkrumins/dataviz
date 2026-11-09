/**
 * PullBeforeMergeBanner — the "Published moved under you" strip for a draft behind it, saying why
 * it matters and what to do next (doc 19 §3.5).
 *
 * - **Someone changed Published** (`people`): get their changes in and check them, then publish.
 * - **Automation changed what you're changing** (`overlap`): get the latest to see what it changed.
 * - **A draft this large** (`size`): it publishes only up to date.
 * - **Automation alone, on nothing you changed** (not required): a calm note. You can publish as it
 *   is, because your changes land on top. Getting the latest is offered, never required.
 *
 * The headline count comes from the seq gap. "What changed" fetches Published's log only when
 * opened, and lists the commits newer than the draft's base, each saying whether a person or
 * automation made it.
 */
import { useMemo, useState } from 'react'
import { Bot, ChevronDown, GitMerge } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import type { PullReason } from '@/services/versioningApiService'
import { useCommitLog } from '../hooks/useVersioning'
import { ownerName } from '../model/branchVocab'
import { gateCopy } from '../model/provenance'
import { CommitProvenance } from './CommitProvenance'
import { PullLatestButton } from './PullLatestButton'

// A missing actor (e.g. a genesis/import commit) is "system" — distinct from an actor id
// that failed to resolve to a name (which falls back to 'Unknown' via ownerName).
const actorLabel = (a: unknown, userNames?: Record<string, string>) =>
  typeof a === 'string' && a ? ownerName(a, userNames) : 'system'

const changesOf = (stats: Record<string, unknown>) =>
  ['create', 'update', 'delete'].reduce((n, op) => n + (typeof stats[op] === 'number' ? (stats[op] as number) : 0), 0)

export function PullBeforeMergeBanner({
  wsId,
  graphId,
  branchId,
  baseCommitSeq,
  mainHead,
  required = true,
  reason = null,
  behindByPeople = 0,
}: {
  wsId: string
  graphId: string
  branchId: string
  baseCommitSeq: number
  mainHead: number
  /** Must it pull before it publishes? (The freshness poll's `pullRequired`.) */
  required?: boolean
  /** Why it must (the poll's `pullReason`). */
  reason?: PullReason | null
  behindByPeople?: number
}) {
  const [open, setOpen] = useState(false)
  const aheadBy = Math.max(0, mainHead - baseCommitSeq)
  const copy = gateCopy(required ? (reason ?? 'people') : null, aheadBy, behindByPeople)
  const info = copy.tone === 'info'
  const automationLed = info || reason === 'overlap'

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
    <div
      role="status"
      className={cn('border-b shrink-0', info
        ? 'border-violet-500/20 bg-gradient-to-r from-violet-500/[0.07] via-sky-500/[0.04] to-transparent'
        : 'border-amber-500/30 bg-amber-500/10')}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
        <span className={cn('flex items-center justify-center w-6 h-6 rounded-md shrink-0',
          info ? 'bg-violet-500/15 ring-1 ring-inset ring-violet-500/20' : 'bg-amber-500/20')}>
          {automationLed
            ? <Bot className={cn('w-3.5 h-3.5', info ? 'text-violet-600 dark:text-violet-300' : 'text-amber-600 dark:text-amber-300')} />
            : <GitMerge className="w-3.5 h-3.5 text-amber-600 dark:text-amber-300" />}
        </span>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-ink leading-tight">{copy.title}</p>
          <p className="text-[11px] text-ink-muted leading-tight">{copy.body}</p>
        </div>
        <div className="flex-1" />
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cn('flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors', info
            ? 'text-violet-700 dark:text-violet-300 hover:bg-violet-500/10'
            : 'text-amber-700 dark:text-amber-300 hover:bg-amber-500/15')}
        >
          <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', open && 'rotate-180')} />
          What changed
        </button>
        <PullLatestButton variant="bar" wsId={wsId} graphId={graphId} branchId={branchId} behind />
      </div>

      {open && (
        <div className="px-3 pb-2.5 pt-0.5">
          <div className={cn('max-h-48 overflow-y-auto custom-scrollbar rounded-lg border bg-canvas/60 divide-y',
            info ? 'border-violet-500/15 divide-violet-500/10' : 'border-amber-500/20 divide-amber-500/10')}>
            {logQ.isLoading ? (
              <p className="px-3 py-2 text-[11px] text-ink-muted">Loading recent updates…</p>
            ) : newCommits.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-ink-muted">No commit details available.</p>
            ) : (
              newCommits.map((c) => {
                const n = changesOf((c.stats ?? {}) as Record<string, unknown>)
                return (
                  <div key={String(c.commit_id ?? c.commit_seq)} className="px-3 py-1.5">
                    <p className="text-[11px] font-medium text-ink truncate">
                      {(c.message as string) || `${c.kind ?? 'commit'} #${c.commit_seq ?? ''}`}
                    </p>
                    <p className="text-[10px] text-ink-muted flex items-center gap-1.5 flex-wrap">
                      <span>{actorLabel(c.actor, logQ.data?.userNames)} · {timeAgo(c.created_at as string)}</span>
                      {n > 0 && <span className="tabular-nums">· {n.toLocaleString()} {n === 1 ? 'change' : 'changes'}</span>}
                      <CommitProvenance commit={c} apiKeyNames={logQ.data?.apiKeyNames} />
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
