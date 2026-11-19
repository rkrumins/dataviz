/**
 * ChangeMap — what a review changes, drawn: every entity changed, every relationship added,
 * removed, edited or reversed, and the entities they hang off (faded, unchanged) — so a reader
 * sees WHERE the changes sit, not only a list of them.
 *
 * Colour is the change (emerald added, amber edited, rose removed, as on the canvas); a dashed
 * line is not saved yet, a solid one is saved on the draft. Loaded only when the Map is opened
 * (React.lazy), so Review & Save opens as fast as before.
 *
 * Up to {@link MAX_NODES} entities are drawn one by one. Past that, the changes are drawn as
 * clusters — one per type and kind of change, with how many, and the relationships between them
 * summed — plus the selected change and what it links to; a cluster opens the List on just those.
 * The layout is worked out once per set of changes: selecting is styling, not a new layout.
 */
import { memo, useMemo, useState } from 'react'
import dagre from 'dagre'
import { ReactFlow, ReactFlowProvider, Handle, Position, MarkerType, type Node, type Edge, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ArrowUpRight, ListFilter, ListTree } from 'lucide-react'
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
  /** A cluster: how many changes it stands for. */
  count?: number
}

interface MapModel {
  nodes: Node<MapNodeData>[]
  edges: Edge[]
  total: number
  /** Group key → the group, for the selection card. */
  byKey: Map<string, ReviewGroup>
}

const text = (s: Sentence) => s.map((p) => (typeof p === 'string' ? p : p.name)).join('')

/** An edge change's ends, as Review & Save staged it (a reversal drawn the way it will run). */
function edgeEnds(g: ReviewGroup): { source: string; target: string; type?: string } | null {
  const c = g.changes[g.changes.length - 1]
  const a = (c.after ?? {}) as Record<string, unknown>
  const b = (c.before ?? {}) as Record<string, unknown>
  const e = (c.type === 'create_edge' ? a : (b.edge ?? b)) as Record<string, unknown>
  const source = typeof e.source === 'string' ? e.source : undefined
  const target = typeof e.target === 'string' ? e.target : undefined
  if (!source || !target) return null
  const [s, t] = c.type === 'reverse_edge' ? [target, source] : [source, target]
  return { source: s, target: t, type: typeof a.edgeType === 'string' ? a.edgeType : undefined }
}

const edgeStyle = (status: ChangeStatus, isSaved: boolean, width = 2) => ({
  style: { stroke: STROKE[status], strokeWidth: width, strokeDasharray: isSaved ? undefined : '6 4' },
  labelStyle: { fontSize: 10, fontWeight: 600, fill: STROKE[status] },
  labelBgStyle: { fill: 'var(--nx-bg-elevated)' },
  labelBgPadding: [4, 2] as [number, number],
  labelBgBorderRadius: 4,
  // A marker scales with the stroke: kept the same size on a thick summed link.
  markerEnd: { type: MarkerType.ArrowClosed, color: STROKE[status], width: 32 / width, height: 32 / width },
})

function layout(ids: Iterable<string>, edges: readonly Edge[]): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 18, ranksep: 70, marginx: 10, marginy: 10 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const id of ids) g.setNode(id, { width: NODE_W, height: NODE_H })
  for (const e of edges) g.setEdge(e.source, e.target)
  dagre.layout(g)
  const out = new Map<string, { x: number; y: number }>()
  for (const id of g.nodes()) {
    const p = g.node(id)
    out.set(id, { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 })
  }
  return out
}

const toFlow = (data: Map<string, MapNodeData>, pos: Map<string, { x: number; y: number }>): Node<MapNodeData>[] =>
  [...data].map(([id, d]) => ({ id, type: 'change', position: pos.get(id) ?? { x: 0, y: 0 }, data: d, draggable: false, connectable: false }))

function build(groups: readonly ReviewGroup[], saved: ChangeSet | null, nameOf: (id: string) => string): MapModel {
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
    edges.push({ id, source, target, label, ...edgeStyle(status, isSaved) })
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
      const ends = edgeEnds(g)
      if (ends) link(`edge:${g.key}`, ends.source, ends.target, g.status, false, ends.type)
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

  // Too many to draw one by one: the caller clusters them instead.
  if (nodes.size > MAX_NODES) return { nodes: [], edges: [], total: nodes.size, byKey }
  return { nodes: toFlow(nodes, layout(nodes.keys(), edges)), edges, total: nodes.size, byKey }
}

const STATUS_WORD: Record<ChangeStatus, string> = { added: 'added', modified: 'edited', removed: 'removed' }

/** Cluster columns, left to right: what the save adds, edits, removes; what the draft has saved;
 *  the unchanged entities the changes link to; and the selected change drawn one by one. */
const COLUMN: Record<string, number> = { added: 0, modified: 1, removed: 2, saved: 3, context: 4, near: 5 }
const COLUMN_LABEL = ['Added', 'Edited', 'Removed', 'Saved on the draft', 'Linked, unchanged', 'Selected']

