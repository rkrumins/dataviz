/**
 * ChangeMap — what a review changes, drawn: every entity changed, every relationship added,
 * removed, edited or reversed, and the entities they hang off (faded, unchanged) — so a reader
 * sees WHERE the changes sit, not only a list of them.
 *
 * Colour is the change (emerald added, amber edited, rose removed, as on the canvas); a dashed
 * line is not saved yet, a solid one is saved on the draft. Loaded only when the Map is opened
 * (React.lazy), so Review & Save opens as fast as before. Capped at {@link MAX_NODES} entities.
 */
import { memo, useMemo, useState } from 'react'
import dagre from 'dagre'
import { ReactFlow, ReactFlowProvider, Handle, Position, MarkerType, type Node, type Edge, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ArrowUpRight, ListTree } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useEntityColorSet } from '@/hooks/useEntityVisual'
import type { ChangeSet, ChangeStatus } from '../model/changeModel'
import type { ReviewGroup, Sentence } from '../model/reviewModel'
import { STATUS_META } from './NodeDiffBadge'

/** More than this is a list's job, not a picture's. */
export const MAX_NODES = 200

const STROKE: Record<ChangeStatus, string> = { added: '#10b981', modified: '#f59e0b', removed: '#f43f5e' }
const NODE_W = 196
const NODE_H = 54

interface MapNodeData extends Record<string, unknown> {
  label: string
  status?: ChangeStatus
  typeId?: string
  /** Unchanged: shown for where the changes hang. */
  context: boolean
  saved: boolean
  selected: boolean
}

interface MapModel {
  nodes: Node<MapNodeData>[]
  edges: Edge[]
  total: number
  /** Group key → the group, for the selection card. */
  byKey: Map<string, ReviewGroup>
}

const text = (s: Sentence) => s.map((p) => (typeof p === 'string' ? p : p.name)).join('')

function build(groups: readonly ReviewGroup[], saved: ChangeSet | null, nameOf: (id: string) => string, selected: string | null): MapModel {
  const nodes = new Map<string, MapNodeData>()
  const edges: Edge[] = []
  const byKey = new Map<string, ReviewGroup>()
  const put = (id: string, d: Partial<MapNodeData>) => {
    const was = nodes.get(id)
    // A changed entity outranks the same one drawn as context.
    if (was && !was.context && d.context) return
    nodes.set(id, { label: nameOf(id), context: true, saved: false, selected: false, ...was, ...d })
  }
  const link = (id: string, source: string, target: string, status: ChangeStatus, isSaved: boolean, label?: string) => {
    put(source, { context: true })
    put(target, { context: true })
    edges.push({
      id, source, target, label,
      style: { stroke: STROKE[status], strokeWidth: 2, strokeDasharray: isSaved ? undefined : '6 4' },
      labelStyle: { fontSize: 10, fontWeight: 600, fill: STROKE[status] },
      labelBgStyle: { fill: 'var(--nx-bg-elevated)' },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
      markerEnd: { type: MarkerType.ArrowClosed, color: STROKE[status], width: 16, height: 16 },
    })
  }

  for (const g of groups) {
    if (g.kind === 'layout') continue
    byKey.set(g.key, g)
    if (g.kind === 'node') {
      put(g.key, { label: g.name, status: g.status, typeId: g.typeId, context: false, saved: false })
      for (const c of g.changes) {
        const after = (c.after ?? {}) as Record<string, unknown>
        if (c.type === 'create_entity' && typeof after.parentUrn === 'string') {
          link(`contain:${c.id}`, after.parentUrn, g.key, 'added', false)
        } else if (c.type === 'move_entity' && typeof after.parentId === 'string') {
          link(`move:${c.id}`, after.parentId, g.key, 'modified', false, 'moved here')
        }
      }
    } else {
      const c = g.changes[g.changes.length - 1]
      const a = (c.after ?? {}) as Record<string, unknown>
      const b = (c.before ?? {}) as Record<string, unknown>
      const e = (c.type === 'create_edge' ? a : (b.edge ?? b)) as Record<string, unknown>
      const source = typeof e.source === 'string' ? e.source : undefined
      const target = typeof e.target === 'string' ? e.target : undefined
      if (!source || !target) continue
      const [s, t] = c.type === 'reverse_edge' ? [target, source] : [source, target]
      link(`edge:${g.key}`, s, t, g.status, false, typeof a.edgeType === 'string' ? a.edgeType : undefined)
    }
  }

  for (const ch of saved?.changes ?? []) {
    if (ch.kind === 'node') {
      const id = ch.urn ?? ch.entityId
      // A slim diff names a changed entity by its id: the canvas's name for it reads better.
      const label = nameOf(id) !== id ? nameOf(id) : ch.label
      if (!nodes.has(id) || nodes.get(id)!.context) put(id, { label, status: ch.status, context: false, saved: true })
    } else if (ch.sourceUrn && ch.targetUrn) {
      link(`saved:${ch.entityId}`, ch.sourceUrn, ch.targetUrn, ch.status, true)
    }
  }

  const total = nodes.size
  const kept = new Set([...nodes.keys()].slice(0, MAX_NODES))
  const shownEdges = edges.filter((e) => kept.has(e.source) && kept.has(e.target))

  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 18, ranksep: 70, marginx: 10, marginy: 10 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const id of kept) g.setNode(id, { width: NODE_W, height: NODE_H })
  for (const e of shownEdges) g.setEdge(e.source, e.target)
  dagre.layout(g)

  return {
    nodes: [...kept].map((id) => {
      const p = g.node(id)
      return {
        id, type: 'change', position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 },
        data: { ...nodes.get(id)!, selected: id === selected },
        draggable: false, connectable: false,
      }
    }),
    edges: shownEdges,
    total,
    byKey,
  }
}

