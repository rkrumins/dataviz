/**
 * LineageNeighbors — 1-hop incoming/outgoing neighbor preview for the entity
 * drawer.
 *
 * Default state: two card-style summary rows showing upstream/downstream
 * counts. Clicking a card expands an inline panel with grouped neighbors,
 * always-on search, and entity-type / edge-type filter chips.
 *
 * Data source: `canvas.visibleEdges` (the projected/aggregated edge set the
 * canvas renders) with a fallback to raw `canvas.edges`. Containment edges
 * are filtered out via the schema's containment set. Fully decoupled from
 * Trace Lineage — counts reflect whatever lineage edges currently touch
 * this node.
 *
 * Click a neighbor row → swap drawer (openNodeDrawer) and, when wired,
 * center the canvas (onFocusNode prop).
 */

import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import {
  useSchemaStore,
  useContainmentEdgeTypes,
  useEntityTypeHierarchyMap,
  normalizeEdgeType,
} from '@/store/schema'
import { isContainmentEdgeType } from '@/store/schema'
import {
  deriveNeighborRecords,
  mergeSupplementalEdges,
  buildCanContainClosure,
  isCoarserGrain,
  type NeighborDirection,
  type NeighborRecord,
} from '@/lib/lineage-neighbors'
import { useGraphProviderIfAvailable } from '@/providers/GraphProviderContext'
import { useViewLineageEdgeTypes } from '@/hooks/useViewSchema'
import { useLensLineage, EDGE_FETCH_LIMIT } from '@/hooks/useLensLineage'
import { useLensWalk } from '@/hooks/useLensWalk'
import { partnersFromWalk, partnerName, type SidePartners } from '@/lib/lineagePartnerTree'
import { useWorkspacesStore } from '@/store/workspaces'
import { generateColorFromType, generateEdgeColorFromType } from '@/lib/type-visuals'
import { cn } from '@/lib/utils'
import { withTimeout, TimeoutError } from '@/lib/concurrency'
import { TIMEOUTS } from '@/config/timeouts'
import { StaleDataBanner } from '@/components/insights/StaleDataBanner'
import { formatUnitCount, unitMeaning, unitNoun } from '@/components/canvas/context-view/connections/connectionUnits'
import { resolveEntityName } from '@/lib/entityDisplayName'
import { EmptyState, SortMenu, type SortMode } from './lineageListParts'
import { PartnerTreeDetail } from './LineagePartnerTree'

/**
 * Where the drawer's walk parks. The drawer opens on every selection and
 * only COUNTS, so it does not walk a giant container unasked: past this it
 * says "at least" and offers to count the rest. The Lens keeps its own,
 * larger checkpoint. One 10,000-node page answers a table of 600 columns
 * (measured: 2,892 nodes, one second).
 */
const DRAWER_WALK_CHECKPOINT = 12_000

interface LineageNeighborsProps {
  nodeId: string
  /** Reveal the target on canvas (expand ancestors, pan/scroll). May
   *  return a promise — the clicked row shows an inline spinner until it
   *  resolves. */
  /** Reveal on canvas. May report a `RevealOutcome` — 'unavailable' means
   *  the walk finished and the entity is still not there. */
  onFocusNode?: (nodeId: string) => void | Promise<unknown>
  /** Reveal a set of neighbors at once and fit the canvas around them.
   *  Used by the multi-select action bar. Implementations may run each
   *  reveal in parallel; the drawer doesn't swap when this fires. */
  onLocateMany?: (nodeIds: string[]) => void | Promise<void>
}

type Direction = NeighborDirection

