/**
 * ChangeTreePanel — the hierarchical, lazy-loaded view of "what changed", built for a
 * business reader: an impact summary header ("2 datasets · 17 tables · 40 columns affected")
 * over a containment tree where each change sits under its real container. Expanding a
 * container loads its direct children on demand (bounded, paged), so a draft touching
 * thousands of entities stays a handful of rows until you drill in. Every change — a leaf, or a
 * container's own — reads as one line until opened, then its key differences, then all of them
 * (the same `EntityDiff` the flat ChangesPanel uses).
 */
import { useMemo, useState } from 'react'
import { ChevronRight, Loader2, AlertCircle, Folder, Boxes, Spline, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChangeOrigin } from '../model/changeModel'
import { changeListExportUrl, type ChangeListOrigin, type DiffSummaryResponse, type DiffTreeNode } from '@/services/versioningApiService'
import { triggerBrowserDownload } from '@/services/importExportApiService'
import { ChangeList } from './ChangeList'
import { ExportMenu } from './ExportMenu'
import { STATUS_META, NodeDiffBadge } from './NodeDiffBadge'
import { EntityDiff } from './EntityDiff'
import { ChangeSummary } from './ChangeSummary'
import { fieldsOfChange, summarizeFields } from '../model/fieldDiff'
import { entityTypeStyle } from '@/components/canvas/property-manager/entityTypeStyles'
import { treeLeafToChange } from '../model/changeTreeModel'
import { useChangeTreeExpansion, type FetchChildren } from '../hooks/useChangeTreeExpansion'

const pluralize = (type: string, n: number) => (n === 1 || /s$/i.test(type) ? type : `${type}s`)

function CountBadges({ counts }: { counts: { added: number; modified: number; removed: number } }) {
  return (
    <span className="inline-flex items-center gap-1 shrink-0">
      {counts.added > 0 && <NodeDiffBadge status="added" count={counts.added} />}
      {counts.modified > 0 && <NodeDiffBadge status="modified" count={counts.modified} />}
      {counts.removed > 0 && <NodeDiffBadge status="removed" count={counts.removed} />}
    </span>
  )
}

const sumCounts = (c?: { added: number; modified: number; removed: number }) =>
  c ? c.added + c.modified + c.removed : 0

/** At-a-glance scope of the change, split into the two dimensions the user cares about: ENTITIES
 *  (nodes — with the per-type rollup "17 tables · 40 columns") and RELATIONSHIPS (edges). Each line
 *  carries its own add/modify/remove badges so it's immediately clear what changed and how. */
function ImpactHeader({ summary }: { summary: DiffSummaryResponse }) {
  const items = useMemo(
    () => Object.entries(summary.impact).sort((a, b) => b[1] - a[1]),
    [summary.impact],
  )
  const total = summary.counts.added + summary.counts.modified + summary.counts.removed
  const entityTotal = sumCounts(summary.entityCounts)
  const edgeTotal = sumCounts(summary.edgeCounts)
  const hasSplit = entityTotal > 0 || edgeTotal > 0
  return (
    <div className="rounded-xl border border-glass-border bg-canvas-elevated/40 px-3.5 py-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-ink-muted uppercase tracking-wider">
          {total} change{total === 1 ? '' : 's'}
        </span>
        <CountBadges counts={summary.counts} />
      </div>

      {entityTotal > 0 && (
        <div className="flex items-center gap-x-2 gap-y-1 flex-wrap text-[12px] text-ink-muted">
          <span className="inline-flex items-center gap-1 font-medium text-ink">
            <Boxes className="w-3.5 h-3.5 text-ink-muted" />
            <span className="tabular-nums">{entityTotal}</span> {entityTotal === 1 ? 'entity' : 'entities'}
          </span>
          <CountBadges counts={summary.entityCounts!} />
          {items.map(([type, n]) => (
            <span key={type} className="inline-flex items-center gap-1.5">
              <span className="text-ink-muted/40">·</span>
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: entityTypeStyle(type).ring }} />
              <span className="tabular-nums text-ink">{n}</span> {pluralize(type, n)}
            </span>
          ))}
        </div>
      )}

      {edgeTotal > 0 && (
        <div className="flex items-center gap-x-2 gap-y-1 flex-wrap text-[12px] text-ink-muted">
          <span className="inline-flex items-center gap-1 font-medium text-ink">
            <Spline className="w-3.5 h-3.5 text-ink-muted" />
            <span className="tabular-nums">{edgeTotal}</span> {edgeTotal === 1 ? 'relationship' : 'relationships'}
          </span>
          <CountBadges counts={summary.edgeCounts!} />
        </div>
      )}

      {/* Back-compat: an older payload without the entity/edge split → legacy entityType line. */}
      {!hasSplit && items.length > 0 && (
        <div className="flex items-center gap-x-2.5 gap-y-1 flex-wrap text-[12px] text-ink-muted">
          {items.map(([type, n], i) => (
            <span key={type} className="inline-flex items-center gap-1.5">
              {i > 0 && <span className="text-ink-muted/40">·</span>}
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: entityTypeStyle(type).ring }} />
              <span className="tabular-nums text-ink">{n}</span> {pluralize(type, n)}
            </span>
          ))}
          <span className="text-ink-muted/70">affected</span>
        </div>
      )}
    </div>
  )
}

