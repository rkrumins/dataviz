/**
 * ChangeTreePanel — the hierarchical, lazy-loaded view of "what changed", built for a
 * business reader: an impact summary header ("2 datasets · 17 tables · 40 columns affected")
 * over a containment tree where each change sits under its real container. Expanding a
 * container loads its direct children on demand (bounded, paged), so a draft touching
 * thousands of entities stays a handful of rows until you drill in. Leaves expand to the
 * same `EntityDiff` the flat ChangesPanel uses.
 */
import { useMemo, useState } from 'react'
import { ChevronRight, Loader2, AlertCircle, Folder } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChangeOrigin } from '../model/changeModel'
import type { DiffSummaryResponse, DiffTreeNode } from '@/services/versioningApiService'
import { STATUS_META, NodeDiffBadge } from './NodeDiffBadge'
import { EntityDiff } from './EntityDiff'
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

/** "2 datasets · 17 tables · 40 columns affected" — the at-a-glance scope of the change. */
function ImpactHeader({ summary }: { summary: DiffSummaryResponse }) {
  const items = useMemo(
    () => Object.entries(summary.impact).sort((a, b) => b[1] - a[1]),
    [summary.impact],
  )
  const total = summary.counts.added + summary.counts.modified + summary.counts.removed
  return (
    <div className="rounded-xl border border-glass-border bg-canvas-elevated/40 px-3.5 py-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-ink-muted uppercase tracking-wider">
          {total} change{total === 1 ? '' : 's'}
        </span>
        <CountBadges counts={summary.counts} />
      </div>
      {items.length > 0 && (
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
  const [open, setOpen] = useState(false)
  const status = node.status && node.status !== 'unchanged' ? node.status : 'modified'
  const meta = STATUS_META[status]
  const change = useMemo(() => treeLeafToChange(node, origin), [node, origin])
  return (
    <div className={cn('rounded-lg border-l-2 bg-canvas-overlay/40', meta.accent)}>
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left group">
        <Indent depth={depth} />
        <ChevronRight className={cn('w-3.5 h-3.5 text-ink-muted/60 transition-transform shrink-0', open && 'rotate-90')} />
        <meta.Icon className={cn('w-3.5 h-3.5 shrink-0', meta.text)} />
        {node.entityType && (
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: entityTypeStyle(node.entityType).ring }} />
        )}
        <span className="text-sm text-ink truncate flex-1" title={node.label}>{node.label}</span>
      </button>
      {open && (
        <div className="px-2.5 pb-2" style={{ paddingLeft: depth * 14 + 28 }}>
          <EntityDiff change={change} />
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
        <Folder className={cn('w-3.5 h-3.5 shrink-0', node.deleted ? 'text-rose-500' : 'text-ink-muted/70')} />
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
            <div className="px-2.5 pb-1" style={{ paddingLeft: depth * 14 + 28 }}>
              <EntityDiff change={selfChange} />
            </div>
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
  fetchChildren,
  origin,
  emptyHint = 'No changes yet.',
  className,
}: {
  summary?: DiffSummaryResponse
  isLoading?: boolean
  fetchChildren: FetchChildren
  origin: ChangeOrigin
  emptyHint?: string
  className?: string
}) {
  const exp = useChangeTreeExpansion(fetchChildren)

  if (isLoading && !summary) {
    return (
      <div className="flex items-center gap-2 text-sm text-ink-muted py-8 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" /> Computing changes…
      </div>
    )
  }
  if (!summary || summary.groups.length === 0) {
    return <div className="py-10 text-center"><p className="text-sm text-ink-muted">{emptyHint}</p></div>
  }

  return (
    <div className={cn('space-y-3', className)}>
      <ImpactHeader summary={summary} />
      <div className="space-y-1.5">
        {summary.groups.map((g) => (
          <TreeRow key={g.key} node={g} depth={0} exp={exp} origin={origin} />
        ))}
        {summary.groupTotal > summary.groups.length && (
          <p className="text-[11px] text-ink-muted px-1 pt-1">
            Showing {summary.groups.length} of {summary.groupTotal} groups — refine in a draft to narrow the change set.
          </p>
        )}
      </div>
    </div>
  )
}
