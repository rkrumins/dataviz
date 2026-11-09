/**
 * CommitRow — one revision in a commit timeline: message + kind badge, author (and, on a
 * squash, the contributors who actually edited), time, create/modify/remove stats, and an
 * expandable per-commit hierarchical diff (lazy — loaded only when opened). Shared by the
 * view History timeline and the pre-merge "Commits" list in the PR review drawer.
 *
 * With `allowSquashDrilldown`, a squash/publish row's "merged N commits" badge becomes a
 * toggle that lazily lists the raw draft commits it squashed (so the published "This view"
 * timeline stays short — same granularity as the whole-graph log — while every squash
 * remains fully auditable on demand). Nested rows are themselves diffable.
 *
 * With `revision` (a revision of Published, the revision viewer on), its menu opens it on the
 * canvas as the graph was then — asked first whether it can be, so a revision too far back says
 * so before it is chosen — compares it with now or another revision, and copies a link to it; an
 * opened row says how far the graph has moved on since.
 */
import { useCallback, useMemo, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronRight, User, Loader2, Layers, MoreHorizontal, History, Undo2, ArrowDownToLine, Eye, GitCompareArrows, Link2, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { timeAgo } from '@/lib/timeAgo'
import { getCommitDiffChildren } from '@/services/versioningApiService'
import { useChangeSummary, useCommitDiffSummary, useRevision, useSquashedCommits } from '../hooks/useVersioning'
import { kindMeta, isPullCommit } from '../model/commitKind'
import { actorName, ownerName } from '../model/branchVocab'
import { NodeDiffBadge } from './NodeDiffBadge'
import { ChangeTreePanel } from './ChangeTreePanel'
import { CommitProvenance } from './CommitProvenance'

/** What a revision of Published offers from its row (the revision viewer on). */
export interface RevisionRowActions {
  /** Published's head: the graph as it is now, which there is nothing to open or compare with. */
  headSeq: number
  /** Why opening is held back for now (unsaved edits), or null. */
  openBlocked?: string | null
  onOpen: () => void
  onCompareWithNow: () => void
  onCompareWith: () => void
  onCopyLink: () => void
}

const compactCount = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

// A missing actor (e.g. a genesis/import commit), or the platform's own ("system"), is "system" —
// distinct from an actor id that failed to resolve to a name ('Unknown', via ownerName).
const actorLabel = (a: unknown, userNames?: Record<string, string>) =>
  actorName(typeof a === 'string' ? a : null, userNames)
const num = (v: unknown) => (typeof v === 'number' ? v : 0)

export function StatChips({ stats }: { stats: Record<string, unknown> }) {
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

/** The raw draft commits squashed into one publish/merge, lazily loaded on expand. Each child
 *  is a full CommitRow (its own diff drills down further); squash-in-squash isn't possible, so
 *  children never drill down again. */
function SquashedCommitList({
  wsId, graphId, commitId, userNames, apiKeyNames,
}: {
  wsId: string; graphId: string; commitId: string; userNames?: Record<string, string>
  apiKeyNames?: Record<string, string>
}) {
  const q = useSquashedCommits(wsId, graphId, commitId)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const toggle = useCallback((id: string) => setExpandedId((p) => (p === id ? null : id)), [])
  const commits = (q.data?.commits ?? []) as Array<Record<string, unknown>>

  if (q.isLoading) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-ink-muted py-2 pl-4">
        <Loader2 className="w-3 h-3 animate-spin" /> Loading squashed commits…
      </div>
    )
  }
  if (commits.length === 0) {
    return <p className="text-[11px] text-ink-muted/70 py-2 pl-4">No underlying commits.</p>
  }
  return (
    <ol className="mt-2 ml-1 border-l border-dashed border-glass-border space-y-3 pl-4">
      {commits.map((c, i) => {
        const cid = (c.commit_id as string) ?? String(i)
        return (
          <CommitRow
            key={cid}
            commit={c}
            wsId={wsId}
            graphId={graphId}
            userNames={userNames ?? q.data?.userNames}
            apiKeyNames={{ ...q.data?.apiKeyNames, ...apiKeyNames }}
            expanded={expandedId === cid}
            onToggle={toggle}
          />
        )
      })}
    </ol>
  )
}

