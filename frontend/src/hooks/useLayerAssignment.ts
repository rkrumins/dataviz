/**
 * useLayerAssignment - Extracted from ReferenceModelCanvas.tsx
 *
 * Encapsulates:
 * - layerRules: build layer assignment rules from sorted layers
 * - nodesByLayer: core layer assignment algorithm with deep inheritance
 * - displayFlat / displayMap: flattened node list and lookup map
 * - urnToIdMap: O(1) URN-to-ID lookup
 */

import { useMemo } from 'react'
import type { ViewLayerConfig, LogicalNodeConfig, LayerAssignmentEntry, LayerNodeSortAlgo, LayerNodeSortMode } from '@/types/schema'
import {
  type GraphNode,
  resolveLayerAssignment,
  type LayerAssignmentRule,
} from '@/providers/GraphDataProvider'
import type { HierarchyNode } from '@/types/hierarchy'
import { compareOrderKeys } from '@/utils/orderKeys'
import { useBranchCreatedDelta } from './useBranchCreatedDelta'
import { buildLayerRules, resolveRootLayer } from './lib/resolveRootLayer'
import { resolveEntityName } from '@/lib/entityDisplayName'

// ============================================
// Types
// ============================================

export interface UseLayerAssignmentOptions {
  nodes: any[]
  sortedLayers: ViewLayerConfig[]
  nodeEdgeFingerprint: string
  instanceAssignments: Map<string, { layerId: string }>
  effectiveAssignments: Map<string, { layerId: string }>
  nodeMap: Map<string, any>
  childMap: Map<string, string[]>
  parentMap: Map<string, string>
  /**
   * Canonical urn -> layer assignment map (from normalizeReferenceLayout). A Context View node's id
   * IS its urn, so these keys are node ids. This is the AUTHORITATIVE explicit-assignment source —
   * it replaces the legacy per-layer `entityAssignments`. Defaults to empty (open scope).
   */
  assignments?: Record<string, LayerAssignmentEntry>
  /**
   * View entity scope: 'curated' (closed — only explicitly-assigned roots + the branch-created delta
   * render) vs 'all' (open — fall back to backend/rules/inheritance). Defaults to curated iff
   * `assignments` is non-empty, matching deriveEntityScope for legacy data.
   */
  entityScope?: 'all' | 'curated'
  /**
   * URNs of entities CREATED in the active branch's draft. In a CLOSED-SCOPE
   * view these — and ONLY these — may be placed by their durable, view-valid
   * global `layerAssignment` (leak-safe: no arbitrary global-property node is
   * pulled in). Defaults to the live branch-created delta when omitted; passed
   * explicitly only in tests.
   */
  branchCreatedUrns?: Set<string>
  /**
   * View-wide default node sort (`referenceLayout.defaultNodeSortMode`) for
   * layers without their own `nodeSortMode`. Defaults to 'alpha-asc'.
   */
  defaultNodeSortMode?: LayerNodeSortAlgo
  /**
   * Ephemeral per-layer sort overrides (session-local, e.g. a read-only viewer
   * flipping a column to Z→A or By type). Wins over persisted config;
   * algorithmic modes only — 'custom' requires persisted orderKeys so it
   * can't be an ephemeral state.
   */
  sortOverrides?: ReadonlyMap<string, LayerNodeSortAlgo>
}

export interface UseLayerAssignmentResult {
  layerRules: LayerAssignmentRule[]
  nodesByLayer: Map<string, HierarchyNode[]>
  displayFlat: HierarchyNode[]
  displayMap: Map<string, HierarchyNode>
  urnToIdMap: Map<string, string>
  /** Final effective layer per node id — exposed for layer-ordinal lookups
   *  by the canvas (e.g. left/right neighbor sort for trace pinning). */
  nodeLayerMap: Map<string, string>
  /** Loaded nodes that resolved to NO layer and therefore render nowhere.
   *  Surfaced so the canvas can tell the user instead of hiding them. */
  unassignedNodes: Array<{ id: string; data?: Record<string, unknown> }>
}

// ============================================
// Hook
// ============================================