function Indent({ depth }: { depth: number }) {
  return depth > 0 ? <span style={{ width: depth * 14 }} className="shrink-0" aria-hidden /> : null
}

function LeafRow({ node, depth, origin }: { node: DiffTreeNode; depth: number; origin: ChangeOrigin }) {
  // Closed, a summary; open, the key differences; then all of them.
  const [level, setLevel] = useState<0 | 1 | 2>(0)
  const open = level > 0
  const status = node.status && node.status !== 'unchanged' ? node.status : 'modified'
  const meta = STATUS_META[status]
  const change = useMemo(() => treeLeafToChange(node, origin), [node, origin])
  const summary = useMemo(() => summarizeFields(fieldsOfChange(change)), [change])
  return (
    <div className={cn('rounded-lg border-l-2 bg-canvas-overlay/40', meta.accent)}>
      <button onClick={() => setLevel((l) => (l === 0 ? 1 : 0))} aria-expanded={open}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left group">
        <Indent depth={depth} />
        <ChevronRight className={cn('w-3.5 h-3.5 text-ink-muted/60 transition-transform shrink-0', open && 'rotate-90')} />
        <meta.Icon className={cn('w-3.5 h-3.5 shrink-0', meta.text)} />
        {node.entityKind === 'edge' ? (
          <Spline className="w-3.5 h-3.5 shrink-0 text-ink-muted/70" />
        ) : node.entityType ? (
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: entityTypeStyle(node.entityType).ring }} />
        ) : null}
        <span className="min-w-0 flex-1 flex items-baseline gap-2">
          <span className="text-sm text-ink truncate">{node.label}</span>
          <ChangeSummary summary={summary} status={status} kind={node.entityKind === 'edge' ? 'edge' : 'node'} className="min-w-0" />
        </span>
      </button>
      {open && (
        <div className="px-2.5 pb-2" style={{ paddingLeft: depth * 14 + 28 }}>
          <EntityDiff change={change} depth={level === 1 ? 'key' : 'all'} onShowAll={() => setLevel(2)} />
        </div>
      )}
    </div>
  )
}

/** A container's own change, at the top of what it holds: one line saying what changed, opened
 *  on demand to its key differences, then to all of them — as each change inside it reads. */
function OwnChange({ change, depth, kind }: { change: ReturnType<typeof treeLeafToChange>; depth: number; kind: 'node' | 'edge' }) {
  const [level, setLevel] = useState<0 | 1 | 2>(0)
  const open = level > 0
  const summary = useMemo(() => summarizeFields(fieldsOfChange(change)), [change])
  return (
    <div className="pr-2.5 pb-1" style={{ paddingLeft: depth * 14 + 28 }}>
      <button onClick={() => setLevel((l) => (l === 0 ? 1 : 0))} aria-expanded={open}
        className="w-full flex items-center gap-1.5 py-1 text-left rounded-md hover:bg-black/[0.02] dark:hover:bg-white/[0.03]">
        <ChevronRight className={cn('w-3.5 h-3.5 text-ink-muted/60 transition-transform shrink-0', open && 'rotate-90')} />
        <span className="text-[12px] font-medium text-ink-secondary shrink-0">Its own change</span>
        <ChangeSummary summary={summary} status={change.status} kind={kind} className="min-w-0" />
      </button>
      {open && (
        <div className="pl-5 pt-1">
          <EntityDiff change={change} depth={level === 1 ? 'key' : 'all'} onShowAll={() => setLevel(2)} />
        </div>
      )}
    </div>
  )
}