const ChangeNode = memo(function ChangeNode({ data }: NodeProps<Node<MapNodeData>>) {
  const colors = useEntityColorSet(data.typeId ?? '')
  const meta = data.status ? STATUS_META[data.status] : null
  return (
    <div
      className={cn(
        'w-[196px] h-[54px] rounded-xl border px-2.5 py-1.5 flex items-center gap-2 bg-canvas-elevated shadow-sm transition-shadow',
        data.context ? 'opacity-55 border-glass-border border-dashed' : 'border-2',
        data.selected && 'ring-2 ring-accent-lineage/50 shadow-lg',
      )}
      style={!data.context && data.status ? { borderColor: STROKE[data.status], borderStyle: data.saved ? 'solid' : 'dashed' } : undefined}
    >
      <Handle type="target" position={Position.Left} className="!opacity-0 !w-1 !h-1" />
      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: data.typeId ? colors.hex : 'currentColor', opacity: data.typeId ? 1 : 0.3 }} />
      <span className="min-w-0 flex-1">
        <span className="block text-[11.5px] font-semibold text-ink truncate">{data.label}</span>
        <span className={cn('block text-[10px] font-medium truncate', meta ? meta.text : 'text-ink-muted')}>
          {meta ? `${meta.label}${data.saved ? ' · saved' : ''}` : 'Unchanged'}
        </span>
      </span>
      <Handle type="source" position={Position.Right} className="!opacity-0 !w-1 !h-1" />
    </div>
  )
})

const nodeTypes = { change: ChangeNode }

export default function ChangeMap({ groups, saved = null, nameOf, onShowInList, onReveal }: {
  /** The staged changes, as Review & Save groups them. */
  groups: readonly ReviewGroup[]
  /** What the draft already has saved (drawn solid). */
  saved?: ChangeSet | null
  nameOf: (id: string) => string
  /** Open this group in the List. */
  onShowInList?: (key: string) => void
  /** Show this entity on the canvas. */
  onReveal?: (id: string) => void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const model = useMemo(() => build(groups, saved, nameOf, selected), [groups, saved, nameOf, selected])
  const group = selected ? model.byKey.get(selected) : undefined

  if (model.nodes.length === 0) {
    return <p className="py-16 text-center text-sm text-ink-muted">Nothing to draw — these changes are to the view’s layout only.</p>
  }

  return (
    <div className="relative h-[min(52vh,460px)] rounded-2xl border border-glass-border bg-black/[0.015] dark:bg-white/[0.02] overflow-hidden">
      <ReactFlowProvider>
        <ReactFlow
          nodes={model.nodes}
          edges={model.edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
          minZoom={0.2}
          nodesDraggable={false}
          nodesConnectable={false}
          onNodeClick={(_, n) => setSelected((s) => (s === n.id ? null : n.id))}
          onPaneClick={() => setSelected(null)}
          proOptions={{ hideAttribution: true }}
          style={{ background: 'transparent' }}
        />
      </ReactFlowProvider>

      {/* Legend */}
      <div className="absolute top-2.5 left-2.5 flex flex-wrap items-center gap-2 px-2.5 py-1.5 rounded-lg bg-canvas-elevated/90 border border-glass-border text-[10.5px] text-ink-secondary shadow-sm">
        {(['added', 'modified', 'removed'] as const).map((s) => (
          <span key={s} className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ backgroundColor: STROKE[s] }} />{STATUS_META[s].label}</span>
        ))}
        <span className="flex items-center gap-1"><span className="w-4 border-t-2 border-dashed border-ink-muted" />not saved</span>
        {saved && saved.changes.length > 0 && <span className="flex items-center gap-1"><span className="w-4 border-t-2 border-ink-muted" />saved on draft</span>}
      </div>
      {model.total > MAX_NODES && (
        <p className="absolute top-2.5 right-2.5 px-2 py-1 rounded-lg bg-canvas-elevated/90 border border-glass-border text-[10.5px] text-ink-muted">
          Showing {MAX_NODES} of {model.total.toLocaleString()} — the List has them all
        </p>
      )}

      {group && (
        <div className="absolute bottom-2.5 inset-x-2.5 flex items-center gap-3 px-3 py-2 rounded-xl bg-canvas-elevated border border-glass-border shadow-lg">
          <p className="flex-1 min-w-0 text-xs text-ink truncate">{text(group.sentence)}</p>
          {onShowInList && (
            <button type="button" onClick={() => onShowInList(group.key)}
              className="flex items-center gap-1 px-2 h-7 rounded-lg text-[11px] font-semibold text-ink-secondary hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/10">
              <ListTree className="w-3.5 h-3.5" aria-hidden />Show in list
            </button>
          )}
          {onReveal && group.revealId && (
            <button type="button" onClick={() => onReveal(group.revealId!)}
              className="flex items-center gap-1 px-2 h-7 rounded-lg text-[11px] font-semibold text-accent-lineage hover:bg-accent-lineage/10">
              Show on canvas<ArrowUpRight className="w-3.5 h-3.5" aria-hidden />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