export function CommitRow({
  commit,
  wsId,
  graphId,
  originatingViewLabel = null,
  allowSquashDrilldown = false,
  userNames,
  apiKeyNames,
  expanded,
  onToggle,
  onRevert,
  onRestore,
  published = false,
  revision,
  asItem = 'li',
  inRun = false,
}: {
  commit: Record<string, unknown>
  wsId: string
  graphId: string
  originatingViewLabel?: string | null
  /** Show the "merged N commits" badge as a toggle that lists the squashed draft commits. */
  allowSquashDrilldown?: boolean
  /** actor/contributor id → resolved display name (the commit log wrapper's map). */
  userNames?: Record<string, string>
  /** API key id → name (the commit log wrapper's map): names the key a change came through. */
  apiKeyNames?: Record<string, string>
  expanded: boolean
  onToggle: (commitId: string) => void
  /** When provided (main timeline, manager, flag on): "Undo just this change". Hidden on genesis. */
  onRevert?: (commit: Record<string, unknown>) => void
  /** When provided: "Restore graph to here" (valid on every revision incl. genesis = empty). */
  onRestore?: (commit: Record<string, unknown>) => void
  /** A revision of Published (main): too many changes for its tree are listed a page at a time. */
  published?: boolean
  /** A revision of Published that can be opened, compared and linked to (the revision viewer). */
  revision?: RevisionRowActions
  /** `div` inside a virtualized list, which draws its own rows. */
  asItem?: 'li' | 'div'
  /** One of an automation run's commits, under the run's row, which already says who and how. */
  inRun?: boolean
}) {
  const commitId = commit.commit_id as string
  const stats = (commit.stats ?? {}) as Record<string, unknown>
  const kind = kindMeta(commit.kind)
  const isGenesis = commit.kind === 'genesis'
  const showRollbackMenu = Boolean(onRestore || (onRevert && !isGenesis))
  const seq = typeof commit.commit_seq === 'number' ? commit.commit_seq : null
  const atHead = !!revision && seq != null && seq >= revision.headSeq
  const showMenu = showRollbackMenu || !!revision
  // Whether the canvas can draw it: asked when the menu opens, so the choice says before it is made.
  const [menuOpen, setMenuOpen] = useState(false)
  const plan = useRevision(wsId, graphId, revision && menuOpen && !atHead ? seq : null)
  // How far the graph has moved on since — when an opened row is a past revision.
  const sinceOrigin = useMemo(
    () => (revision && expanded && seq != null && !atHead ? { fromSeq: seq, toSeq: revision.headSeq } : null),
    [revision, expanded, seq, atHead],
  )
  const sinceQ = useChangeSummary(wsId, graphId, sinceOrigin)
  // On a squash (publish/merge) actor is the publisher; contributors are everyone who actually edited.
  const contributors = Array.isArray(commit.contributors) ? (commit.contributors as string[]) : []
  const others = contributors.filter((c) => c && c !== commit.actor)
  // How many draft checkpoints this merge/publish squashed — so Main reads as a merge history.
  const squashed = num(commit.source_commit_count)
  // A `pull` reuses the same source_commit_ids drill-down, but tells a different story: these are
  // the UPSTREAM commits that arrived, not draft checkpoints someone folded together. Two knock-on
  // differences: it's meaningful even for a single commit (one teammate's change is worth naming),
  // and it must be drillable on the DRAFT scope — which is the only place a pull commit ever exists,
  // and exactly where `allowSquashDrilldown` is false.
  const isPull = isPullCommit(commit.kind)
  const drilldownable = isPull ? squashed >= 1 : allowSquashDrilldown && squashed > 1
  const showProvenance = isPull ? squashed >= 1 : squashed > 1
  const [showSquashed, setShowSquashed] = useState(false)
  // Only fetch the diff once the row is opened (immutable commit → long staleTime).
  const summaryQ = useCommitDiffSummary(wsId, graphId, expanded ? commitId : null)
  const fetchChildren = useCallback(
    (key: string, offset: number) => getCommitDiffChildren(wsId, graphId, commitId, key, { offset, limit: 50 }),
    [wsId, graphId, commitId],
  )

  const Item = asItem
  return (
    <Item className="relative" {...(asItem === 'div' ? { role: 'listitem' } : {})}>
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
          <span className="flex items-center gap-1 shrink-0">
            <StatChips stats={stats} />
            {showMenu && (
              /* modal={false}: this list lives in polling/self-refreshing panels — the
                 documented guard against the Radix body pointer-events freeze. */
              <DropdownMenu.Root modal={false} onOpenChange={setMenuOpen}>
                <DropdownMenu.Trigger asChild>
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label="Revision actions"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                    className="p-1 rounded-md text-ink-muted/40 hover:text-ink-muted hover:bg-black/[0.05] dark:hover:bg-white/[0.06] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/50 data-[state=open]:text-ink-muted data-[state=open]:bg-black/[0.05] dark:data-[state=open]:bg-white/[0.06] cursor-pointer"
                  >
                    <MoreHorizontal className="w-3.5 h-3.5" />
                  </span>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="end"
                    sideOffset={4}
                    className="z-[9999] w-64 p-1 bg-canvas border border-glass-border rounded-xl shadow-xl animate-in fade-in slide-in-from-top-1 duration-100"
                  >
                    {revision && (
                      <RevisionMenuItems
                        seq={seq}
                        atHead={atHead}
                        plan={plan}
                        actions={revision}
                      />
                    )}
                    {revision && showRollbackMenu && <DropdownMenu.Separator className="my-1 h-px bg-glass-border" />}
                    {onRevert && !isGenesis && (
                      <DropdownMenu.Item
                        onSelect={() => onRevert(commit)}
                        className="flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-[13px] text-ink cursor-pointer outline-none data-[highlighted]:bg-rose-500/[0.08]"
                      >
                        <Undo2 className="w-4 h-4 mt-0.5 shrink-0 text-rose-500" />
                        <span className="min-w-0">
                          <span className="block font-medium">Undo just this change</span>
                          <span className="block text-[11px] text-ink-muted leading-snug">Later changes are kept.</span>
                        </span>
                      </DropdownMenu.Item>
                    )}
                    {onRestore && (
                      <DropdownMenu.Item
                        onSelect={() => onRestore(commit)}
                        className="flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-[13px] text-ink cursor-pointer outline-none data-[highlighted]:bg-amber-500/[0.08]"
                      >
                        <History className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                        <span className="min-w-0">
                          <span className="block font-medium">Restore graph to here</span>
                          <span className="block text-[11px] text-ink-muted leading-snug">Rolls back everything after this revision.</span>
                        </span>
                      </DropdownMenu.Item>
                    )}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
          </span>
        </div>
        <p className="text-[11px] text-ink-muted mt-0.5 flex items-center gap-1.5 flex-wrap pl-5">
          <User className="w-3 h-3" /> {actorLabel(commit.actor, userNames)}
          {!inRun && <CommitProvenance commit={commit} apiKeyNames={apiKeyNames} />}
          {others.length > 0 && (
            <HoverTip className="inline-flex" label="Everyone who edited this revision">
              <span>
                · edits by {others.map((o) => ownerName(o, userNames)).join(', ')}
              </span>
            </HoverTip>
          )}
          <span>·</span>
          <span>{timeAgo(commit.created_at as string)}</span>
          {showProvenance && (
            drilldownable ? (
              <HoverTip
                className="inline-flex"
                label={isPull
                  ? 'Show the published changes that came into this draft'
                  : 'Show the draft save points folded into this publish'}
              >
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); setShowSquashed((v) => !v) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setShowSquashed((v) => !v) }
                }}
                className={cn(
                  'inline-flex items-center gap-1 px-1.5 py-0.5 rounded cursor-pointer transition-colors',
                  isPull
                    ? 'bg-teal-500/10 text-teal-600 dark:text-teal-400 hover:bg-teal-500/20'
                    : 'bg-accent-lineage/10 text-accent-lineage hover:bg-accent-lineage/20',
                )}
              >
                <ChevronRight className={cn('w-3 h-3 transition-transform', showSquashed && 'rotate-90')} />
                {isPull ? <ArrowDownToLine className="w-3 h-3" /> : <Layers className="w-3 h-3" />}
                {isPull
                  ? `${squashed} from Published`
                  : `merged ${squashed} commits`}
              </span>
              </HoverTip>
            ) : (
              <HoverTip className="inline-flex" label="Draft save points folded into this publish">
                <span className="px-1.5 py-0.5 rounded bg-ink/5 text-ink-muted">
                  merged {squashed} commits
                </span>
              </HoverTip>
            )
          )}
          {originatingViewLabel && (
            <HoverTip className="inline-flex" label="The view these changes were made from">
              <span className="px-1.5 py-0.5 rounded bg-ink/5 text-ink-muted">
                view {originatingViewLabel}
              </span>
            </HoverTip>
          )}
        </p>
      </button>
      {expanded && (
        <div className="mt-2 pl-5">
          {revision && !atHead && (
            <SinceThenLine
              loading={sinceQ.isLoading}
              revisions={sinceQ.data?.window?.commitCount ?? null}
              counts={sinceQ.data?.counts}
              onCompare={revision.onCompareWithNow}
            />
          )}
          <ChangeTreePanel
            summary={summaryQ.data}
            isLoading={summaryQ.isLoading}
            fetchChildren={fetchChildren}
            origin={{ source: 'commit', commitId }}
            emptyHint="No changes in this commit."
            summaryFirst
            list={published && typeof commit.commit_seq === 'number' && commit.commit_seq > 0
              ? { wsId, graphId, origin: { fromSeq: commit.commit_seq - 1, toSeq: commit.commit_seq } }
              : undefined}
          />
        </div>
      )}
      {drilldownable && showSquashed && (
        <div className="pl-5">
          <SquashedCommitList wsId={wsId} graphId={graphId} commitId={commitId} userNames={userNames}
            apiKeyNames={apiKeyNames} />
        </div>
      )}
    </Item>
  )
}