/**
 * Past {@link MAX_NODES}: one node per type × kind of change (saved changes on their own, the
 * unchanged entities the changes link to as one), laid out as a matrix — a column per kind of
 * change, a row per type — with the relationships between them summed; and, drawn one by one, the
 * selected entity and the entities its staged relationships reach.
 */
function clusters(groups: readonly ReviewGroup[], saved: ChangeSet | null, nameOf: (id: string) => string, selected: ReviewGroup | undefined): MapModel {
  const data = new Map<string, MapNodeData>()
  const clusterOf = new Map<string, string>()
  const byKey = new Map<string, ReviewGroup>()
  const add = (entity: string, cid: string, d: () => MapNodeData) => {
    clusterOf.set(entity, cid)
    const was = data.get(cid)
    if (was) was.count = (was.count ?? 0) + 1
    else data.set(cid, { ...d(), count: 1 })
  }
  for (const g of groups) {
    if (g.kind !== 'node') continue
    byKey.set(g.key, g)
    const t = g.typeId ?? ''
    add(g.key, `cluster:${t}|${g.status}`, () => ({ label: t || 'Untyped', typeId: g.typeId, status: g.status, context: false, saved: false, selected: false }))
  }
  for (const ch of saved?.changes ?? []) {
    const id = ch.urn ?? ch.entityId
    if (ch.kind !== 'node' || clusterOf.has(id)) continue
    add(id, `cluster:saved|${ch.status}`, () => ({ label: 'Saved on the draft', status: ch.status, context: false, saved: true, selected: false }))
  }
  const sums = new Map<string, { source: string; target: string; status: ChangeStatus; saved: boolean; n: number }>()
  // A link to an entity that did not change: to the one "Unchanged" cluster, counted once each.
  const unchanged = new Set<string>()
  const endOf = (id: string) => {
    const c = clusterOf.get(id)
    if (c) return c
    unchanged.add(id)
    if (!data.has('cluster:context')) data.set('cluster:context', { label: 'Unchanged entities', context: true, saved: false, selected: false, count: 0 })
    return 'cluster:context'
  }
  const sum = (s: string | undefined, t: string | undefined, status: ChangeStatus, isSaved: boolean) => {
    if (!s || !t) return
    const cs = endOf(s)
    const ct = endOf(t)
    if (cs === ct) return
    const k = `${cs}>${ct}`
    const was = sums.get(k)
    if (was) was.n++
    else sums.set(k, { source: cs, target: ct, status, saved: isSaved, n: 1 })
  }
  for (const g of groups) {
    if (g.kind !== 'edge') continue
    byKey.set(g.key, g)
    const ends = edgeEnds(g)
    if (ends) sum(ends.source, ends.target, g.status, false)
  }
  for (const ch of saved?.changes ?? []) if (ch.kind === 'edge') sum(ch.sourceUrn, ch.targetUrn, ch.status, true)
  if (data.has('cluster:context')) data.get('cluster:context')!.count = unchanged.size
  const edges: Edge[] = [...sums.values()].map((e) => ({
    id: `sum:${e.source}>${e.target}`, source: e.source, target: e.target, label: e.n.toLocaleString(),
    ...edgeStyle(e.status, e.saved, Math.min(6, 1.5 + Math.log10(e.n + 1) * 1.5)),
  }))

  // The selected change, and what its staged relationships reach, one by one.
  if (selected && selected.kind !== 'layout') {
    const focus = selected.kind === 'node' ? selected.key : null
    const draw = (id: string, d: Partial<MapNodeData>) => {
      if (!data.has(id)) data.set(id, { label: nameOf(id), context: true, saved: false, selected: false, ...d })
    }
    if (focus) draw(focus, { label: selected.name, typeId: selected.typeId, status: selected.status, context: false, selected: true })
    let reached = 0
    for (const g of groups) {
      if (g.kind !== 'edge' || reached >= 24) continue
      const ends = edgeEnds(g)
      if (!ends || (g !== selected && ends.source !== focus && ends.target !== focus)) continue
      draw(ends.source, {})
      draw(ends.target, {})
      if (g === selected) { data.get(ends.source)!.selected = true; data.get(ends.target)!.selected = true }
      edges.push({ id: `near:${g.key}`, source: ends.source, target: ends.target, label: ends.type, ...edgeStyle(g.status, false) })
      reached++
    }
  }
  // A row per type, the most changed first; each cluster in its kind's column.
  const typeRank = new Map<string, number>()
  for (const [, d] of [...data].filter(([id]) => id.startsWith('cluster:')).sort((a, b) => (b[1].count ?? 0) - (a[1].count ?? 0))) {
    if (!typeRank.has(d.label)) typeRank.set(d.label, typeRank.size)
  }
  const pos = new Map<string, { x: number; y: number }>()
  const nextRow = new Map<number, number>()
  for (const [id, d] of data) {
    const col = !id.startsWith('cluster:') ? COLUMN.near
      : id === 'cluster:context' ? COLUMN.context
      : d.saved ? COLUMN.saved : COLUMN[d.status ?? 'modified']
    const row = id.startsWith('cluster:') && id !== 'cluster:context' && !d.saved
      ? typeRank.get(d.label)!
      : (nextRow.get(col) ?? 0)
    nextRow.set(col, Math.max(nextRow.get(col) ?? 0, row + 1))
    pos.set(id, { x: col, y: row * (NODE_H + 26) })
  }
  // Only the columns in use, side by side.
  const used = [...nextRow.keys()].sort((a, b) => a - b)
  const xOf = (col: number) => used.indexOf(col) * (NODE_W + 110)
  for (const p of pos.values()) p.x = xOf(p.x)
  const headings: Node<MapNodeData>[] = used.map((col) => ({
    id: `column:${col}`, type: 'column', position: { x: xOf(col), y: -34 },
    data: { label: COLUMN_LABEL[col], context: true, saved: false, selected: false },
    draggable: false, connectable: false, selectable: false,
  }))
  return { nodes: [...headings, ...toFlow(data, pos)], edges, total: clusterOf.size, byKey }
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
          {data.count !== undefined && data.status
            ? `${data.count.toLocaleString()} ${STATUS_WORD[data.status]}`
            : data.count !== undefined ? `${data.count.toLocaleString()} linked to`
            : meta ? `${meta.label}${data.saved ? ' · saved' : ''}` : 'Unchanged'}
        </span>
      </span>
      {data.count !== undefined && data.status && !data.saved && <ListFilter className="w-3.5 h-3.5 text-ink-muted shrink-0" aria-hidden />}
      <Handle type="source" position={Position.Right} className="!opacity-0 !w-1 !h-1" />
    </div>
  )
})

