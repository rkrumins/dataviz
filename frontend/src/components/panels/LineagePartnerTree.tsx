/**
 * The entity drawer's lineage partners as a tree: the systems they sit in,
 * then the entities inside, then the fields a flow actually joins — each
 * level opened in place (`lineagePartnerTree.ts` builds it from the Focus
 * Lens's walk).
 *
 * A flat list could only show what the canvas had loaded, rolled up to what
 * it drew: 736 upstream fields read as one row, "Reporting Layer", because
 * that root was collapsed on the board. The tree shows every partner the
 * walk found, wherever it sits, and lets the reader descend to the grain
 * they care about — the system, the table, the column.
 *
 * Levels open lazily and page in fifties, so a partner list of thousands
 * stays a handful of rows until it is asked for.
 */
import { Fragment, useMemo, useState } from 'react'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSchemaStore } from '@/store/schema'
import { generateColorFromType } from '@/lib/type-visuals'
import { resolveEntityName } from '@/lib/entityDisplayName'
import { partnerName, type PartnerTreeNode, type SidePartners } from '@/lib/lineagePartnerTree'
import { EmptyState, SortMenu, type SortMode } from './lineageListParts'

type Direction = 'incoming' | 'outgoing'

/** Rows a level shows before "Show more". */
const PAGE = 50

function labelOf(n: PartnerTreeNode): string {
  return resolveEntityName(n.node?.data, 'business', partnerName(n))
}

/** The systems open by themselves when there are few enough to scan. */
function autoOpen(roots: ReadonlyArray<PartnerTreeNode>): string[] {
  return roots.length <= 2 ? roots.map(r => r.urn) : []
}

interface PartnerTreeDetailProps {
  side: SidePartners
  direction: Direction
  /** The name of an entity the walk holds — for the focal's own fields. */
  nameOf: (urn: string) => string
  onNeighborClick: (urn: string) => void | Promise<unknown>
  selectionEnabled: boolean
  selectedIds: Set<string>
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>
  /** Still counting: an empty tree is not an answer yet. */
  counting: boolean
}