const MENU_ITEM = 'flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-[13px] text-ink cursor-pointer outline-none data-[highlighted]:bg-indigo-500/[0.08] data-[disabled]:opacity-50 data-[disabled]:cursor-default'

/** Open, compare, link: what a revision of Published offers from its menu. */
function RevisionMenuItems({ seq, atHead, plan, actions }: {
  seq: number | null
  atHead: boolean
  plan: { data?: { openable: boolean; reason?: string | null; changedSince: number; limit: number }; isLoading: boolean }
  actions: RevisionRowActions
}) {
  const blocked = atHead ? 'This is Published as it is now.'
    : actions.openBlocked ? actions.openBlocked
    : plan.data && !plan.data.openable
      ? plan.data.reason === 'fork'
        ? "A fork's past revisions can't be opened yet — compare it instead."
        : `Too far back to draw: more than ${compactCount.format(plan.data.limit)} changes since. Compare it instead.`
      : null
  return (
    <>
      <DropdownMenu.Item
        disabled={!!blocked || plan.isLoading || seq == null}
        onSelect={actions.onOpen}
        className={MENU_ITEM}
      >
        {plan.isLoading ? <Loader2 className="w-4 h-4 mt-0.5 shrink-0 animate-spin text-indigo-500" />
          : <Eye className="w-4 h-4 mt-0.5 shrink-0 text-indigo-500" />}
        <span className="min-w-0">
          <span className="block font-medium">Open on canvas</span>
          <span className="block text-[11px] text-ink-muted leading-snug">
            {blocked ?? (plan.isLoading ? 'Checking what opening it takes…'
              : plan.data && plan.data.changedSince > 0
                ? `The graph as it was — ${compactCount.format(plan.data.changedSince)} changes ago. Read-only.`
                : 'The graph as it was then. Read-only.')}
          </span>
        </span>
      </DropdownMenu.Item>
      <DropdownMenu.Item disabled={atHead} onSelect={actions.onCompareWithNow} className={MENU_ITEM}>
        <GitCompareArrows className="w-4 h-4 mt-0.5 shrink-0 text-indigo-500" />
        <span className="min-w-0">
          <span className="block font-medium">Compare with now</span>
          <span className="block text-[11px] text-ink-muted leading-snug">Everything that changed since this revision.</span>
        </span>
      </DropdownMenu.Item>
      <DropdownMenu.Item onSelect={actions.onCompareWith} className={MENU_ITEM}>
        <GitCompareArrows className="w-4 h-4 mt-0.5 shrink-0 text-ink-muted" />
        <span className="min-w-0">
          <span className="block font-medium">Compare with…</span>
          <span className="block text-[11px] text-ink-muted leading-snug">Pick another revision in the list.</span>
        </span>
      </DropdownMenu.Item>
      <DropdownMenu.Item onSelect={actions.onCopyLink} className={MENU_ITEM}>
        <Link2 className="w-4 h-4 mt-0.5 shrink-0 text-ink-muted" />
        <span className="min-w-0">
          <span className="block font-medium">Copy link</span>
          <span className="block text-[11px] text-ink-muted leading-snug">Opens the graph as it was at this revision.</span>
        </span>
      </DropdownMenu.Item>
    </>
  )
}