/** A column's heading in the cluster matrix. */
const ColumnLabel = memo(function ColumnLabel({ data }: NodeProps<Node<{ label: string }>>) {
  return <span className="block w-[196px] text-[11px] font-bold uppercase tracking-[0.08em] text-ink-muted">{data.label}</span>
})

const nodeTypes = { change: ChangeNode, column: ColumnLabel }

export default function ChangeMap({ groups, saved = null, nameOf, selectedKey, onSelect, onShowInList, onReveal, onShowCluster }: {
  /** The staged changes, as Review & Save groups them (and as its filter keeps them). */
  groups: readonly ReviewGroup[]
  /** What the draft already has saved (drawn solid). */
  saved?: ChangeSet | null
  nameOf: (id: string) => string
  /** The selected group's key — given, the Map follows the List's selection. */
  selectedKey?: string | null
  onSelect?: (key: string | null) => void
  /** Open this group in the List. */
  onShowInList?: (key: string) => void
  /** Show this entity on the canvas. */
  onReveal?: (id: string) => void
  /** List the changes a cluster stands for. */
  onShowCluster?: (typeId: string, status: ChangeStatus) => void
}) {
  const [own, setOwn] = useState<string | null>(null)
  const selected = selectedKey !== undefined ? selectedKey : own
  const select = (key: string | null) => (onSelect ? onSelect(key) : setOwn(key))
  // Laid out once per set of changes; selecting below only restyles.
  const base = useMemo(() => build(groups, saved, nameOf), [groups, saved, nameOf])
  const clustered = base.total > MAX_NODES
  const selectedGroup = selected ? base.byKey.get(selected) : undefined
  const model = useMemo(
    () => (clustered ? clusters(groups, saved, nameOf, selectedGroup) : base),
    [clustered, groups, saved, nameOf, selectedGroup, base],
  )
  const nodes = useMemo(
    () => (clustered ? model.nodes : model.nodes.map((n) => (n.id === selected ? { ...n, data: { ...n.data, selected: true } } : n))),
    [clustered, model, selected],
  )
  const group = selectedGroup

  if (!clustered && model.nodes.length === 0) {
    return <p className="py-16 text-center text-sm text-ink-muted">Nothing to draw — these changes are to the view’s layout only.</p>
  }

  return (
    <div className="relative h-[min(58vh,600px)] rounded-2xl border border-glass-border bg-black/[0.015] dark:bg-white/[0.02] overflow-hidden">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={model.edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
          minZoom={0.2}
          nodesDraggable={false}
          nodesConnectable={false}
          onNodeClick={(_, n) => {
            if (n.type === 'column') return
            const d = n.data as MapNodeData
            if (d.count !== undefined) {
              // A group of staged changes lists them; the saved and unchanged groups are context.
              if (d.status && !d.saved) onShowCluster?.(d.typeId ?? '', d.status)
              return
            }
            select(selected === n.id ? null : n.id)
          }}
          onPaneClick={() => select(null)}
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
      {clustered && (
        <p className="absolute top-2.5 right-2.5 max-w-[46%] px-2 py-1 rounded-lg bg-canvas-elevated/90 border border-glass-border text-[10.5px] text-ink-muted">
          {base.total.toLocaleString()} entities, grouped by type — click a group to list it
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