export function PartnerTreeDetail({
  side,
  direction,
  nameOf,
  onNeighborClick,
  selectionEnabled,
  selectedIds,
  setSelectedIds,
  counting,
}: PartnerTreeDetailProps) {
  const [query, setQuery] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('default')
  // Opened / closed by the reader. A system opens by itself when there are
  // few (`autoOpen`), and a search opens the way to every match.
  const [opened, setOpened] = useState<Set<string>>(() => new Set(autoOpen(side.roots)))
  const [closed, setClosed] = useState<Set<string>>(() => new Set())
  const [pageOf, setPageOf] = useState<Map<string, number>>(() => new Map())

  // The systems can arrive after the list opens (the walk is still
  // counting): open them as a first mount would have.
  const rootKey = side.roots.map(r => r.urn).join('\u0000')
  const [openedFor, setOpenedFor] = useState(rootKey)
  if (openedFor !== rootKey) {
    setOpenedFor(rootKey)
    const add = autoOpen(side.roots)
    if (add.length > 0) setOpened(prev => new Set([...prev, ...add]))
  }

  const q = query.trim().toLowerCase()
  /** Every entity that matches the search or holds a match; null = no search. */
  const kept = useMemo(() => {
    if (!q) return null
    const keep = new Set<string>()
    const visit = (n: PartnerTreeNode): boolean => {
      let hit = labelOf(n).toLowerCase().includes(q) || n.urn.toLowerCase().includes(q)
      for (const c of n.children) if (visit(c)) hit = true
      if (hit) keep.add(n.urn)
      return hit
    }
    for (const r of side.roots) visit(r)
    return keep
  }, [q, side.roots])

  const isOpen = (n: PartnerTreeNode) => {
    if (n.children.length === 0 || closed.has(n.urn)) return false
    if (opened.has(n.urn)) return true
    return kept !== null && n.children.some(c => kept.has(c.urn))
  }
  const toggle = (n: PartnerTreeNode) => {
    const open = isOpen(n)
    setOpened(prev => {
      const next = new Set(prev)
      if (open) next.delete(n.urn)
      else next.add(n.urn)
      return next
    })
    setClosed(prev => {
      const next = new Set(prev)
      if (open) next.add(n.urn)
      else next.delete(n.urn)
      return next
    })
  }

  const order = (list: PartnerTreeNode[]) => {
    if (sortMode === 'default') return list
    const sorted = [...list].sort((a, b) => labelOf(a).localeCompare(labelOf(b)))
    return sortMode === 'name-asc' ? sorted : sorted.reverse()
  }

  // "Select all" takes the partners at the focal's own level — what "Show
  // all on canvas" brings in — narrowed by the search.
  const peersInView = useMemo(
    () => (kept ? side.peers.filter(u => kept.has(u)) : side.peers),
    [kept, side.peers],
  )
  const allSelected = peersInView.length > 0 && peersInView.every(u => selectedIds.has(u))
  const toggleAll = () => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      for (const u of peersInView) {
        if (allSelected) next.delete(u)
        else next.add(u)
      }
      return next
    })
  }
  const toggleOne = (urn: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(urn)) next.delete(urn)
      else next.add(urn)
      return next
    })
  }

  const level = (nodes: ReadonlyArray<PartnerTreeNode>, depth: number, key: string): React.ReactNode => {
    const list = order(kept ? nodes.filter(n => kept.has(n.urn)) : [...nodes])
    const limit = pageOf.get(key) ?? PAGE
    const rest = list.length - limit
    return (
      <>
        {list.slice(0, limit).map(n => {
          const open = isOpen(n)
          return (
            <Fragment key={n.urn}>
              <PartnerRow
                node={n}
                depth={depth}
                open={open}
                onToggle={() => toggle(n)}
                direction={direction}
                nameOf={nameOf}
                onOpenEntity={() => onNeighborClick(n.urn)}
                selectionEnabled={selectionEnabled}
                selectionActive={selectedIds.size > 0}
                selected={selectedIds.has(n.urn)}
                onToggleSelected={() => toggleOne(n.urn)}
              />
              {open && level(n.children, depth + 1, n.urn)}
            </Fragment>
          )
        })}
        {rest > 0 && (
          <button
            type="button"
            onClick={() => setPageOf(prev => new Map(prev).set(key, limit + PAGE * 2))}
            className="w-full text-left py-1.5 text-[11px] font-medium text-accent-lineage hover:underline"
            style={{ paddingLeft: indent(depth) + 22 }}
          >
            Show {Math.min(PAGE * 2, rest).toLocaleString()} more of {rest.toLocaleString()}
          </button>
        )}
      </>
    )
  }

  const empty = kept ? kept.size === 0 : side.roots.length === 0

  return (
    <div className="p-3 space-y-2.5">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <LucideIcons.Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or URN…"
            aria-label={`Search ${direction === 'incoming' ? 'data sources' : 'data consumers'}`}
            className="w-full pl-9 pr-8 py-2 text-xs rounded-lg bg-black/10 dark:bg-white/[0.04] border border-white/10 focus:border-accent-lineage/40 focus:bg-white/[0.06] outline-none transition-colors duration-150 placeholder:text-ink-muted/70"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-ink-muted hover:text-ink hover:bg-white/10 transition-colors duration-150"
              title="Clear search"
            >
              <LucideIcons.X className="w-3 h-3" />
            </button>
          )}
        </div>
        {side.partners > 1 && <SortMenu value={sortMode} onChange={setSortMode} />}
        {selectionEnabled && peersInView.length > 0 && (
          <button
            type="button"
            onClick={toggleAll}
            aria-pressed={allSelected}
            aria-label={allSelected ? 'Deselect all' : `Select all ${peersInView.length} entities`}
            className={cn(
              'inline-flex items-center gap-1 px-2 py-2 rounded-lg text-[11px] font-medium border transition-colors duration-150 whitespace-nowrap',
              allSelected
                ? 'text-accent-lineage bg-accent-lineage/10 border-accent-lineage/30'
                : 'text-ink-muted bg-white/[0.04] border-white/10 hover:text-ink hover:border-white/20',
            )}
          >
            {allSelected ? <LucideIcons.CheckSquare className="w-3.5 h-3.5" /> : <LucideIcons.Square className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{allSelected ? 'Deselect all' : `Select all (${peersInView.length})`}</span>
          </button>
        )}
      </div>

      {empty ? (
        counting && !q ? (
          <EmptyState icon={LucideIcons.Loader2} title="Counting lineage in the data source…" />
        ) : (
          <EmptyState
            icon={q ? LucideIcons.SearchX : LucideIcons.Unlink}
            title={q ? 'No matching entities' : 'No flows in this direction'}
            hint={q ? 'Try a different name.' : undefined}
          />
        )
      ) : (
        <div role="tree" aria-label={direction === 'incoming' ? 'Data sources' : 'Data consumers'} className="rounded-xl border border-white/[0.06] bg-white/[0.02] py-1">
          {level(side.roots, 0, '')}
        </div>
      )}
    </div>
  )
}

const indent = (depth: number) => 8 + depth * 16