export function LineageNeighbors({ nodeId, onFocusNode, onLocateMany }: LineageNeighborsProps) {
  const rawEdges = useCanvasStore((s) => s.edges)
  const visibleEdges = useCanvasStore((s) => s.visibleEdges)
  const nodes = useCanvasStore((s) => s.nodes)

  // THE WALK — the Focus Lens's own (`useLensWalk`): the server walk from
  // this entity, completed page by page until nothing is owed, so the
  // drawer and the Lens hold ONE answer. Its counts and its list come from
  // the same model. They used not to: the count was one capped page (747
  // where the data holds 932) and the list was the canvas's own edges —
  // "No flows in this direction" under that 747 whenever the partners were
  // not loaded, and every partner folded into the one collapsed root the
  // canvas drew when they were.
  const provider = useGraphProviderIfAvailable()
  const walkCapable = typeof provider?.traceClosure === 'function'
  const lensWalk = useLensWalk(
    walkCapable && nodeId ? nodeId : null,
    walkCapable ? provider ?? null : null,
    1,
    false,
    DRAWER_WALK_CHECKPOINT,
  )
  const walkEntry = walkCapable && nodeId ? lensWalk.walkFor(nodeId) : null
  const walkProgress = walkCapable && nodeId ? lensWalk.walkProgressFor(nodeId) : null
  // A provider that cannot walk, or a walk that failed outright, falls back
  // to what the canvas holds — and says so.
  const walkFailed = walkEntry?.status === 'error' || walkEntry?.status === 'unsupported'
  const walkMode = walkCapable && !walkFailed

  // The canvas-edge path, for when there is no walk: the store's edges plus
  // a bounded per-node fetch. Idle while the walk answers.
  const lineageEdgeTypes = useViewLineageEdgeTypes()
  const fetchStack = useMemo(() => (nodeId && !walkMode ? [nodeId] : []), [nodeId, walkMode])
  const sourceFetch = useLensLineage(fetchStack, provider, lineageEdgeTypes)
  const fetchState = sourceFetch.status.get(nodeId)

  // Mirror the canvas: prefer the projected/aggregated visible set; fall
  // back to raw edges when no canvas has published one yet — then merge
  // in the fetched edges (deduped by id / pair / covering aggregate).
  const edges = useMemo(() => {
    const base = visibleEdges.length > 0 ? visibleEdges : rawEdges
    return mergeSupplementalEdges(base, sourceFetch.supplementalEdges)
  }, [visibleEdges, rawEdges, sourceFetch.supplementalEdges])
  const openNodeDrawer = useCanvasStore((s) => s.openNodeDrawer)
  const selectNode = useCanvasStore((s) => s.selectNode)
  const containmentEdgeTypes = useContainmentEdgeTypes()
  // Scope for the StaleDataBanner — same workspace + data source that
  // produced the lineage edges we're rendering.
  const workspaceId = useWorkspacesStore((s) => s.activeWorkspaceId ?? undefined)
  const dataSourceId = useWorkspacesStore((s) => s.activeDataSourceId ?? undefined)

  const [expanded, setExpanded] = useState<Direction | null>(null)
  /** A partner the canvas could not bring in — named so the reader knows
   *  WHICH one, and cleared as soon as they try something else. */
  const [unreachable, setUnreachable] = useState<string | null>(null)

  // Multi-select state lives at the panel level (rather than inside each
  // direction's ExpandedDetail) for two reasons:
  //   1. Action bar must be sticky to the DRAWER scroll, but ExpandedDetail
  //      sits inside `overflow-hidden` wrappers that block sticky from
  //      anchoring there. Hoisting to LineageNeighbors places the action
  //      bar at a sibling level with no overflow ancestors in the way.
  //   2. Selection now persists when toggling between Sources/Consumers,
  //      matching the "panel-wide selection" desktop pattern.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [locateBusy, setLocateBusy] = useState(false)

  // Reset expansion AND any in-flight selection when the drawer's focal
  // entity changes. Without this, navigating to a neighbor leaves stale
  // state in place — e.g., "Data Sources" looks already expanded so the
  // first click on it reads as a collapse.
  useEffect(() => {
    setExpanded(null)
    setSelectedIds(new Set())
  }, [nodeId])

  const clearSelected = () => setSelectedIds(new Set())
  const handleLocateMany = async () => {
    if (selectedIds.size === 0 || !onLocateMany || locateBusy) return
    setLocateBusy(true)
    try {
      await onLocateMany([...selectedIds])
    } finally {
      setLocateBusy(false)
    }
  }

  const nodeMap = useMemo(() => {
    const m = new Map<string, LineageNode>()
    // Fetched partners first; store nodes win (they carry full canvas data).
    for (const [id, n] of sourceFetch.supplementalNodes) m.set(id, n)
    for (const n of nodes) m.set(n.id, n)
    return m
  }, [nodes, sourceFetch.supplementalNodes])

  // Lineage-only neighbors. Containment edges (structural parent ↔ child) are
  // filtered out — the section is about flow lineage. Shared derivation with
  // the canvas Lineage Lens so both surfaces always agree.
  // WHICH PARENT each partner sits in. `useLensLineage` already fetches the
  // containment edges POINTING AT the partners for exactly this reason — a
  // field name without its parent dataset is not identifying information,
  // and three partners all called `account_id` are indistinguishable without
  // it. The Lens shows that path; this panel showed a raw URN instead.
  const parentLabelOf = useMemo(() => {
    const map = new Map<string, string>()
    for (const e of edges) {
      if (!isContainmentEdgeType(normalizeEdgeType(e), containmentEdgeTypes)) continue
      if (map.has(e.target)) continue
      const parent = nodeMap.get(e.source)
      if (parent) map.set(e.target, resolveEntityName(parent.data, 'business', e.source))
    }
    return map
  }, [edges, nodeMap, containmentEdgeTypes])

  const { incomingRecords, outgoingRecords } = useMemo(
    () => deriveNeighborRecords(nodeId, edges, nodeMap, containmentEdgeTypes),
    [edges, nodeMap, nodeId, containmentEdgeTypes],
  )

  // THE COUNTS ARE THE WALK'S. Deriving them from locally-held edges
  // disagreed with the Focus Lens in two structural ways: it counted the
  // aggregation worker's synthetic `AGGREGATED` rollups as declared flows
  // (the walk strips them at one seam), and it matched only edges whose
  // endpoint IS the focal — so a container, which carries no edges of its
  // own, reported almost nothing while the Lens reported what its contents
  // reach.
  const phase = walkProgress?.phase ?? (walkMode ? 'loading' : null)
  const walkDone = phase === 'done'
  /** Still fetching pages: every number so far is a floor. */
  const counting = walkMode && (phase === 'loading' || phase === 'seeding' || phase === 'walking')
  const walkModel = walkEntry?.model ?? null
  const upSide = useMemo<SidePartners | null>(
    () => (walkMode && walkModel ? partnersFromWalk(walkModel, 'up', { fineSettled: walkDone }) : null),
    [walkMode, walkModel, walkDone],
  )
  const downSide = useMemo<SidePartners | null>(
    () => (walkMode && walkModel ? partnersFromWalk(walkModel, 'down', { fineSettled: walkDone }) : null),
    [walkMode, walkModel, walkDone],
  )
  const walkNameOf = useMemo(() => {
    const byUrn = new Map((walkModel?.nodes ?? []).map((n) => [n.urn, n]))
    return (urn: string) => {
      const n = byUrn.get(urn)
      return n ? resolveEntityName(n.data, 'business', partnerName({ urn, node: n, partners: 0, flows: 0, isPartner: false, via: [], children: [] })) : urn
    }
  }, [walkModel])
  /** The walk has not finished: its numbers are floors. */
  const walkFloor = walkMode && !walkDone

  // The fallback counts CONNECTED ENTITIES, not records: a partner reached
  // by two kinds of flow is one connected entity either way.
  const localIncoming = new Set(incomingRecords.map((r) => r.neighborId)).size
  const localOutgoing = new Set(outgoingRecords.map((r) => r.neighborId)).size

  const incomingCount = walkMode ? (upSide?.partners ?? 0) : localIncoming
  const outgoingCount = walkMode ? (downSide?.partners ?? 0) : localOutgoing
  const totalCount = walkMode
    ? new Set([...(upSide?.partnerUrns ?? []), ...(downSide?.partnerUrns ?? [])]).size
    : incomingCount + outgoingCount

  // Same grain split as the Lens header, so the two surfaces can never
  // disagree: coarser-grain partners (their type can transitively
  // contain this node's type) are summaries, counted separately.
  const hierarchyMap = useEntityTypeHierarchyMap()
  const grainClosure = useMemo(() => buildCanContainClosure(hierarchyMap), [hierarchyMap])
  const focalType = (nodeMap.get(nodeId)?.data?.type as string) ?? 'entity'
  let rollupTotal = 0
  for (const r of incomingRecords) {
    if (isCoarserGrain(grainClosure, r.neighborNode?.data?.type as string | undefined, focalType)) rollupTotal++
  }
  for (const r of outgoingRecords) {
    if (isCoarserGrain(grainClosure, r.neighborNode?.data?.type as string | undefined, focalType)) rollupTotal++
  }
  // The grain split reads the local records, so it can only annotate a
  // locally-derived total. When the walk answers, the total is the walk's
  // and the split would be describing a different set of things.
  const directTotal = walkMode ? totalCount : totalCount - rollupTotal
  const showRollupSplit = !walkMode && rollupTotal > 0

  const handleNeighborClick = async (neighborId: string) => {
    // THE PARTNER MAY NOT BE ON THE CANVAS. `useLensLineage` fetches partners
    // lens-locally and writes nothing to the canvas store, so a partner inside
    // a container that was never expanded exists here and nowhere else. The
    // drawer resolves its entity FROM THE STORE and closes when it cannot —
    // so clicking such a row looked like nothing happened.
    //
    // The reveal is what LOADS it properly: ancestors fetched, each level's
    // children paged in, containment wired. So when the store has never seen
    // this entity, the reveal goes FIRST and the drawer opens on what it
    // brought back.
    //
    // It must not be short-cut by seeding a lean copy from the lens fetch:
    // `addGraph` keeps the FIRST version of a node id it is given, so a copy
    // without childCount would permanently shadow the real one — the
    // container renders with no children and no way to expand it.
    const known = useCanvasStore.getState()._nodeIndex.has(neighborId)
    if (known) {
      // Instant swap: the entity is already there to show.
      openNodeDrawer(neighborId)
      selectNode(neighborId)
    }
    if (!onFocusNode) {
      if (!known) { openNodeDrawer(neighborId); selectNode(neighborId) }
      return
    }
    // Wrap the canvas reveal in a hard timeout. The drawer is already
    // showing the target's data via openNodeDrawer above; if the canvas
    // pan stalls (provider slow, layout solving stuck), we give up on
    // the visual reveal rather than pinning the drawer interaction.
    try {
      const result = onFocusNode(neighborId)
      const outcome = result && typeof (result as Promise<unknown>).then === 'function'
        ? await withTimeout(result as Promise<unknown>, TIMEOUTS.LINEAGE_FOCUS_MS, 'lineage.focusNode')
        : undefined
      // The walk finished and the entity is still not on the canvas — a view
      // that does not hold it, a chain that could not be completed, or a
      // synthetic rollup endpoint. Opening the drawer on it would CLOSE the
      // drawer, because `isOpen` is `!!selectedNode` and the store cannot
      // answer for it. Say so and stay where we are.
      if (outcome === 'unavailable') {
        setUnreachable(neighborId)
        return
      }
      // Swapped only once the reveal has landed it, for an entity the store
      // did not hold. Opening earlier would point the drawer at nothing.
      if (!known) {
        openNodeDrawer(neighborId)
        selectNode(neighborId)
      }
    } catch (err) {
      // A timeout is different from "not here": the reveal may simply be
      // slow, and a drawer that never opens is worse than one opened on an
      // entity the canvas is still bringing into view.
      if (!known) {
        openNodeDrawer(neighborId)
        selectNode(neighborId)
      }
      if (!(err instanceof TimeoutError)) throw err
      // Swallow the timeout silently — the drawer swap already happened
      // and the user can re-click the neighbor row to retry the reveal.
    }
  }

  const toggle = (dir: Direction) =>
    setExpanded((prev) => (prev === dir ? null : dir))

  /** "Upstream · 932 underlying flows in Web Analytics". */
  const walkSubLabel = (side: SidePartners | null, dirWord: 'Upstream' | 'Downstream') => {
    if (!side || side.partners === 0) return `${dirWord} ${unitNoun(0, 'neighbors')}`
    let text = `${dirWord} · ${formatUnitCount(side.flows, 'flows')}`
    if (side.roots.length === 1) text += ` in ${walkNameOf(side.roots[0].urn)}`
    else if (side.roots.length > 1) text += ` across ${side.roots.length.toLocaleString()} systems`
    if (side.coarse) text += ' — estimating'
    return text
  }

  /** "Show all on canvas" brings in the partners at the focal's OWN level
   *  — the tables beside a table — not every column a table's columns
   *  reach, which would expand hundreds of containers one by one. */
  const showAllProps = (urns: string[] | undefined, side: SidePartners | null) => {
    if (!onLocateMany || !urns || urns.length === 0) return {}
    const n = urns.length
    return {
      onShowAll: () => onLocateMany(urns),
      showAllLabel: side && n !== side.partners
        ? `Show their ${n.toLocaleString()} ${n === 1 ? 'entity' : 'entities'} on canvas`
        : `Show all ${n.toLocaleString()} on canvas`,
    }
  }

  return (
    <div className="px-5 py-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <LucideIcons.GitBranch className="w-4 h-4 text-ink-muted" />
          <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">
            Lineage
          </h3>
        </div>
        <span className="flex items-center gap-1.5 text-[10px] font-medium text-ink-muted/80 tabular-nums">
          {(fetchState === 'loading' || counting) && (
            <LucideIcons.Loader2
              className="w-3 h-3 animate-spin text-accent-lineage/70"
              aria-label="Fetching lineage from the data source"
            />
          )}
          {totalCount > 0 && (
            <span title={unitMeaning('neighbors')}>
              {walkFloor && 'at least '}
              {formatUnitCount(directTotal, 'neighbors')}
              {showRollupSplit && ` · ${rollupTotal} rolled-up`}
            </span>
          )}
        </span>
      </div>

      <StaleDataBanner
        workspaceId={workspaceId}
        dataSourceId={dataSourceId}
        subject="Lineage data"
        className="mb-3"
      />

      {/* Walk narration — a walk that parked, or lost a page, is SAID: its
          numbers are floors, never totals. */}
      {walkMode && phase === 'checkpoint' && (
        <div className="flex items-center gap-2 mb-3 px-2.5 py-1.5 rounded-lg border border-black/[0.06] dark:border-white/[0.06] bg-black/[0.02] dark:bg-white/[0.02] text-[10.5px] text-ink-muted">
          <LucideIcons.Info className="w-3 h-3 flex-shrink-0" />
          <span className="min-w-0">
            A large lineage — counted the first {(walkProgress?.nodes ?? 0).toLocaleString()} entities, so these are floors.
          </span>
          <button
            type="button"
            onClick={() => lensWalk.continuePastCheckpoint(nodeId)}
            className="ml-auto flex-shrink-0 px-2 py-1 rounded-md font-semibold text-accent-lineage hover:bg-accent-lineage/10 transition-colors"
          >
            Count all
          </button>
        </div>
      )}
      {walkMode && phase === 'error' && (
        <div className="flex items-center gap-2 mb-3 px-2.5 py-1.5 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] text-[10.5px] text-amber-700 dark:text-amber-400">
          <LucideIcons.AlertTriangle className="w-3 h-3 flex-shrink-0" />
          <span className="min-w-0">Part of this lineage didn&apos;t load, so these counts are floors.</span>
          <button
            type="button"
            onClick={() => lensWalk.retryWalk(nodeId)}
            className="ml-auto flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md font-semibold bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 cursor-pointer transition-colors"
          >
            <LucideIcons.RotateCw className="w-3 h-3" />
            Retry
          </button>
        </div>
      )}
      {walkEntry?.status === 'error' && (
        <div className="flex items-center gap-2 mb-3 px-2.5 py-1.5 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] text-[10.5px] text-amber-700 dark:text-amber-400">
          <LucideIcons.AlertTriangle className="w-3 h-3 flex-shrink-0" />
          <span className="min-w-0">Couldn&apos;t walk this entity&apos;s lineage in the data source — showing only what&apos;s loaded on the canvas.</span>
          <button
            type="button"
            onClick={() => lensWalk.retry(nodeId)}
            className="ml-auto flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md font-semibold bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 cursor-pointer transition-colors"
          >
            <LucideIcons.RotateCw className="w-3 h-3" />
            Retry
          </button>
        </div>
      )}

      {/* Fetch narration — a failed or capped source fetch is SAID,
          never silently rendered as smaller counts. */}
      {fetchState === 'error' && (
        <div className="flex items-center gap-2 mb-3 px-2.5 py-1.5 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] text-[10.5px] text-amber-700 dark:text-amber-400">
          <LucideIcons.AlertTriangle className="w-3 h-3 flex-shrink-0" />
          <span className="min-w-0">Couldn&apos;t fetch this entity&apos;s lineage from the data source — showing only what&apos;s loaded on the canvas.</span>
          {/* A real, obvious hit target — the old text-link retry was
              easy to miss and hard to click. Force-clears the cache for
              this node so it always re-attempts, even after a prior fail. */}
          <button
            type="button"
            onClick={() => sourceFetch.retry(nodeId)}
            className="ml-auto flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md font-semibold bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 cursor-pointer transition-colors"
          >
            <LucideIcons.RotateCw className="w-3 h-3" />
            Retry
          </button>
        </div>
      )}
      {unreachable && (
        <div className="flex items-start gap-2 mb-3 px-2.5 py-1.5 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] text-[10.5px] text-amber-700 dark:text-amber-400">
          <LucideIcons.AlertTriangle className="w-3 h-3 flex-shrink-0 mt-0.5" />
          <span className="min-w-0">
            This view doesn&apos;t hold that entity, so the canvas can&apos;t show it.
            Trace or the Focus Lens will still walk to it.
          </span>
          <button
            type="button"
            onClick={() => setUnreachable(null)}
            className="ml-auto flex-shrink-0 px-1.5 py-0.5 rounded-md font-semibold hover:bg-amber-500/15 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}
      {fetchState === 'done' && sourceFetch.truncatedIds.has(nodeId) && (
        <div className="flex items-center gap-2 mb-3 px-2.5 py-1.5 rounded-lg border border-black/[0.06] dark:border-white/[0.06] bg-black/[0.02] dark:bg-white/[0.02] text-[10.5px] text-ink-muted">
          <LucideIcons.Info className="w-3 h-3 flex-shrink-0" />
          <span>Large neighborhood — showing the first {EDGE_FETCH_LIMIT} flows per direction from the data source.</span>
        </div>
      )}


      <ParentLabelContext.Provider value={parentLabelOf}>
      <div className="space-y-2">
        <DirectionCard
          direction="incoming"
          label="Data Sources"
          subLabel={walkMode ? walkSubLabel(upSide, 'Upstream') : `Upstream ${unitNoun(incomingCount, 'neighbors')}`}
          count={incomingCount}
          floor={walkFloor}
          records={incomingRecords}
          fetchState={walkMode ? (counting ? 'loading' : walkDone ? 'done' : undefined) : fetchState}
          expanded={expanded === 'incoming'}
          onToggle={() => toggle('incoming')}
          onNeighborClick={handleNeighborClick}
          selectionEnabled={!!onLocateMany}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
          detail={walkMode && upSide ? (
            <PartnerTreeDetail
              side={upSide}
              direction="incoming"
              nameOf={walkNameOf}
              onNeighborClick={handleNeighborClick}
              selectionEnabled={!!onLocateMany}
              selectedIds={selectedIds}
              setSelectedIds={setSelectedIds}
              counting={counting}
            />
          ) : undefined}
          {...showAllProps(walkMode ? upSide?.peers : incomingRecords.map((r) => r.neighborId), walkMode ? upSide : null)}
        />
        <DirectionCard
          direction="outgoing"
          label="Data Consumers"
          subLabel={walkMode ? walkSubLabel(downSide, 'Downstream') : `Downstream ${unitNoun(outgoingCount, 'neighbors')}`}
          count={outgoingCount}
          floor={walkFloor}
          records={outgoingRecords}
          fetchState={walkMode ? (counting ? 'loading' : walkDone ? 'done' : undefined) : fetchState}
          expanded={expanded === 'outgoing'}
          onToggle={() => toggle('outgoing')}
          onNeighborClick={handleNeighborClick}
          selectionEnabled={!!onLocateMany}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
          detail={walkMode && downSide ? (
            <PartnerTreeDetail
              side={downSide}
              direction="outgoing"
              nameOf={walkNameOf}
              onNeighborClick={handleNeighborClick}
              selectionEnabled={!!onLocateMany}
              selectedIds={selectedIds}
              setSelectedIds={setSelectedIds}
              counting={counting}
            />
          ) : undefined}
          {...showAllProps(walkMode ? downSide?.peers : outgoingRecords.map((r) => r.neighborId), walkMode ? downSide : null)}
        />
      </div>
      </ParentLabelContext.Provider>

      {/* Sticky action bar at the panel level (outside the DirectionCards'
          overflow-hidden wrappers) so it can anchor to the drawer scroll
          container and stay reachable when the neighbor list runs long
          (200+ rows). Backdrop blur + a top hairline so it reads as a
          separate surface when content scrolls behind it. */}
      <AnimatePresence>
        {onLocateMany && selectedIds.size > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15 }}
            className={cn(
              'sticky bottom-0 z-10 mt-2',
              '-mx-5 px-5 pt-2 pb-3',
              'bg-canvas-elevated/85 backdrop-blur-md',
              'border-t border-glass-border/50',
            )}
          >
            <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-accent-lineage/15 border border-accent-lineage/40 shadow-lg shadow-black/30">
              <span className="text-[12px] font-medium text-ink">
                {selectedIds.size} selected
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={clearSelected}
                  className="px-2.5 py-1 rounded-md text-[11px] font-medium text-ink-muted hover:text-ink hover:bg-white/[0.06] transition-colors duration-150"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={handleLocateMany}
                  disabled={locateBusy}
                  className={cn(
                    'px-3 py-1 rounded-md text-[11px] font-semibold bg-accent-lineage text-white shadow-sm hover:brightness-110 transition-all duration-150 flex items-center gap-1.5',
                    locateBusy && 'opacity-70 cursor-progress',
                  )}
                >
                  {locateBusy ? (
                    <LucideIcons.Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <LucideIcons.Crosshair className="w-3 h-3" />
                  )}
                  Locate {selectedIds.size} on canvas
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ============================================
// Direction card — summary + expandable detail in a single container
// ============================================

interface DirectionCardProps {
  direction: Direction
  label: string
  subLabel: string
  count: number
  records: NeighborRecord[]
  /** On-demand source-fetch status for the focal node — an in-flight
   *  fetch must not read as "no flows", and a completed one
   *  upgrades the empty copy to a data-source claim. */
  fetchState?: 'loading' | 'done' | 'error'
  expanded: boolean
  onToggle: () => void
  onNeighborClick: (neighborId: string) => void | Promise<void>
  /** Selection-mode props supplied by LineageNeighbors. Enabled means the
   *  parent has an `onLocateMany` handler and is rendering the action
   *  bar; the cards therefore show checkboxes and forward selection
   *  events. */
  selectionEnabled: boolean
  selectedIds: Set<string>
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>
  /** Reveal every partner in this direction on the canvas, in one click.
   *  Without it, seeing them meant leaving the drawer and finding each one
   *  by hand — or ticking them one at a time. */
  onShowAll?: () => void | Promise<void>
  /** The Show-all button's words, when they are not "Show all N". */
  showAllLabel?: string
  /** The count is a floor — the walk has not finished. */
  floor?: boolean
  /** The expanded body, when it is not the flat list of `records` — the
   *  walk's partner tree. */
  detail?: React.ReactNode
}

/** "Show all N on canvas" — the one-click alternative to ticking each row.
 *  Busy while the reveal cascade runs, because revealing a dozen partners
 *  expands their ancestors one at a time and silence would read as nothing
 *  happening. */
function ShowAllOnCanvas({
  direction,
  label,
  onShowAll,
}: {
  direction: Direction
  label: string
  onShowAll: () => void | Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const isIncoming = direction === 'incoming'
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        if (busy) return
        setBusy(true)
        try { await onShowAll() } finally { setBusy(false) }
      }}
      className={cn(
        'w-full flex items-center justify-center gap-1.5 px-3 py-1.5',
        'border-t border-white/[0.06] text-[11.5px] font-medium',
        'transition-colors duration-150 focus-visible:outline-none',
        'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-lineage/40',
        busy
          ? 'text-ink-muted cursor-progress'
          : isIncoming
            ? 'text-lineage-in hover:bg-lineage-in/10'
            : 'text-lineage-out hover:bg-lineage-out/10',
      )}
    >
      {busy
        ? <LucideIcons.Loader2 className="w-3.5 h-3.5 animate-spin" />
        : <LucideIcons.Sparkles className="w-3.5 h-3.5" />}
      {busy ? 'Revealing…' : label}
    </button>
  )
}

function DirectionCard({
  direction,
  label,
  subLabel,
  count,
  records,
  fetchState,
  expanded,
  onToggle,
  onNeighborClick,
  selectionEnabled,
  selectedIds,
  setSelectedIds,
  onShowAll,
  showAllLabel,
  floor = false,
  detail,
}: DirectionCardProps) {
  const isIncoming = direction === 'incoming'
  const ArrowIcon = isIncoming
    ? LucideIcons.ArrowDownLeft
    : LucideIcons.ArrowUpRight

  // Colour tokens — the product's lineage DIRECTION pair (incoming /
  // outgoing, lib/lineageDirectionColors.ts): the same colours as the
  // canvas's ports, the Focus Lens and a trace, and the reader's choice.
  const tokens = isIncoming
    ? {
        accent: 'text-lineage-in',
        bg: 'bg-lineage-in/10',
        bgHover: 'group-hover:bg-lineage-in/15',
        ring: 'border-lineage-in/20',
        ringExpanded: 'border-lineage-in/40',
        gradient:
          'bg-[linear-gradient(135deg,rgb(var(--nx-lineage-in-rgb)/0.08)_0%,transparent_55%)]',
      }
    : {
        accent: 'text-lineage-out',
        bg: 'bg-lineage-out/10',
        bgHover: 'group-hover:bg-lineage-out/15',
        ring: 'border-lineage-out/20',
        ringExpanded: 'border-lineage-out/40',
        gradient:
          'bg-[linear-gradient(135deg,rgb(var(--nx-lineage-out-rgb)/0.08)_0%,transparent_55%)]',
      }

  const disabled = count === 0

  return (
    <div
      className={cn(
        'rounded-2xl border transition-colors duration-200 overflow-hidden',
        expanded ? tokens.ringExpanded : tokens.ring,
        disabled && 'opacity-60',
      )}
    >
      {/* Summary header */}
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        className={cn(
          'group relative w-full flex items-center gap-3 p-3.5 text-left transition-colors duration-200',
          tokens.gradient,
          !disabled && 'hover:bg-white/[0.02] cursor-pointer',
          disabled && 'cursor-default',
        )}
      >
        <div
          className={cn(
            'w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors duration-200',
            tokens.bg,
            !disabled && tokens.bgHover,
          )}
        >
          <ArrowIcon className={cn('w-5 h-5', tokens.accent)} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            {count === 0 && fetchState === 'loading' ? (
              <LucideIcons.Loader2 className={cn('w-5 h-5 animate-spin self-center', tokens.accent)} />
            ) : (
              <span
                className={cn(
                  'text-2xl font-display font-semibold tabular-nums leading-none',
                  tokens.accent,
                )}
              >
                {count.toLocaleString()}{floor && count > 0 ? '+' : ''}
              </span>
            )}
            <span className="text-sm font-medium text-ink truncate">
              {label}
            </span>
            {floor && fetchState === 'loading' && count > 0 && (
              <LucideIcons.Loader2 className={cn('w-3.5 h-3.5 animate-spin self-center', tokens.accent)} aria-label="Still counting" />
            )}
          </div>
          <div className="text-[11px] text-ink-muted mt-0.5">
            {count === 0 && fetchState === 'loading'
              ? 'Checking the data source…'
              // Post-fetch zero is a claim about the data source, not
              // about what the canvas happens to have loaded.
              : count === 0 && fetchState === 'done'
                ? 'None found in the data source'
                : subLabel}
          </div>
        </div>

        {!disabled && (
          <div
            className={cn(
              'w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors duration-200',
              expanded
                ? cn(tokens.bg, tokens.accent)
                : 'text-ink-muted group-hover:bg-white/10 group-hover:text-ink',
            )}
          >
            <LucideIcons.ChevronDown
              className={cn(
                'w-4 h-4 transition-transform duration-200',
                expanded && 'rotate-180',
              )}
            />
          </div>
        )}
      </button>

      {/* One click to put them all on the board. A sibling of the header
          rather than a control inside it: the header is itself a button, and
          the expand toggle must stay the whole row's job. */}
      {!disabled && onShowAll && (
        <ShowAllOnCanvas direction={direction} label={showAllLabel ?? `Show all ${count} on canvas`} onShowAll={onShowAll} />
      )}

      <AnimatePresence initial={false}>
        {expanded && !disabled && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t border-white/[0.06]">
              {detail ?? (
                <ExpandedDetail
                  records={records}
                  direction={direction}
                  onNeighborClick={onNeighborClick}
                  selectionEnabled={selectionEnabled}
                  selectedIds={selectedIds}
                  setSelectedIds={setSelectedIds}
                />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ============================================
// Expanded detail
// ============================================

interface ExpandedDetailProps {
  records: NeighborRecord[]
  direction: Direction
  onNeighborClick: (neighborId: string) => void | Promise<void>
  /** Selection lives at LineageNeighbors so the action bar can be sticky
   *  outside this card's overflow-hidden wrappers. ExpandedDetail still
   *  owns the visible-order list + range-select anchor (both naturally
   *  scoped to this direction's filter/sort state). */
  selectionEnabled: boolean
  selectedIds: Set<string>
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>
}

function ExpandedDetail({
  records,
  direction,
  onNeighborClick,
  selectionEnabled,
  selectedIds,
  setSelectedIds,
}: ExpandedDetailProps) {
  const [activeEntityTypes, setActiveEntityTypes] = useState<Set<string>>(
    new Set(),
  )
  const [activeEdgeTypes, setActiveEdgeTypes] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [sortMode, setSortMode] = useState<SortMode>('default')
  // Range-select anchor: id of the last single-toggled row in THIS
  // direction's view. Shift-clicking another row selects everything
  // between them in visible order. Anchor is per-direction because
  // visible-order changes when you toggle direction or filter.
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null)

  const entityTypeFacets = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of records) {
      const t = r.neighborNode?.data.type ?? 'unknown'
      counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [records])

  const edgeTypeFacets = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of records) {
      counts.set(r.edgeTypeNorm, (counts.get(r.edgeTypeNorm) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [records])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return records.filter((r) => {
      if (
        activeEntityTypes.size > 0 &&
        !activeEntityTypes.has(r.neighborNode?.data.type ?? 'unknown')
      )
        return false
      if (activeEdgeTypes.size > 0 && !activeEdgeTypes.has(r.edgeTypeNorm))
        return false
      if (q) {
        const d = r.neighborNode?.data
        const hay = [
          d?.label,
          d?.businessLabel,
          d?.urn,
          r.neighborId,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [records, activeEntityTypes, activeEdgeTypes, search])

  const grouped = useMemo(() => {
    const g = new Map<string, NeighborRecord[]>()
    for (const r of filtered) {
      const t = r.neighborNode?.data.type ?? 'unknown'
      const bucket = g.get(t) ?? []
      bucket.push(r)
      g.set(t, bucket)
    }
    // Sort rows within each group per the selected SortMode. Groups
    // themselves stay ordered by descending size — keeps the most-relevant
    // entity types at the top regardless of internal row order.
    if (sortMode !== 'default') {
      const labelOf = (r: NeighborRecord) => {
        const d = r.neighborNode?.data
        return (d?.businessLabel || d?.label || d?.urn || r.neighborId).toLowerCase()
      }
      const cmp = sortMode === 'name-asc'
        ? (a: NeighborRecord, b: NeighborRecord) => labelOf(a).localeCompare(labelOf(b))
        : (a: NeighborRecord, b: NeighborRecord) => labelOf(b).localeCompare(labelOf(a))
      for (const [, rows] of g) rows.sort(cmp)
    }
    return [...g.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [filtered, sortMode])

  // Multi-select helpers ------------------------------------------------
  // Visible-order id list (post filter + sort + group). Drives both
  // shift-click range-select and the "Select all" button.
  const flatVisibleIds = useMemo(
    () => grouped.flatMap(([, rows]) => rows.map((r) => r.neighborId)),
    [grouped],
  )

  // Row checkbox click. With shift held, selects every row between the
  // anchor and this row (inclusive) in visible order. Without shift,
  // toggles single + updates the anchor. The set-union semantics match
  // Finder / VSCode shift-click.
  const handleRowSelectClick = (id: string, shiftKey: boolean) => {
    if (shiftKey && lastSelectedId && lastSelectedId !== id) {
      const anchorIdx = flatVisibleIds.indexOf(lastSelectedId)
      const targetIdx = flatVisibleIds.indexOf(id)
      if (anchorIdx >= 0 && targetIdx >= 0) {
        const [lo, hi] =
          anchorIdx < targetIdx
            ? [anchorIdx, targetIdx]
            : [targetIdx, anchorIdx]
        const range = flatVisibleIds.slice(lo, hi + 1)
        setSelectedIds(new Set([...selectedIds, ...range]))
        setLastSelectedId(id)
        return
      }
    }
    // Single-toggle fallback (no anchor, anchor filtered out, or no shift).
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
    setLastSelectedId(id)
  }

  // Group-level toggle: if every row in the group is selected, remove
  // them all; otherwise add the missing ones. Three-state UI (none /
  // partial / all) collapses to two-state interaction.
  const handleToggleGroup = (groupIds: string[], allSelected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allSelected) groupIds.forEach((g) => next.delete(g))
      else groupIds.forEach((g) => next.add(g))
      return next
    })
  }

  // Whole-list toggle for the "Select all" affordance. Operates on the
  // filtered view so users don't end up with hidden selected items.
  const allVisibleSelected =
    flatVisibleIds.length > 0 &&
    flatVisibleIds.every((id) => selectedIds.has(id))
  const toggleAllVisible = () => {
    if (allVisibleSelected) {
      // Remove only the visible ones — preserves any selections that may
      // exist outside the current filter (defensive; in practice we prune
      // those via the useEffect below).
      setSelectedIds((prev) => {
        const next = new Set(prev)
        flatVisibleIds.forEach((id) => next.delete(id))
        return next
      })
    } else {
      setSelectedIds((prev) => new Set([...prev, ...flatVisibleIds]))
    }
  }

  // Selection is owned by LineageNeighbors so the action bar can be
  // sticky outside the DirectionCard's overflow-hidden wrappers. The
  // selection no longer gets pruned on filter change — that was the
  // direction-scoped behaviour; panel-wide selection means a row hidden
  // by THIS card's filter is still meaningfully selected (the user can
  // see the action-bar count and clear/find via the other direction or
  // by relaxing filters).

  const toggleSet = (
    set: Set<string>,
    setter: (s: Set<string>) => void,
    key: string,
  ) => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setter(next)
  }

  const activeFilterCount = activeEntityTypes.size + activeEdgeTypes.size
  const clearAllFilters = () => {
    setActiveEntityTypes(new Set())
    setActiveEdgeTypes(new Set())
    setSearch('')
  }

  const isFilteredEmpty = filtered.length === 0
  const unloadedCount = filtered.filter((r) => !r.neighborNode).length

  return (
    <div className="p-3 space-y-3">
      {/* Search + sort row — paired so users can re-order while keeping
          search context. Sort menu is hidden when there's only one row. */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <LucideIcons.Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or URN…"
            className="w-full pl-9 pr-8 py-2 text-xs rounded-lg bg-black/10 dark:bg-white/[0.04] border border-white/10 focus:border-accent-lineage/40 focus:bg-white/[0.06] outline-none transition-colors duration-150 placeholder:text-ink-muted/70"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-ink-muted hover:text-ink hover:bg-white/10 transition-colors duration-150"
              title="Clear search"
            >
              <LucideIcons.X className="w-3 h-3" />
            </button>
          )}
        </div>
        {records.length > 1 && (
          <SortMenu value={sortMode} onChange={setSortMode} />
        )}
        {selectionEnabled && flatVisibleIds.length > 0 && (
          <button
            type="button"
            onClick={toggleAllVisible}
            aria-pressed={allVisibleSelected}
            // Explicit aria-label so this button's accessible name doesn't
            // collide with the per-group "Select all <Type>" checkbox.
            aria-label={
              allVisibleSelected
                ? 'Deselect all visible neighbors'
                : `Select all ${flatVisibleIds.length} visible neighbors`
            }
            className={cn(
              'inline-flex items-center gap-1 px-2 py-2 rounded-lg text-[11px] font-medium border transition-colors duration-150 whitespace-nowrap',
              allVisibleSelected
                ? 'text-accent-lineage bg-accent-lineage/10 border-accent-lineage/30'
                : 'text-ink-muted bg-white/[0.04] border-white/10 hover:text-ink hover:border-white/20',
            )}
          >
            {allVisibleSelected ? (
              <LucideIcons.CheckSquare className="w-3.5 h-3.5" />
            ) : (
              <LucideIcons.Square className="w-3.5 h-3.5" />
            )}
            <span className="hidden sm:inline">
              {allVisibleSelected ? 'Deselect all' : `Select all (${flatVisibleIds.length})`}
            </span>
          </button>
        )}
      </div>

      {/* Active filter strip — quick visibility of what's narrowing the list,
          plus a one-click escape hatch. */}
      {activeFilterCount > 0 && (
        <div className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg bg-accent-lineage/5 border border-accent-lineage/20">
          <span className="text-[11px] text-accent-lineage font-medium">
            {activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'} active
          </span>
          <button
            type="button"
            onClick={clearAllFilters}
            className="text-[10px] font-medium text-accent-lineage/80 hover:text-accent-lineage uppercase tracking-wide"
          >
            Clear all
          </button>
        </div>
      )}

      {/* Filter facets — only render when there's something to choose. */}
      {entityTypeFacets.length > 1 && (
        <FilterChipRow
          label="Entity type"
          icon={LucideIcons.Tag}
          facets={entityTypeFacets}
          active={activeEntityTypes}
          onToggle={(k) => toggleSet(activeEntityTypes, setActiveEntityTypes, k)}
          variant="entity"
        />
      )}
      {edgeTypeFacets.length > 1 && (
        <FilterChipRow
          label="Relationship"
          icon={LucideIcons.Link2}
          facets={edgeTypeFacets}
          active={activeEdgeTypes}
          onToggle={(k) => toggleSet(activeEdgeTypes, setActiveEdgeTypes, k)}
          variant="edge"
        />
      )}

      {/* Results */}
      <div className="space-y-1.5">
        {isFilteredEmpty ? (
          <EmptyState
            icon={
              activeFilterCount > 0 || search
                ? LucideIcons.SearchX
                : LucideIcons.Unlink
            }
            title={
              activeFilterCount > 0 || search
                ? 'No matching flows'
                : 'No flows in this direction'
            }
            hint={
              activeFilterCount > 0 || search
                ? 'Try clearing filters or the search.'
                : undefined
            }
          />
        ) : (
          grouped.map(([type, rows]) => (
            <EntityTypeGroup
              key={type}
              type={type}
              rows={rows}
              direction={direction}
              collapsed={collapsedGroups.has(type)}
              onToggleCollapse={() =>
                toggleSet(collapsedGroups, setCollapsedGroups, type)
              }
              onNeighborClick={onNeighborClick}
              selectionEnabled={selectionEnabled}
              selectionActive={selectedIds.size > 0}
              selectedIds={selectedIds}
              onToggleRow={handleRowSelectClick}
              onToggleGroup={handleToggleGroup}
            />
          ))
        )}

        {unloadedCount > 0 && !isFilteredEmpty && (
          <div className="flex items-start gap-1.5 text-[11px] text-ink-muted/70 px-2 pt-1.5">
            <LucideIcons.Info className="w-3 h-3 flex-shrink-0 mt-0.5" />
            <span>
              {unloadedCount} neighbor{unloadedCount === 1 ? '' : 's'} not
              currently rendered on canvas — expand the graph to see details.
            </span>
          </div>
        )}
      </div>

    </div>
  )
}

// ============================================
// Filter chips
// ============================================

interface FilterChipRowProps {
  label: string
  icon: React.ComponentType<{ className?: string }>
  facets: Array<[string, number]>
  active: Set<string>
  onToggle: (key: string) => void
  variant: 'entity' | 'edge'
}

function FilterChipRow({
  label,
  icon: Icon,
  facets,
  active,
  onToggle,
  variant,
}: FilterChipRowProps) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon className="w-3 h-3 text-ink-muted/70" />
        <span className="text-[10px] font-semibold text-ink-muted/70 uppercase tracking-wider">
          {label}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {facets.map(([key, count]) => (
          <FilterChip
            key={key}
            entryKey={key}
            count={count}
            active={active.has(key)}
            onClick={() => onToggle(key)}
            variant={variant}
          />
        ))}
      </div>
    </div>
  )
}

interface FilterChipProps {
  entryKey: string
  count: number
  active: boolean
  onClick: () => void
  variant: 'entity' | 'edge'
}

function FilterChip({
  entryKey,
  count,
  active,
  onClick,
  variant,
}: FilterChipProps) {
  const schema = useSchemaStore((s) => s.schema)

  let color = '#6b7280'
  let displayName = entryKey
  if (variant === 'entity') {
    const et = schema?.entityTypes.find((t) => t.id === entryKey)
    color = et?.visual.color ?? generateColorFromType(entryKey)
    displayName = et?.name ?? entryKey
  } else {
    const rt = schema?.relationshipTypes.find(
      (r) => r.id.toUpperCase() === entryKey.toUpperCase(),
    )
    color = rt?.visual.strokeColor ?? generateEdgeColorFromType(entryKey)
    displayName = rt?.name ?? entryKey.toLowerCase()
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 pl-1.5 pr-2 py-1 rounded-full text-[11px] font-medium transition-all duration-150 border',
        active
          ? 'border-transparent shadow-sm'
          : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/20 text-ink-muted hover:text-ink',
      )}
      style={
        active
          ? { backgroundColor: `${color}28`, color, borderColor: `${color}40` }
          : undefined
      }
    >
      <span
        className="w-2 h-2 rounded-full flex-shrink-0"
        style={{ backgroundColor: color }}
      />
      <span className="truncate max-w-[120px]">{displayName}</span>
      <span
        className={cn(
          'text-[10px] tabular-nums px-1 py-px rounded-full',
          active ? 'bg-white/10' : 'bg-white/[0.04]',
        )}
        style={active ? { color } : undefined}
      >
        {count}
      </span>
    </button>
  )
}

// ============================================
// Grouped neighbor list
// ============================================

interface EntityTypeGroupProps {
  type: string
  rows: NeighborRecord[]
  direction: Direction
  collapsed: boolean
  onToggleCollapse: () => void
  onNeighborClick: (neighborId: string) => void | Promise<void>
  selectionEnabled: boolean
  /** True when any row across the whole panel is selected. Drives the
   *  hover-vs-always-on behaviour of the per-row checkbox. */
  selectionActive: boolean
  selectedIds: Set<string>
  onToggleRow: (id: string, shiftKey: boolean) => void
  onToggleGroup: (groupIds: string[], allSelected: boolean) => void
}

function EntityTypeGroup({
  type,
  rows,
  direction,
  collapsed,
  onToggleCollapse,
  onNeighborClick,
  selectionEnabled,
  selectionActive,
  selectedIds,
  onToggleRow,
  onToggleGroup,
}: EntityTypeGroupProps) {
  const schema = useSchemaStore((s) => s.schema)
  const entityType = schema?.entityTypes.find((t) => t.id === type)
  const color = entityType?.visual.color ?? generateColorFromType(type)
  const displayName =
    entityType?.pluralName ?? entityType?.name ?? type
  const IconCmp =
    (entityType?.visual.icon &&
      ((LucideIcons as unknown as Record<string, unknown>)[
        entityType.visual.icon
      ] as React.ComponentType<{ className?: string }> | undefined)) ||
    undefined

  // Group selection: tri-state derived from the rows' selection status.
  // "Partial" means some-but-not-all are selected — shown as a dash icon
  // to mirror standard tri-state checkbox UX (macOS Finder, Gmail).
  const groupIds = useMemo(() => rows.map((r) => r.neighborId), [rows])
  const allGroupSelected = groupIds.every((id) => selectedIds.has(id))
  const someGroupSelected =
    !allGroupSelected && groupIds.some((id) => selectedIds.has(id))

  return (
    <div className="rounded-xl bg-white/[0.02] border border-white/[0.06] overflow-hidden">
      <div className="group/header flex items-center gap-2 px-3 py-2 hover:bg-white/[0.04] transition-colors duration-150">
        {selectionEnabled && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onToggleGroup(groupIds, allGroupSelected)
            }}
            aria-label={
              allGroupSelected
                ? `Deselect all ${displayName}`
                : `Select all ${displayName}`
            }
            aria-pressed={allGroupSelected}
            className={cn(
              'w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-all duration-150',
              allGroupSelected
                ? 'bg-accent-lineage border-accent-lineage text-white'
                : someGroupSelected
                  ? 'bg-accent-lineage/30 border-accent-lineage/60 text-accent-lineage'
                  : 'border-white/20 hover:border-accent-lineage/60',
              // Mirror the row-checkbox hover-reveal logic so the group
              // checkbox doesn't feel like a separate affordance.
              !allGroupSelected && !someGroupSelected && !selectionActive
                ? 'opacity-0 group-hover/header:opacity-100'
                : 'opacity-100',
            )}
          >
            {allGroupSelected ? (
              <LucideIcons.Check className="w-2.5 h-2.5" />
            ) : someGroupSelected ? (
              <LucideIcons.Minus className="w-2.5 h-2.5" />
            ) : null}
          </button>
        )}
        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
        >
          <LucideIcons.ChevronDown
            className={cn(
              'w-3.5 h-3.5 text-ink-muted/70 transition-transform duration-200',
              collapsed && '-rotate-90',
            )}
          />
          <div
            className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: `${color}1f` }}
          >
            {IconCmp ? (
              <IconCmp className="w-3 h-3" />
            ) : (
              <span
                className="w-1.5 h-1.5 rounded-full"
                style={{ backgroundColor: color }}
              />
            )}
          </div>
          <span
            className="text-[11px] font-semibold uppercase tracking-wide truncate"
            style={{ color }}
          >
            {displayName}
          </span>
          <span className="ml-auto inline-flex items-center justify-center min-w-[20px] h-[18px] px-1.5 rounded-full bg-white/[0.06] text-[10px] font-medium text-ink-muted tabular-nums">
            {rows.length}
          </span>
        </button>
      </div>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="border-t border-white/[0.04] divide-y divide-white/[0.04]">
              {rows.map((r) => (
                <NeighborRow
                  key={r.edge.id + ':' + r.direction}
                  record={r}
                  direction={direction}
                  onClick={() => onNeighborClick(r.neighborId)}
                  selectionEnabled={selectionEnabled}
                  selectionActive={selectionActive}
                  selected={selectedIds.has(r.neighborId)}
                  onToggleSelected={(shiftKey) =>
                    onToggleRow(r.neighborId, shiftKey)
                  }
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** Partner → its containing entity's name. A cross-cutting lookup rather
 *  than a structural prop: it would otherwise be drilled through the
 *  direction card, the filter rows and the type group to reach one line of
 *  one row. Empty by default, so a row simply falls back to the urn. */
const ParentLabelContext = createContext<ReadonlyMap<string, string>>(new Map())

function NeighborRow({
  record,
  direction,
  onClick,
  selectionEnabled,
  selectionActive,
  selected,
  onToggleSelected,
}: {
  record: NeighborRecord
  direction: Direction
  onClick: () => void | Promise<void>
  selectionEnabled: boolean
  /** True when any row in the panel is currently selected. Keeps the
   *  per-row checkbox visible so the user can extend the selection
   *  without hunting for the hover-reveal target. */
  selectionActive: boolean
  selected: boolean
  /** Receives the shift modifier so the parent can implement
   *  shift-click range-select semantics. */
  onToggleSelected: (shiftKey: boolean) => void
}) {
  const [busy, setBusy] = useState(false)
  const { neighborNode, edgeTypeNorm, neighborId, alsoTypes } = record
  const parentLabel = useContext(ParentLabelContext).get(neighborId)
  const isIncoming = direction === 'incoming'
  const accent = isIncoming ? 'text-lineage-in' : 'text-lineage-out'
  const accentBg = isIncoming ? 'bg-lineage-in/10' : 'bg-lineage-out/10'
  const ArrowIcon = isIncoming
    ? LucideIcons.ArrowDownLeft
    : LucideIcons.ArrowUpRight

  const data = neighborNode?.data
  // This panel is not persona-scoped — it always shows the friendly name, with
  // the URN underneath. Precedence via the shared resolver so it agrees with the
  // drawer and the canvas rows. (It used to prefer a `technicalLabel` that no
  // mapper ever writes and no backend field defines, so the URN was already what
  // rendered here; the dead branch is gone, the output is unchanged.)
  const label = resolveEntityName(data, 'business', neighborId)
  // The parent first — it is what tells two identically-named fields apart.
  // The urn stays as the fallback for a partner whose parent never arrived.
  const secondary = parentLabel ?? data?.urn ?? neighborId
  const showSecondary = secondary && secondary !== label

  // Reveal lifecycle: while the parent's `onClick` (the canvas's reveal
  // cascade) is in flight, swap the trailing chevron for a spinner and
  // disable the row to avoid double-triggers.
  const handleClick = async () => {
    if (busy) return
    setBusy(true)
    try {
      await onClick()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={cn(
        'group relative w-full flex items-center gap-2.5 px-3 py-2 transition-colors duration-150',
        selected
          ? 'bg-accent-lineage/10 hover:bg-accent-lineage/15'
          : 'hover:bg-white/[0.05]',
        busy && 'cursor-progress',
      )}
    >
      {/* Multi-select checkbox — visibility follows the hover-reveal
          contract:
          - Selected rows: always visible (filled).
          - Any-row-selected anywhere in panel: always visible (hollow).
          - Idle: hidden, fades in on row hover.
          stopPropagation keeps checkbox clicks from also firing the
          row's reveal navigation. */}
      {selectionEnabled && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggleSelected(e.shiftKey)
          }}
          aria-label={selected ? 'Deselect neighbor' : 'Select neighbor'}
          aria-pressed={selected}
          className={cn(
            'w-4 h-4 rounded border flex items-center justify-center flex-shrink-0',
            'transition-opacity duration-150',
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
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className="flex-1 flex items-center gap-2.5 min-w-0 text-left"
        title={data?.urn ?? neighborId}
      >
      <div
        className={cn(
          'w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 transition-colors duration-150',
          accentBg,
          !busy && 'group-hover:scale-105',
        )}
      >
        <ArrowIcon className={cn('w-3 h-3', accent)} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] text-ink truncate font-medium leading-snug">
          {label}
        </div>
        {neighborNode ? (
          showSecondary && (
            <div className="text-[10px] text-ink-muted truncate font-mono leading-tight">
              {secondary}
            </div>
          )
        ) : (
          <div className="text-[10px] text-amber-500/90 flex items-center gap-1 leading-tight">
            <LucideIcons.AlertCircle className="w-2.5 h-2.5" />
            Not rendered on canvas
          </div>
        )}
      </div>
      <EdgeTypeChip edgeType={edgeTypeNorm} />
      {/* Relationships folded into this one flow — named here
          rather than given a duplicate row of their own. */}
      {alsoTypes.map(t => <EdgeTypeChip key={t} edgeType={t} muted />)}
      {busy ? (
        <LucideIcons.Loader2
          data-testid="reveal-spinner"
          className={cn('w-3.5 h-3.5 animate-spin flex-shrink-0', accent)}
        />
      ) : (
        <LucideIcons.ArrowRight
          className={cn(
            'w-3.5 h-3.5 text-ink-muted/70 transition-all duration-150 flex-shrink-0',
            'opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0',
          )}
        />
      )}
      </button>
    </div>
  )
}

/** `muted` marks a relationship folded into the row's primary one —
 *  present, named, but not competing with the relationship that
 *  actually describes the flow. */
function EdgeTypeChip({ edgeType, muted }: { edgeType: string; muted?: boolean }) {
  const schema = useSchemaStore((s) => s.schema)
  const rt = schema?.relationshipTypes.find(
    (r) => r.id.toUpperCase() === edgeType.toUpperCase(),
  )
  const color = rt?.visual.strokeColor ?? generateEdgeColorFromType(edgeType)
  const displayName = rt?.name ?? edgeType.toLowerCase().replace(/_/g, ' ')

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9.5px] font-semibold uppercase tracking-wide whitespace-nowrap',
        muted && 'opacity-60',
      )}
      title={muted ? `Also connected by ${displayName} — shown as one flow, not two` : undefined}
      style={{ backgroundColor: `${color}1a`, color }}
    >
      <span
        className="w-1 h-1 rounded-full"
        style={{ backgroundColor: color }}
      />
      {displayName}
    </span>
  )
}