export function useLayerAssignment({
  nodes,
  sortedLayers,
  nodeEdgeFingerprint,
  instanceAssignments,
  effectiveAssignments,
  nodeMap,
  childMap,
  parentMap,
  assignments = {},
  entityScope,
  branchCreatedUrns: branchCreatedUrnsOption,
  defaultNodeSortMode,
  sortOverrides,
}: UseLayerAssignmentOptions): UseLayerAssignmentResult {

  // Branch-created delta: URNs created in the active branch's draft. Read from
  // the staged-changes store by default; an explicit option overrides it (tests).
  const liveBranchCreatedUrns = useBranchCreatedDelta()
  const branchCreatedDelta = branchCreatedUrnsOption ?? liveBranchCreatedUrns

  // Build layer assignment rules (shared with the trace overlay — see
  // buildLayerRules in lib/resolveRootLayer)
  const layerRules = useMemo<LayerAssignmentRule[]>(() => buildLayerRules(sortedLayers), [sortedLayers])

  // Core Logic: Group nodes by layer with Deep Inheritance support
  const nodesByLayer = useMemo(() => {
    const grouped = new Map<string, HierarchyNode[]>()

    // Per-layer node comparators. Effective mode resolution: ephemeral session
    // override → layer.nodeSortMode → view defaultNodeSortMode → 'alpha-asc'.
    // 'custom' mode is HIERARCHICAL: BOTH roots and children order by their
    // assignment orderKey (keyed entries first, ordinally; unkeyed entries
    // after, alphabetically). The comparator only ever compares siblings (one
    // parent's children, or the layer's roots), so each sibling set holds an
    // independent key sequence. All other modes leave children on the
    // server's alphabetical order (asc, or desc when the whole layer is Z→A).
    const alphaAsc = (a: HierarchyNode, b: HierarchyNode) => a.name.localeCompare(b.name)
    const alphaDesc = (a: HierarchyNode, b: HierarchyNode) => b.name.localeCompare(a.name)
    // Property-derived root orders. Type groups alphabetically by the stable
    // type id (display names would need a schema lookup this hook doesn't
    // have); container size prefers the backend's childCount (total, not just
    // loaded) and falls back to the loaded child list. Both tie-break to
    // name so equal groups stay alphabetical inside.
    const typeAsc = (a: HierarchyNode, b: HierarchyNode) =>
      (a.typeId || '').localeCompare(b.typeId || '') || alphaAsc(a, b)
    const countOf = (n: HierarchyNode) =>
      Number((n.data as Record<string, unknown> | undefined)?.childCount ?? n.children.length) || 0
    const countDesc = (a: HierarchyNode, b: HierarchyNode) =>
      countOf(b) - countOf(a) || alphaAsc(a, b)
    // Custom comparator: keyed siblings first (ordinal orderKey, name+urn
    // tiebreak), unkeyed after (alphabetical). Used for BOTH roots and
    // children of a custom-sorted layer — only ever applied within one
    // sibling set, so the shared function is safe.
    const customCmp = (a: HierarchyNode, b: HierarchyNode) => {
      const ka = assignments[a.id]?.orderKey
      const kb = assignments[b.id]?.orderKey
      if (ka && kb) return compareOrderKeys(ka, kb) || alphaAsc(a, b) || compareOrderKeys(a.urn, b.urn)
      if (ka) return -1
      if (kb) return 1
      return alphaAsc(a, b)
    }
    const ROOT_CMPS: Record<LayerNodeSortMode, (a: HierarchyNode, b: HierarchyNode) => number> = {
      'alpha-asc': alphaAsc,
      'alpha-desc': alphaDesc,
      'type-asc': typeAsc,
      'count-desc': countDesc,
      custom: customCmp,
    }
    const childCmpByLayer = new Map<string, (a: HierarchyNode, b: HierarchyNode) => number>()
    const rootCmpByLayer = new Map<string, (a: HierarchyNode, b: HierarchyNode) => number>()
    sortedLayers.forEach(layer => {
      const mode: LayerNodeSortMode =
        sortOverrides?.get(layer.id) ?? layer.nodeSortMode ?? defaultNodeSortMode ?? 'alpha-asc'
      // Children in 'custom' mode order by orderKey too (hierarchical custom
      // order); every other mode leaves them on the server's alpha order
      // (desc only flips the direction).
      childCmpByLayer.set(layer.id, mode === 'custom' ? customCmp : mode === 'alpha-desc' ? alphaDesc : alphaAsc)
      rootCmpByLayer.set(layer.id, ROOT_CMPS[mode] ?? alphaAsc)
    })

    // Initialize layers
    sortedLayers.forEach(l => grouped.set(l.id, []))

    // 1. Build explicit assignments from the view's CANONICAL assignment map (lowest priority,
    // used as the closed-scope authoritative set). Keyed by urn === node id in a Context View.
    const explicitAssignments = new Map<string, string>() // nodeId -> layerId
    for (const [urn, entry] of Object.entries(assignments)) {
      if (entry?.layerId) explicitAssignments.set(urn, entry.layerId)
    }

    // 2. Build rule-based assignments (fallback if no explicit assignment)
    const ruleAssignments = new Map<string, string>() // nodeId -> layerId
    nodes.forEach(node => {
      // Skip if already has explicit assignment from view
      if (explicitAssignments.has(node.id)) return

      // Rule match
      const graphNode: GraphNode = {
        urn: node.data.urn || node.id,
        entityType: (node.data.type as string) || '',
        displayName: node.data.label || node.data.businessLabel || node.id,
        properties: node.data as Record<string, unknown>,
        tags: node.data.classifications || []
      }

      const ruleLayerId = resolveLayerAssignment(graphNode, layerRules)
      if (ruleLayerId) {
        ruleAssignments.set(node.id, ruleLayerId)
      }
    })

    // 2. Determine "Effective Layer" for every node, considering inheritance
    // We traverse top-down. If a node has explicit, it wins. If not, it inherits.
    const effectiveLayer = new Map<string, string>() // nodeId -> layerId

    // We can't just iterate nodes orderless. We need top-down.
    // Use a Set to track processed.
    const processed = new Set<string>()

    // A CURATED (closed-scope) view treats its canonical ``assignments`` as the
    // AUTHORITATIVE set of root-layer assignments — backend ``effectiveAssignments``
    // and rule-based resolution cannot promote an un-listed root entity into a layer.
    // Reason: the wizard / Layer Studio is the user's source of truth (it shows
    // "Sales is unassigned"); the canvas must agree. Scope is 'curated' either when
    // the view explicitly declares it or, by default, whenever any assignment exists
    // (matches deriveEntityScope). Open ('all') views fall back to backend/rules.
    const viewIsCurated = entityScope ? entityScope === 'curated' : explicitAssignments.size > 0

    // Valid layer ids in this view — a node's persisted `layerAssignment` is only
    // honoured when it still names a layer that exists here.
    const validLayerIds = new Set(sortedLayers.map(l => l.id))

    // Open-scope fallback: a layer opting in via `showUnassigned` receives
    // root entities that match nothing else, instead of those entities
    // silently vanishing from the canvas. Curated views keep their
    // closed-scope drop semantics (the wizard is the source of truth
    // there); the canvas surfaces the count separately.
    const unassignedFallbackLayerId = !viewIsCurated
      ? sortedLayers.find(l => l.showUnassigned === true)?.id
      : undefined

    // Iterative top-down traversal (prevents stack overflow on deep hierarchies)
    // HARD RULE: Containment children ALWAYS inherit parent's layer (no override).
    // Root-level nodes use the priority chain below, with closed-scope
    // semantics when the view has explicit assignments.
    const roots = nodes.filter((n: any) => !parentMap.has(n.id))
    const stack: Array<{ nodeId: string; inheritedLayerId?: string }> = []
    // Push roots in reverse so first root is processed first
    for (let i = roots.length - 1; i >= 0; i--) {
      stack.push({ nodeId: roots[i].id })
    }

    while (stack.length > 0) {
      const { nodeId, inheritedLayerId } = stack.pop()!
      if (processed.has(nodeId)) continue
      processed.add(nodeId)

      let myLayerId: string | undefined

      // HARD RULE: containment children ALWAYS inherit the parent's layer, so a
      // nested subtree renders together under its parent and the containment tree
      // stays intact. Only root-level nodes (no containment parent) use the
      // priority chain below.
      const hasContainmentParent = parentMap.has(nodeId)

      if (hasContainmentParent && inheritedLayerId) {
        myLayerId = inheritedLayerId
      } else {
        // Root-level node priority chain — see resolveRootLayer for full
        // semantics (instance drag → explicit → curated (stamped, only if
        // branch-created) → open (backend → stamped → rule → inherited →
        // showUnassigned fallback); '__UNASSIGNED__' sentinel → undefined).
        const instanceAssignment = instanceAssignments.get(nodeId)
        // Explicit, per-entity layer the app stamped on the node itself — on
        // create (creation layer) and on an explicit move (EntityDrawer "Layer"
        // field → an `update_entity` that rewrites `layerAssignment`). It is the
        // ONLY assignment signal that reliably survives a reload (persisted on the
        // node, rehydrated via toCanvasNode), so we read it HERE in the render
        // authority rather than depending on the backend assignment engine having
        // been re-run. Honoured below session drag + explicit view assignments,
        // but ABOVE generic rules — a broad entity-type rule must not override an
        // explicit per-entity placement (that made a saved move "disappear" on
        // reload). Validated so a stale layer id can't strand the node.
        const rawNodeLayer = nodeMap.get(nodeId)?.data?.layerAssignment as string | undefined
        const nodeLayerId = rawNodeLayer && validLayerIds.has(rawNodeLayer) ? rawNodeLayer : undefined
        const nodeUrn = (nodeMap.get(nodeId)?.data?.urn as string | undefined) ?? nodeId
        const backendAssignment = effectiveAssignments.get(nodeId)
        myLayerId = resolveRootLayer({
          nodeId,
          nodeUrn,
          nodeLayerProp: nodeLayerId,
          instanceAssignment: instanceAssignment?.layerId,
          explicitAssignment: explicitAssignments.get(nodeId),
          viewIsCurated,
          branchCreated: branchCreatedDelta.has(nodeUrn),
          backendAssignment: backendAssignment?.layerId,
          ruleAssignment: ruleAssignments.get(nodeId),
          inheritedLayerId,
          unassignedFallbackLayerId,
        })
      }

      if (myLayerId) effectiveLayer.set(nodeId, myLayerId)

      // Honour `inheritsChildren: false` on this node's OWN explicit entry — its children do NOT
      // inherit its layer; they fall through to the scope's own resolution (their own explicit entry
      // in curated, backend/rules in open). Matches the backend engine's tier-2 containment gate.
      const ownEntry = assignments[nodeId]
      const inheritedForChildren = ownEntry && ownEntry.inheritsChildren === false ? undefined : myLayerId
      const children = childMap.get(nodeId) || []
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ nodeId: children[i], inheritedLayerId: inheritedForChildren })
      }
    }

    // Also handle orphans (cycles or disconnected) if any missed?
    // The recursive step above should cover all reachable from roots.
    // If there are unparented nodes that are not in `roots` (impossible by definition), they are covered.

    // 3. Construct Hierarchy Trees per Layer
    // A node is a "Visual Root" in Layer L if:
    // - It is effectively in Layer L
    // - AND (Its parent is NOT in Layer L OR it has no parent)

    // Iterative hierarchy builder — post-order traversal so children are ready before parents
    const buildHierarchyNode = (rootId: string): HierarchyNode | null => {
      const rootNode = nodeMap.get(rootId)
      if (!rootNode) return null

      const rootLayer = effectiveLayer.get(rootId)
      const childCmp = (rootLayer && childCmpByLayer.get(rootLayer)) || alphaAsc
      // Phase 1: collect nodes in DFS order (iterative)
      const order: Array<{ nodeId: string; depth: number; parentIdx: number }> = []
      const dfsStack: Array<{ nodeId: string; depth: number; parentIdx: number }> = [
        { nodeId: rootId, depth: 0, parentIdx: -1 }
      ]
      while (dfsStack.length > 0) {
        const item = dfsStack.pop()!
        const idx = order.length
        order.push(item)

        const childrenIds = childMap.get(item.nodeId) || []
        // Push in reverse so first child is processed first
        for (let i = childrenIds.length - 1; i >= 0; i--) {
          const cid = childrenIds[i]
          if (effectiveLayer.get(cid) === rootLayer) {
            dfsStack.push({ nodeId: cid, depth: item.depth + 1, parentIdx: idx })
          }
        }
      }

      // Phase 2: build HierarchyNodes bottom-up
      const built: (HierarchyNode | null)[] = new Array(order.length).fill(null)
      const childrenOf: HierarchyNode[][] = order.map(() => [])

      for (let i = order.length - 1; i >= 0; i--) {
        const { nodeId, depth, parentIdx } = order[i]
        const node = nodeMap.get(nodeId)
        if (!node) continue

        const children = childrenOf[i].sort(childCmp)
        const hNode: HierarchyNode = {
          id: node.id,
          typeId: node.data.type,
          // The business-facing name (drag payloads, search haystacks, exports read
          // this). Precedence via the shared resolver — it used to try `label` first
          // here and `businessLabel` first in the drawer, so one entity could show
          // two different names on one screen. The rendered row applies the live
          // persona mode on top of this (FlatTreeItem).
          name: resolveEntityName(node.data, 'business', node.id),
          data: node.data as Record<string, unknown>,
          children,
          depth,
          urn: node.data.urn || node.id,
          entityTypeOption: (node.data.type as string) || '',
          tags: node.data.classifications || []
        }
        built[i] = hNode
        if (parentIdx >= 0) childrenOf[parentIdx].push(hNode)
      }

      return built[0]
    }

    nodes.forEach((node: any) => {
      const layerId = effectiveLayer.get(node.id)
      if (!layerId) return // Unassigned

      // Check if this is a Visual Root for this layer
      const parentId = parentMap.get(node.id)
      const parentLayerId = parentId ? effectiveLayer.get(parentId) : undefined

      if (layerId !== parentLayerId) {
        // It's a root in this layer context!
        const hNode = buildHierarchyNode(node.id)
        if (hNode) {
          const list = grouped.get(layerId)
          if (list) list.push(hNode)
        }
      }
    })

    // Sort all lists (per-layer comparator; custom mode orders by orderKey)
    grouped.forEach((list, layerId) => list.sort(rootCmpByLayer.get(layerId) ?? alphaAsc))

    // 4. Wrap entities in logical groups where configured.
    // Build entityId -> logicalNodeId map from all layer entityAssignments,
    // then for each layer with logicalNodes, create wrapper HierarchyNodes
    // and move assigned entities under them.
    // KNOWN LIMITATION (deliberate): custom orderKeys apply to a node's roots
    // and its containment children, but NOT across logical-group wrappers —
    // wrappers stay in config order and entities inside a wrapper sort by
    // childCmp (which honours orderKeys, so a manually-ordered group is
    // internally consistent, but the wrappers themselves aren't reorderable).
    const entityLogicalMap = new Map<string, string>() // entityId -> logicalNodeId
    sortedLayers.forEach(l => {
      l.entityAssignments?.forEach(a => {
        if (a.logicalNodeId) entityLogicalMap.set(a.entityId, a.logicalNodeId)
      })
    })
    // Also check instanceAssignments (user drag in current session)
    instanceAssignments.forEach((a, entityId) => {
      if ('logicalNodeId' in a && (a as { logicalNodeId?: string }).logicalNodeId) {
        entityLogicalMap.set(entityId, (a as { logicalNodeId?: string }).logicalNodeId!)
      }
    })

    if (entityLogicalMap.size > 0) {
      sortedLayers.forEach(layer => {
        if (!layer.logicalNodes || layer.logicalNodes.length === 0) return
        const layerNodes = grouped.get(layer.id)
        if (!layerNodes || layerNodes.length === 0) return

        // Build a flat lookup of all logical nodes in this layer (recursive)
        const logicalLookup = new Map<string, LogicalNodeConfig>()
        const collectLogicalNodes = (nodes: LogicalNodeConfig[]) => {
          nodes.forEach(n => {
            logicalLookup.set(n.id, n)
            if (n.children) collectLogicalNodes(n.children)
          })
        }
        collectLogicalNodes(layer.logicalNodes)

        if (logicalLookup.size === 0) return

        // Partition: entities assigned to a logical group vs unassigned
        const logicalChildren = new Map<string, HierarchyNode[]>() // logicalNodeId -> entities
        const ungrouped: HierarchyNode[] = []

        layerNodes.forEach(hNode => {
          const logicalId = entityLogicalMap.get(hNode.id)
          if (logicalId && logicalLookup.has(logicalId)) {
            const list = logicalChildren.get(logicalId) ?? []
            list.push(hNode)
            logicalChildren.set(logicalId, list)
          } else {
            ungrouped.push(hNode)
          }
        })

        // Only restructure if at least one entity is assigned to a logical group
        if (logicalChildren.size === 0) return

        // Build logical group wrapper HierarchyNodes (recursive for nested groups)
        const buildLogicalHierarchy = (configs: LogicalNodeConfig[], depth: number): HierarchyNode[] => {
          return configs.map(config => {
            const assignedEntities = logicalChildren.get(config.id) ?? []
            const childGroups = config.children
              ? buildLogicalHierarchy(config.children, depth + 1)
              : []

            return {
              id: `logical:${config.id}`,
              typeId: config.type,
              name: config.name,
              data: { type: config.type, label: config.name, isLogical: true },
              children: [...childGroups, ...assignedEntities].sort(childCmpByLayer.get(layer.id) ?? alphaAsc),
              depth,
              urn: `logical:${config.id}`,
              entityTypeOption: config.type,
              tags: [],
              isLogical: true,
              logicalConfig: config,
            } satisfies HierarchyNode
          }).filter(g => g.children.length > 0 || logicalChildren.has(g.id.replace('logical:', '')))
        }

        const logicalWrappers = buildLogicalHierarchy(layer.logicalNodes, 0)

        // Replace layer's node list: logical groups first, then ungrouped
        grouped.set(layer.id, [...logicalWrappers, ...ungrouped])
      })
    }

    return grouped
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeEdgeFingerprint, sortedLayers, layerRules, instanceAssignments, nodeMap, childMap, parentMap, effectiveAssignments, branchCreatedDelta, assignments, entityScope, defaultNodeSortMode, sortOverrides])

  // Flatten logical/physical nodes for search and lookup
  const { displayFlat, displayMap } = useMemo(() => {
    const flat: HierarchyNode[] = []
    const map = new Map<string, HierarchyNode>()

    nodesByLayer.forEach((layerNodes) => {
      // Iterative DFS to prevent stack overflow on deep hierarchies
      const stack = [...layerNodes]
      while (stack.length > 0) {
        const node = stack.pop()!
        if (map.has(node.id)) continue
        flat.push(node)
        map.set(node.id, node)
        // Push children in reverse so first child is visited first
        for (let i = node.children.length - 1; i >= 0; i--) {
          stack.push(node.children[i])
        }
      }
    })

    return { displayFlat: flat, displayMap: map }
  }, [nodesByLayer])

  // O(1) URN->ID lookup (replaces O(N) displayFlat.find() per edge)
  const urnToIdMap = useMemo(() => {
    const map = new Map<string, string>()
    displayFlat.forEach(node => {
      if (node.urn) map.set(node.urn, node.id)
    })
    return map
  }, [displayFlat])

  // Re-derive nodeLayerMap from the rendered hierarchy: every HierarchyNode
  // we ended up emitting under a layer must have had a layer assignment, so
  // we recover the map without changing the algorithm's return shape.
  const nodeLayerMap = useMemo(() => {
    const map = new Map<string, string>()
    nodesByLayer.forEach((layerNodes, layerId) => {
      const stack = [...layerNodes]
      while (stack.length > 0) {
        const node = stack.pop()!
        map.set(node.id, layerId)
        for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i])
      }
    })
    return map
  }, [nodesByLayer])

  // Loaded nodes that render nowhere — absent from every layer's emitted
  // hierarchy. Derived from nodeLayerMap so it exactly mirrors what the
  // canvas actually shows.
  const unassignedNodes = useMemo(
    () => nodes.filter((n: { id: string }) => !nodeLayerMap.has(n.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodeEdgeFingerprint, nodeLayerMap],
  )

  return { layerRules, nodesByLayer, displayFlat, displayMap, urnToIdMap, nodeLayerMap, unassignedNodes }
}