function PartnerRow({
  node,
  depth,
  open,
  onToggle,
  direction,
  nameOf,
  onOpenEntity,
  selectionEnabled,
  selectionActive,
  selected,
  onToggleSelected,
}: {
  node: PartnerTreeNode
  depth: number
  open: boolean
  onToggle: () => void
  direction: Direction
  nameOf: (urn: string) => string
  onOpenEntity: () => void | Promise<unknown>
  selectionEnabled: boolean
  selectionActive: boolean
  selected: boolean
  onToggleSelected: () => void
}) {
  const [busy, setBusy] = useState(false)
  const schema = useSchemaStore((s) => s.schema)
  const type = String(node.node?.entityType ?? node.node?.data?.type ?? '')
  const entityType = schema?.entityTypes.find((t) => t.id === type)
  const color = entityType?.visual.color ?? generateColorFromType(type || 'entity')
  const label = labelOf(node)
  const container = node.children.length > 0
  const isIncoming = direction === 'incoming'
  const accent = isIncoming ? 'text-lineage-in' : 'text-lineage-out'

  // A container says how much sits inside it; a partner says which of the
  // focal's own fields its flows meet.
  let secondary: string
  if (container) {
    const noun = isIncoming ? (node.partners === 1 ? 'source' : 'sources') : (node.partners === 1 ? 'consumer' : 'consumers')
    secondary = `${node.partners.toLocaleString()} ${noun}`
    if (node.flows !== node.partners) secondary += ` · ${node.flows.toLocaleString()} flows`
  } else {
    const verb = isIncoming ? 'feeds' : 'fed by'
    const names = node.via.slice(0, 2).map(nameOf)
    const more = node.via.length - names.length
    secondary = names.length > 0
      ? `${verb} ${names.join(', ')}${more > 0 ? ` +${more.toLocaleString()}` : ''}`
      : (node.flows > 0 ? `${node.flows.toLocaleString()} ${node.flows === 1 ? 'flow' : 'flows'}` : '')
  }

  const open_ = async () => {
    if (busy) return
    setBusy(true)
    try { await onOpenEntity() } finally { setBusy(false) }
  }

  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={container ? open : undefined}
      aria-selected={selectionEnabled ? selected : undefined}
      className={cn(
        'group relative flex items-center gap-1.5 pr-2 py-1 transition-colors duration-150',
        selected ? 'bg-accent-lineage/10' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.04]',
        busy && 'cursor-progress',
      )}
      style={{ paddingLeft: indent(depth) }}
    >
      {selectionEnabled && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggleSelected() }}
          aria-label={selected ? `Deselect ${label}` : `Select ${label}`}
          aria-pressed={selected}
          className={cn(
            'w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-opacity duration-150',
            selected
              ? 'bg-accent-lineage border-accent-lineage text-white opacity-100'
              : selectionActive
                ? 'border-white/20 hover:border-accent-lineage/60 opacity-100'
                : 'border-white/20 hover:border-accent-lineage/60 opacity-0 group-hover:opacity-100',
          )}
        >
          {selected && <LucideIcons.Check className="w-2.5 h-2.5" />}
        </button>
      )}
      {container ? (
        <button
          type="button"
          onClick={onToggle}
          aria-label={open ? `Collapse ${label}` : `Expand ${label}`}
          className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08] transition-colors"
        >
          <LucideIcons.ChevronRight className={cn('w-3.5 h-3.5 transition-transform duration-150', open && 'rotate-90')} />
        </button>
      ) : (
        <span className="w-5 flex-shrink-0" aria-hidden />
      )}
      <button
        type="button"
        onClick={open_}
        disabled={busy}
        title={node.urn}
        className="flex-1 min-w-0 flex items-center gap-2 py-0.5 text-left"
      >
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} aria-hidden />
        <span className="flex-1 min-w-0">
          <span className={cn('block truncate text-[12.5px] leading-snug text-ink', container ? 'font-semibold' : 'font-medium')}>
            {label}
          </span>
          {secondary && (
            <span className="block truncate text-[10.5px] leading-tight text-ink-muted">{secondary}</span>
          )}
        </span>
        {container && (
          <span className={cn('flex-shrink-0 text-[11px] font-semibold tabular-nums', accent)}>
            {node.partners.toLocaleString()}
          </span>
        )}
        {busy ? (
          <LucideIcons.Loader2 data-testid="reveal-spinner" className={cn('w-3.5 h-3.5 animate-spin flex-shrink-0', accent)} />
        ) : (
          <LucideIcons.ArrowRight
            className="w-3.5 h-3.5 flex-shrink-0 text-ink-muted/70 transition-all duration-150 opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0"
            aria-hidden
          />
        )}
      </button>
    </div>
  )
}