/** "Since then: 32 revisions · +1.2k ~340 −12 · Compare with now" — under an opened past revision. */
function SinceThenLine({ loading, revisions, counts, onCompare }: {
  loading: boolean
  revisions: number | null
  counts?: { added: number; modified: number; removed: number }
  onCompare: () => void
}) {
  return (
    <div className="mb-2 flex items-center gap-2 rounded-lg border border-indigo-500/15 bg-indigo-500/[0.04] px-2.5 py-1.5 text-[11px] text-ink-muted">
      <History className="w-3.5 h-3.5 shrink-0 text-indigo-500" />
      <span className="font-medium text-ink/80">Since then</span>
      {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : (
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          {revisions != null && <span>{revisions} {revisions === 1 ? 'revision' : 'revisions'}</span>}
          {counts && (
            <>
              <span className="text-ink-muted/50">·</span>
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold">+{compactCount.format(counts.added)}</span>
              <span className="text-amber-600 dark:text-amber-400 font-semibold">~{compactCount.format(counts.modified)}</span>
              <span className="text-rose-600 dark:text-rose-400 font-semibold">−{compactCount.format(counts.removed)}</span>
            </>
          )}
        </span>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onCompare() }}
        className="ml-auto inline-flex items-center gap-1 font-semibold text-indigo-700 dark:text-indigo-300 hover:underline"
      >
        Compare with now <ArrowRight className="w-3 h-3" />
      </button>
    </div>
  )
}
