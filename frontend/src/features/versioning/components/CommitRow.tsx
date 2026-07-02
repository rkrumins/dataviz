/**
 * CommitRow — one revision in a commit timeline: message + kind badge, author (and, on a
 * squash, the contributors who actually edited), time, create/modify/remove stats, and an
 * expandable per-commit hierarchical diff (lazy — loaded only when opened). Shared by the
 * view History timeline and the pre-merge "Commits" list in the PR review drawer.
 */
import { useCallback } from 'react'
import { ChevronRight, User } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { getCommitDiffChildren } from '@/services/versioningApiService'
import { useCommitDiffSummary } from '../hooks/useVersioning'
import { kindMeta } from '../model/commitKind'
import { ownerName } from '../model/branchVocab'
import { NodeDiffBadge } from './NodeDiffBadge'
import { ChangeTreePanel } from './ChangeTreePanel'

// A missing actor (e.g. a genesis/import commit) is "system" — distinct from an actor id
// that failed to resolve to a name (which falls back to 'Unknown' via ownerName).
const actorLabel = (a: unknown, userNames?: Record<string, string>) =>
  typeof a === 'string' && a ? ownerName(a, userNames) : 'system'
const num = (v: unknown) => (typeof v === 'number' ? v : 0)

function StatChips({ stats }: { stats: Record<string, unknown> }) {
  const added = num(stats.create)
  const modified = num(stats.update)
  const removed = num(stats.delete)
  if (added + modified + removed === 0) return null
  return (
    <span className="inline-flex items-center gap-1 shrink-0">
      {added > 0 && <NodeDiffBadge status="added" count={added} />}
      {modified > 0 && <NodeDiffBadge status="modified" count={modified} />}
      {removed > 0 && <NodeDiffBadge status="removed" count={removed} />}
    </span>
  )
}

export function CommitRow({
  commit,
  wsId,
  graphId,
  originatingViewLabel = null,
  userNames,
  expanded,
  onToggle,
}: {
  commit: Record<string, unknown>
  wsId: string
  graphId: string
  originatingViewLabel?: string | null
  /** actor/contributor id → resolved display name (the commit log wrapper's map). */
  userNames?: Record<string, string>
  expanded: boolean
  onToggle: (commitId: string) => void
}) {
  const commitId = commit.commit_id as string
  const stats = (commit.stats ?? {}) as Record<string, unknown>
  const kind = kindMeta(commit.kind)
  // On a squash (publish/merge) actor is the publisher; contributors are everyone who actually edited.
  const contributors = Array.isArray(commit.contributors) ? (commit.contributors as string[]) : []
  const others = contributors.filter((c) => c && c !== commit.actor)
  // How many draft checkpoints this merge/publish squashed — so Main reads as a merge history.
  const squashed = num(commit.source_commit_count)
  // Only fetch the diff once the row is opened (immutable commit → long staleTime).
  const summaryQ = useCommitDiffSummary(wsId, graphId, expanded ? commitId : null)
  const fetchChildren = useCallback(
    (key: string, offset: number) => getCommitDiffChildren(wsId, graphId, commitId, key, { offset, limit: 50 }),
    [wsId, graphId, commitId],
  )

  return (
    <li className="relative">
      <span className="absolute -left-[1.36rem] top-1 w-2.5 h-2.5 rounded-full bg-accent-lineage ring-2 ring-canvas-elevated" />
      <button onClick={() => onToggle(commitId)} className="w-full text-left group">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm text-ink leading-tight flex items-center gap-1.5 min-w-0">
            <ChevronRight className={cn('w-3.5 h-3.5 text-ink-muted/60 shrink-0 transition-transform', expanded && 'rotate-90')} />
            <span className="truncate group-hover:text-ink">
              {(commit.message as string) || `${commit.kind ?? 'commit'} #${commit.commit_seq ?? ''}`}
            </span>
            <span className={cn('shrink-0 text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded', kind.cls)}>
              {kind.label}
            </span>
          </p>
          <StatChips stats={stats} />
        </div>
        <p className="text-[11px] text-ink-muted mt-0.5 flex items-center gap-1.5 flex-wrap pl-5">
          <User className="w-3 h-3" /> {actorLabel(commit.actor, userNames)}
          {others.length > 0 && (
            <span title="Everyone who edited this revision">
              · edits by {others.map((o) => ownerName(o, userNames)).join(', ')}
            </span>
          )}
          <span>·</span>
          <span>{timeAgo(commit.created_at as string)}</span>
          {squashed > 1 && (
            <span className="px-1.5 py-0.5 rounded bg-ink/5 text-ink-muted" title="Draft checkpoints squashed into this merge">
              merged {squashed} commits
            </span>
          )}
          {originatingViewLabel && (
            <span className="px-1.5 py-0.5 rounded bg-ink/5 text-ink-muted" title="Originating view">
              view {originatingViewLabel}
            </span>
          )}
        </p>
      </button>
      {expanded && (
        <div className="mt-2 pl-5">
          <ChangeTreePanel
            summary={summaryQ.data}
            isLoading={summaryQ.isLoading}
            fetchChildren={fetchChildren}
            origin={{ source: 'commit', commitId }}
            emptyHint="No changes in this commit."
            summaryFirst
          />
        </div>
      )}
    </li>
  )
}