function GroupRow({
  node,
  depth,
  exp,
  origin,
}: {
  node: DiffTreeNode
  depth: number
  exp: ReturnType<typeof useChangeTreeExpansion>
  origin: ChangeOrigin
}) {
  const open = exp.expanded.has(node.key)
  const isLoading = exp.loading.has(node.key)
  const hasFailed = exp.failed.has(node.key)
  const st = exp.byKey[node.key]
  const changedSelf = !!(node.before || node.after) && node.status && node.status !== 'unchanged'
  const accent = node.deleted ? STATUS_META.removed.accent : 'border-l-glass-border/60'
  const selfChange = useMemo(
    () => (changedSelf ? treeLeafToChange(node, origin) : null),
    [changedSelf, node, origin],
  )

  return (
    <div className={cn('rounded-lg border-l-2 bg-canvas-overlay/30', accent)}>
      <button onClick={() => exp.toggle(node.key)} className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left group">
        <Indent depth={depth} />
        <ChevronRight className={cn('w-3.5 h-3.5 text-ink-muted/60 transition-transform shrink-0', open && 'rotate-90')} />
        {node.entityKind === 'edge' ? (
          <Spline className="w-3.5 h-3.5 shrink-0 text-ink-muted/70" />
        ) : (
          <Folder className={cn('w-3.5 h-3.5 shrink-0', node.deleted ? 'text-rose-500' : 'text-ink-muted/70')} />
        )}
        {node.entityType && node.kind === 'container' && (
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: entityTypeStyle(node.entityType).ring }} />
        )}
        <span className={cn('text-sm truncate flex-1', node.deleted ? 'text-rose-500 line-through' : 'text-ink')} title={node.label}>
          {node.label}
        </span>
        <CountBadges counts={node.counts} />
      </button>
      {open && (
        <div className="pb-1.5 space-y-1 pt-0.5">
          {selfChange && (
            <OwnChange change={selfChange} depth={depth} kind={node.entityKind === 'edge' ? 'edge' : 'node'} />
          )}
          {isLoading && !st && (
            <p className="flex items-center gap-1.5 text-[11px] text-ink-muted py-1.5" style={{ paddingLeft: depth * 14 + 28 }}>
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
            </p>
          )}
          {hasFailed && (
            <button
              onClick={() => exp.retry(node.key)}
              className="flex items-center gap-1.5 text-[11px] text-rose-500 py-1.5"
              style={{ paddingLeft: depth * 14 + 28 }}
            >
              <AlertCircle className="w-3.5 h-3.5" /> Failed to load — retry
            </button>
          )}
          {st?.entries.map((child) => (
            <TreeRow key={child.key} node={child} depth={depth + 1} exp={exp} origin={origin} />
          ))}
          {st && st.loaded < st.total && (
            <button
              onClick={() => exp.loadMore(node.key)}
              disabled={isLoading}
              className="text-[11px] text-accent-lineage hover:underline py-1 disabled:opacity-60"
              style={{ paddingLeft: depth * 14 + 28 }}
            >
              {isLoading ? 'Loading…' : `Show ${Math.min(exp.pageSize, st.total - st.loaded)} more of ${st.total - st.loaded} remaining`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function TreeRow(props: {
  node: DiffTreeNode
  depth: number
  exp: ReturnType<typeof useChangeTreeExpansion>
  origin: ChangeOrigin
}) {
  return props.node.kind === 'leaf' ? (
    <LeafRow node={props.node} depth={props.depth} origin={props.origin} />
  ) : (
    <GroupRow {...props} />
  )
}

export function ChangeTreePanel({
  summary,
  isLoading,
  error,
  onRetry,
  fetchChildren,
  origin,
  emptyHint = 'No changes yet.',
  className,
  summaryFirst = false,
  list,
}: {
  summary?: DiffSummaryResponse
  isLoading?: boolean
  /** The summary could not be read (a timeout, a busy server): said as such — never as "no changes". */
  error?: unknown
  onRetry?: () => void
  fetchChildren: FetchChildren
  origin: ChangeOrigin
  emptyHint?: string
  className?: string
  /** The same changes as a change list, which lists them a page at a time once they are too many
   *  to lay out as a tree. Without it, a set that large is counted and not listed. */
  list?: { wsId: string; graphId: string; origin: ChangeListOrigin }
  /** Show only the impact summary, with the detail tree behind a toggle (the cumulative branch
   *  view). Off for already-drilled-in contexts like a single commit's diff. */
  summaryFirst?: boolean
}) {
  const exp = useChangeTreeExpansion(fetchChildren)
  // Summary-first: the impact header always shows; the per-entity detail tree is revealed on demand
  // so a large change set reads as a glanceable summary, not a wall of rows. `null` = auto (small
  // sets open, large sets collapsed); once the user toggles, their choice sticks.
  const [treeOpen, setTreeOpen] = useState<boolean | null>(null)

  if (isLoading && !summary) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-muted py-8 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" /> Computing changes…
      </div>
    )
  }
  if (error && !summary) {
    // What failed, a way to try again, and — where one exists — the same changes a page at a time,
    // which reads them from the change index and not the tree.
    return (
      <div className={cn('space-y-2.5', className)}>
        <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-3.5 py-3 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-semibold text-ink">Couldn’t lay these changes out as a tree</p>
            <p className="text-[11.5px] text-ink-muted mt-0.5 leading-relaxed">
              {list ? 'They are listed below, a page at a time.' : 'The server took too long or was busy.'}
            </p>
          </div>
          {onRetry && (
            <button type="button" onClick={onRetry}
              className="shrink-0 inline-flex items-center gap-1 px-2 h-7 rounded-lg text-[11.5px] font-semibold text-ink-secondary hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08]">
              <RefreshCw className="w-3.5 h-3.5" aria-hidden /> Try again
            </button>
          )}
        </div>
        {list && <ChangeList wsId={list.wsId} graphId={list.graphId} origin={list.origin} emptyHint={emptyHint} />}
      </div>
    )
  }
  if (summary?.tooLarge) {
    // Counted, but too many to lay out as a tree: listed a page at a time instead, where a list of
    // the same changes exists.
    return (
      <div className={cn('space-y-2.5', className)}>
        <ImpactHeader summary={summary} />
        {list ? (
          <ChangeList wsId={list.wsId} graphId={list.graphId} origin={list.origin} emptyHint={emptyHint} />
        ) : (
          <p className="text-[12px] text-ink-muted px-1">
            {summary.tooLarge.changed.toLocaleString()} entities changed — too many to lay out here.
          </p>
        )}
      </div>
    )
  }
  if (!summary || summary.groups.length === 0) {
    return <div className="py-10 text-center"><p className="text-sm text-ink-muted">{emptyHint}</p></div>
  }

  const totalChanges = summary.counts.added + summary.counts.modified + summary.counts.removed
  // summaryFirst: small sets auto-expand, larger ones collapse to the summary until toggled.
  const isOpen = !summaryFirst || (treeOpen ?? totalChanges <= 6)

  return (
    <div className={cn('space-y-2.5', className)}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0"><ImpactHeader summary={summary} /></div>
        {/* The same changes as a list exist: they export as CSV, streamed by the server. */}
        {list && (
          <ExportMenu count={totalChanges} onExport={(detail) => triggerBrowserDownload(
            changeListExportUrl(list.wsId, list.graphId, list.origin, {}, detail),
            `changes${detail === 'properties' ? '-properties' : ''}.csv`)} />
        )}
      </div>
      {summaryFirst && (
        <button
          onClick={() => setTreeOpen(!isOpen)}
          className="w-full flex items-center gap-1.5 px-1 py-1 text-[12px] font-medium text-ink-muted hover:text-ink transition-colors"
          aria-expanded={isOpen}
        >
          <ChevronRight className={cn('w-3.5 h-3.5 transition-transform', isOpen && 'rotate-90')} />
          {isOpen ? 'Hide details' : `Show details — ${totalChanges} change${totalChanges === 1 ? '' : 's'}`}
        </button>
      )}
      {isOpen && (
        <div className="space-y-1.5">
          {summary.groups.map((g) => (
            <TreeRow key={g.key} node={g} depth={0} exp={exp} origin={origin} />
          ))}
          {summary.groupTotal > summary.groups.length && (
            <p className="text-[11px] text-ink-muted px-1 pt-1">
              Showing the first {summary.groups.length} of {summary.groupTotal} top-level groups.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
