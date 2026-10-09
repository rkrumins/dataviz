/**
 * OrphansDrawer — the Context View's "Orphaned entities" panel (Display menu → Advanced).
 *
 * An orphan is an entity whose type the ontology says sits inside another (a Table in a
 * Schema) but which has no parent in the data. The server decides which those are
 * (`orphansOnly`); this panel lists them a page at a time, says where each one is in this
 * view, and offers Reveal and, on a draft, Place in layer.
 *
 * A power-user tool: nothing is fetched while it is closed, and the canvas does not change
 * until the reader acts on a row.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { AnimatePresence } from 'framer-motion'
import { Loader2, Unlink, X } from 'lucide-react'
import { DrawerBody, DrawerFooter, DrawerFrame, DrawerHeader } from '@/components/panels/shell/DrawerShell'
import type { GraphDataProvider, GraphNode, TopLevelNodesQuery } from '@/providers/GraphDataProvider'
import type { ViewLayerConfig } from '@/types/schema'

const PAGE_SIZE = 50

/** Where an entity is in this view: the column it is drawn in (`drawn`), else the layer the
 *  view would put it in, else none. */
export interface OrphanWhere {
  layerId?: string
  drawn: boolean
}

export interface OrphansDrawerProps {
  open: boolean
  onClose: () => void
  provider: GraphDataProvider
  layers: ViewLayerConfig[]
  layerOf: (node: GraphNode) => OrphanWhere
  onReveal: (urn: string) => void
  /** Pin an entity to a layer. Absent = no Place control. */
  onPlace?: (urn: string, layerId: string) => void
}

export function OrphansDrawer({ open, ...panel }: OrphansDrawerProps) {
  return (
    <AnimatePresence>
      {open && (
        <DrawerFrame panel="orphans-drawer" label="Orphaned entities">
          <OrphansPanel {...panel} />
        </DrawerFrame>
      )}
    </AnimatePresence>
  )
}

function OrphansPanel({ onClose, provider, layers, layerOf, onReveal, onPlace }: Omit<OrphansDrawerProps, 'open'>) {
  const [rows, setRows] = useState<GraphNode[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  /** null when the server could not count them in time. */
  const [total, setTotal] = useState<number | null>(null)
  // The first page is asked for on mount, so the panel opens loading.
  const [loading, setLoading] = useState(true)
  // The provider the rows, cursor and total came from, and the one whose request failed. After a
  // branch or draft switch they belong to another provider: not shown, and paging starts again.
  const [listedFor, setListedFor] = useState<GraphDataProvider | null>(null)
  const [failedFor, setFailedFor] = useState<GraphDataProvider | null>(null)
  // Only the latest request may write: a reply for an older provider (branch switch) is dropped.
  const reqRef = useRef(0)
  const titleRef = useRef<HTMLHeadingElement>(null)

  // Depends on the provider only, so landing a page never re-runs the first-page effect below.
  // State is written only once the reply lands; a first page replaces the list.
  const load = useCallback((from: string | null) => {
    const req = ++reqRef.current
    const query: TopLevelNodesQuery = {
      orphansOnly: true, limit: PAGE_SIZE, cursor: from, includeChildCount: true,
    }
    void provider.getTopLevelNodes(query).then((page) => {
      if (req !== reqRef.current) return
      setRows((prev) => {
        const kept = from === null ? [] : prev
        const seen = new Set(kept.map((n) => n.urn))
        return [...kept, ...page.nodes.filter((n) => !seen.has(n.urn))]
      })
      setCursor(page.nextCursor)
      setHasMore(page.hasMore)
      setTotal(page.totalCount)
      setListedFor(provider)
      setFailedFor(null)
      setLoading(false)
    }, () => {
      if (req !== reqRef.current) return
      setFailedFor(provider)
      setLoading(false)
    })
  }, [provider])

  useEffect(() => { load(null) }, [load])

  // Opening from the Display menu drops focus (the menu closes); take it, so Escape closes this.
  useEffect(() => {
    if (document.activeElement === document.body) titleRef.current?.focus({ preventScroll: true })
  }, [])

  const current = listedFor === provider
  const failed = failedFor === provider
  const listed = current ? rows : []

  /** Load more, or Retry: the page after the last one that landed for this provider. */
  const next = () => {
    setLoading(true)
    setFailedFor(null)
    load(current ? cursor : null)
  }

  const shown = !current ? null : (total ?? (hasMore ? 'Many' : rows.length)).toLocaleString()

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    onClose()
  }

  return (
    <div className="relative flex flex-col flex-1 min-h-0" onKeyDown={onKeyDown}>
      <DrawerHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-8 h-8 rounded-xl bg-accent-lineage/15 flex items-center justify-center flex-shrink-0">
              <Unlink className="w-4 h-4 text-accent-lineage" />
            </span>
            <div className="min-w-0">
              <h2 ref={titleRef} tabIndex={-1} className="text-sm font-display font-semibold text-ink leading-tight outline-none">Orphaned entities</h2>
              {shown !== null && (
                <p className="text-[11px] text-ink-muted">{shown} with no parent in the data</p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close orphaned entities"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/10 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </DrawerHeader>

      <DrawerBody>
        {listed.length > 0 && (
          <ul className="divide-y divide-glass-border">
            {listed.map((node) => (
              <OrphanRow
                key={node.urn}
                node={node}
                layers={layers}
                where={layerOf(node)}
                onReveal={onReveal}
                onPlace={onPlace}
              />
            ))}
          </ul>
        )}
        {failed ? (
          <div role="alert" className="m-4 rounded-xl border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-ink flex items-center gap-2">
            Couldn&apos;t load orphaned entities ·
            <button type="button" onClick={next} className="font-medium text-accent-lineage hover:underline">
              Retry
            </button>
          </div>
        ) : (loading || !current) && listed.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-ink-muted">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Loading orphaned entities…
          </div>
        ) : listed.length === 0 ? (
          <p className="px-5 py-10 text-center text-xs text-ink-muted">
            No orphaned entities — every entity whose type sits inside another has a parent.
          </p>
        ) : null}
      </DrawerBody>

      {listed.length > 0 && (
        <DrawerFooter className="flex items-center justify-between gap-3 text-[11px] text-ink-muted">
          <span>Showing {listed.length.toLocaleString()} of {shown}</span>
          {hasMore && (
            <button
              type="button"
              onClick={next}
              disabled={loading}
              className="px-2.5 py-1 rounded-lg font-medium text-accent-lineage bg-accent-lineage/10 hover:bg-accent-lineage/20 disabled:opacity-50 transition-colors"
            >
              Load more
            </button>
          )}
        </DrawerFooter>
      )}
    </div>
  )
}

function OrphanRow({ node, layers, where, onReveal, onPlace }: {
  node: GraphNode
  layers: ViewLayerConfig[]
  where: OrphanWhere
  onReveal: (urn: string) => void
  onPlace?: (urn: string, layerId: string) => void
}) {
  const name = node.displayName || node.urn
  const layer = where.layerId ? layers.find((l) => l.id === where.layerId) : undefined
  const layerName = layer?.name ?? where.layerId
  return (
    <li className="px-4 py-2.5 flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-ink truncate" title={name}>{name}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-muted min-w-0">
          <span className="truncate">{node.entityType}</span>
          <span aria-hidden>·</span>
          {!where.layerId ? (
            <span>Not in this view</span>
          ) : where.drawn ? (
            <span className="inline-flex items-center gap-1 text-ink">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: layer?.color || '#6366f1' }} />
              {layerName}
            </span>
          ) : (
            <span>{layerName} · not loaded</span>
          )}
        </div>
      </div>
      {/* Only an entity this view places can be revealed: loading any other would only add
          to the canvas's "not in any layer" count. */}
      <button
        type="button"
        onClick={() => onReveal(node.urn)}
        disabled={!where.layerId}
        title={where.layerId ? undefined : 'Not in this view'}
        aria-label={`Reveal ${name} on the canvas`}
        className="px-2 py-1 rounded-lg text-[11px] font-medium text-accent-lineage bg-accent-lineage/10 hover:bg-accent-lineage/20 disabled:text-ink-muted disabled:bg-transparent disabled:cursor-not-allowed transition-colors"
      >
        Reveal
      </button>
      {onPlace && (
        <select
          aria-label={`Place ${name} in a layer`}
          value=""
          onChange={(e) => { if (e.target.value) onPlace(node.urn, e.target.value) }}
          className="max-w-[9rem] px-1.5 py-1 rounded-lg text-[11px] bg-black/[0.04] dark:bg-white/[0.06] border border-black/[0.10] dark:border-white/[0.08] text-ink"
        >
          <option value="">Place in layer…</option>
          {layers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      )}
    </li>
  )
}
