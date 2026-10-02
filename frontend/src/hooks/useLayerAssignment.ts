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
import type { ViewLayerConfig, LogicalNodeConfig, LayerAssignmentEntry, LayerNodeSortAlgo } from '@/types/schema'
import {
  type GraphNode,
  resolveLayerAssignmentIn,
  sortLayerRules,
  type LayerAssignmentRule,
} from '@/providers/GraphDataProvider'
import type { HierarchyNode } from '@/types/hierarchy'
import { useBranchCreatedDelta } from './useBranchCreatedDelta'
import { buildLayerRules, resolveRootLayer } from './lib/resolveRootLayer'
import { rootComparators, childComparator, effectiveSortMode } from './lib/rootSort'
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
  /** Each rendered entity's nearest group (view-only container), if any. */
  nodeGroupMap: Map<string, { id: string; name: string }>
  /** Loaded nodes that resolved to NO layer and therefore render nowhere.
   *  Surfaced so the canvas can tell the user instead of hiding them. */
  unassignedNodes: Array<{ id: string; data?: Record<string, unknown> }>
  /** Each PROMOTED anchor's URN → the column it is drawn as. An anchor
   *  renders AS its column, so no map above holds it; lineage that names it
   *  learns its column here. */
  promotedAnchors: ReadonlyMap<string, string>
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
  // Sorted here so the per-node resolution below does not re-sort the list for
  // every node on the canvas.
  const layerRules = useMemo<LayerAssignmentRule[]>(
    () => sortLayerRules(buildLayerRules(sortedLayers)), [sortedLayers])

  // Core Logic: Group nodes by layer with Deep Inheritance support.
  // Returns the promoted-anchor set alongside the grouping: `unassignedNodes`
  // needs it, and deriving it here beats writing a ref during render (which the
  // React Compiler rightly refuses) or restating the promotion rule elsewhere.
  const layerGrouping = useMemo(() => {
    const grouped = new Map<string, HierarchyNode[]>()

    // Per-layer node comparators. Effective mode resolution: ephemeral session
    // override → layer.nodeSortMode → view defaultNodeSortMode → 'alpha-asc'.
    // 'custom' mode is HIERARCHICAL: BOTH roots and children order by their
    // assignment orderKey (keyed entries first, ordinally; unkeyed entries
    // after, alphabetically). The comparator only ever compares siblings (one
    // parent's children, or the layer's roots), so each sibling set holds an
    // independent key sequence. All other modes leave children on the
    // server's alphabetical order (asc, or desc when the whole layer is Z→A).
    // Ordering lives in hooks/lib/rootSort so the wizard's Layer Studio can sort
    // its rail with the SAME comparators — an arrangement built in the wizard
    // has to be the one the canvas renders.
    const ROOT_CMPS = rootComparators<HierarchyNode>(assignments, (n) =>
      Number((n.data as Record<string, unknown> | undefined)?.childCount ?? n.children.length) || 0,
    )
    const alphaAsc = ROOT_CMPS['alpha-asc']
    const childCmpByLayer = new Map<string, (a: HierarchyNode, b: HierarchyNode) => number>()
    const rootCmpByLayer = new Map<string, (a: HierarchyNode, b: HierarchyNode) => number>()
    sortedLayers.forEach(layer => {
      const mode = effectiveSortMode(layer, defaultNodeSortMode, sortOverrides?.get(layer.id))
      childCmpByLayer.set(layer.id, childComparator(mode, ROOT_CMPS))
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

      const ruleLayerId = resolveLayerAssignmentIn(graphNode, layerRules)
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

    // Iterative top-down traversal (prevents stack overflow on deep hierarchies).
    // Per-node precedence — an EXPLICIT per-entity assignment wins at ANY depth:
    //   1. instanceAssignments (live user drag in this session)
    //   2. the node's OWN canonical entry (referenceLayout.assignments)
    //   3. containment inheritance (parent's effective layer, gated by the
    //      parent's `inheritsChildren` when children are pushed below)
    //   4. scope-specific fallbacks (closed-scope drop / open-scope chain)
    // A child placed on a DIFFERENT layer than its parent splits out of the
    // parent's subtree and renders as a visual root of its own column (the
    // wizard writes exactly such placements); entry-less children still
    // inherit, so type rules never break a nested subtree apart.
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

      // 1. instanceAssignments (live user drag in this session) — always
      //    wins. The user just dropped this onto a layer; respect that
      //    immediately regardless of view config or backend state.
      const instanceAssignment = instanceAssignments.get(nodeId)
      // 2a. Canonical per-node assignment (referenceLayout.assignments) — AUTHORITATIVE in BOTH
      //     scopes and at ANY depth. A user's explicit placement overrides containment
      //     inheritance, type rules and backend state, which is what makes the canvas mirror
      //     the wizard's flat "it renders where you placed it" model. An entry naming a layer
      //     that no longer exists in this view is treated as absent (falls through to
      //     inheritance/rules) rather than stranding the node. A child whose entry names the
      //     SAME layer it would inherit resolves identically and stays a nested child —
      //     ensureSiblingOrderKeys mints exactly such carrier entries to hold orderKeys.
      const rawExplicit = explicitAssignments.get(nodeId)
      const explicitLayerId = rawExplicit && validLayerIds.has(rawExplicit) ? rawExplicit : undefined
      // 3. Containment inheritance: an entry-less child follows its parent, so a
      //    nested subtree renders together and type rules never break it apart.
      const hasContainmentParent = parentMap.has(nodeId)

      if (instanceAssignment) {
        myLayerId = instanceAssignment.layerId
      } else if (explicitLayerId) {
        myLayerId = explicitLayerId
      } else if (hasContainmentParent && inheritedLayerId) {
        myLayerId = inheritedLayerId
      } else {
        // 4. Scope-specific fallback chain — see resolveRootLayer for full
        //    semantics (instance drag -> explicit -> curated (stamped, only if
        //    branch-created) -> open (backend -> stamped -> rule -> inherited ->
        //    showUnassigned fallback); '__UNASSIGNED__' sentinel -> undefined).
        //    `instanceAssignment` is already resolved as step 1 above.
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
          // Both are provably absent on this branch — steps 1 and 2 above
          // already claimed the node when either could answer. Passed so the
          // helper's own precedence stays readable next to the chain here.
          instanceAssignment: undefined,
          explicitAssignment: undefined,
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

    const entityLogicalMap = new Map<string, string>() // entityId -> logicalNodeId
    // The LEGACY per-layer arrays, for entities the canonical record below
    // does not cover.
    sortedLayers.forEach(l => {
      l.entityAssignments?.forEach(a => {
        if (a.logicalNodeId) entityLogicalMap.set(a.entityId, a.logicalNodeId)
      })
    })
    // The canonical `referenceLayout.assignments` record — the same entry
    // that carries `layerId`, and where `assignEntities` stamps
    // `logicalNodeId`. It was not read here at all, so a group's membership
    // rendered while the session's drag was still in memory and quietly came
    // apart once the canonical record was the only thing left.
    //
    // A canonical entry that NAMES a group wins over the legacy array. One
    // that omits `logicalNodeId` is deliberately left alone rather than
    // treated as "not in a group": `normalizeReferenceLayout` strips the
    // legacy array from persisted views, so a view holding BOTH is
    // transitional — and there the grouping the user can actually see came
    // from the legacy entry. Clearing it on load would dissolve a visible
    // group without being asked to. (The cost is the mirror case: in such a
    // transitional view, moving an entity OUT of a group does not take
    // effect until the legacy entry is gone.)
    for (const [urn, entry] of Object.entries(assignments)) {
      if (entry?.logicalNodeId) entityLogicalMap.set(urn, entry.logicalNodeId)
    }
    // Also check instanceAssignments (user drag in current session)
    instanceAssignments.forEach((a, entityId) => {
      if ('logicalNodeId' in a && (a as { logicalNodeId?: string }).logicalNodeId) {
        entityLogicalMap.set(entityId, (a as { logicalNodeId?: string }).logicalNodeId!)
      }
    })

    // Group ids per layer (recursive — groups of groups), so a membership is honoured only in a
    // layer that actually defines that group.
    const groupIdsByLayer = new Map<string, Set<string>>()
    sortedLayers.forEach(l => {
      const ids = new Set<string>()
      const walk = (cs?: LogicalNodeConfig[]) => cs?.forEach(c => { ids.add(c.id); walk(c.children) })
      walk(l.logicalNodes)
      groupIdsByLayer.set(l.id, ids)
    })
    const groupHere = (nodeId: string, layerId: string | undefined): string | undefined => {
      const g = entityLogicalMap.get(nodeId)
      return g && layerId && groupIdsByLayer.get(layerId)?.has(g) ? g : undefined
    }
    // A child PLACED into a group its parent is not in leaves the parent's subtree and becomes a
    // root of its layer, so the group can wrap it — also when the group is in the parent's own layer
    // (it used to stay nested under the parent, and the group never received it). View arrangement
    // only: the data is unchanged.
    const splitByGroup = (childId: string, parentId: string | undefined, layerId: string | undefined) => {
      const g = groupHere(childId, layerId)
      return !!g && g !== (parentId ? groupHere(parentId, layerId) : undefined)
    }

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
          if (effectiveLayer.get(cid) === rootLayer && !splitByGroup(cid, item.nodeId, rootLayer)) {
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

    // A column may be ANCHORED to an entity, meaning the column IS that entity:
    // its children are the rows, and the anchor itself is not drawn (the header
    // already names it). Purely a promotion at render time — the anchor keeps
    // its assignment, so a client without this field draws the old shape.
    const anchorByLayer = new Map<string, string>()
    sortedLayers.forEach(l => { if (l.anchorUrn) anchorByLayer.set(l.id, l.anchorUrn) })
    // Only an anchor that was actually PROMOTED renders as its column. One that
    // fell back to a row is an ordinary node; one that nothing places at all
    // (its assignment cleared, the anchorUrn left behind) genuinely renders
    // nowhere and must still be reported as such.
    const promotedAnchors = new Map<string, string>()

    nodes.forEach((node: any) => {
      const layerId = effectiveLayer.get(node.id)
      if (!layerId) return // Unassigned

      // Check if this is a Visual Root for this layer
      const parentId = parentMap.get(node.id)
      const parentLayerId = parentId ? effectiveLayer.get(parentId) : undefined

      if (layerId !== parentLayerId || splitByGroup(node.id, parentId, layerId)) {
        const list = grouped.get(layerId)
        if (!list) return

        const nodeUrn = (node.data?.urn as string | undefined) ?? node.id
        const children = childMap.get(node.id) ?? []
        // Promote once we hold ANY of the anchor's children: the column carries
        // its own "Load more" for the rest (see anchorMore in LayerColumn), so a
        // partial set is a first page rather than a silent truncation.
        //
        // Holding NONE of them is different — the fetch failed, or has not run.
        // Flattening there would draw an empty column with nothing to click, so
        // fall back to the anchor ROW, which states its child count and pages on
        // expand. The promotion resumes by itself once a page lands.
        const total = Number(node.data?.childCount ?? children.length) || 0
        const canPromote = children.length > 0 || total === 0
        if (anchorByLayer.get(layerId) === nodeUrn && canPromote) {
          promotedAnchors.set(nodeUrn, layerId)
          // They stay in this layer by ordinary containment inheritance, so each
          // carries its own subtree — and a child added at source simply appears.
          for (const childId of children) {
            if (effectiveLayer.get(childId) !== layerId) continue
            const childNode = buildHierarchyNode(childId)
            if (childNode) list.push(childNode)
          }
          return
        }

        // It's a root in this layer context!
        const hNode = buildHierarchyNode(node.id)
        if (hNode) list.push(hNode)
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
    // Every CONFIGURED group renders, empty or not: a group made on the canvas is a place to drop
    // entities into, so it must be there before anything is in it.
    {
      sortedLayers.forEach(layer => {
        if (!layer.logicalNodes || layer.logicalNodes.length === 0) return
        const layerNodes = grouped.get(layer.id)
        if (!layerNodes) return

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
          })
        }

        const logicalWrappers = buildLogicalHierarchy(layer.logicalNodes, 0)

        // Replace layer's node list: logical groups first, then ungrouped
        grouped.set(layer.id, [...logicalWrappers, ...ungrouped])
      })
    }

    return { grouped, promotedAnchors }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeEdgeFingerprint, sortedLayers, layerRules, instanceAssignments, nodeMap, childMap, parentMap, effectiveAssignments, branchCreatedDelta, assignments, entityScope, defaultNodeSortMode, sortOverrides])

  const nodesByLayer = layerGrouping.grouped

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

  // Each rendered entity's nearest GROUP (logical wrapper) — the view-only container it is placed
  // in, if any. Mirrors nodeLayerMap: read off the emitted hierarchy.
  const nodeGroupMap = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>()
    nodesByLayer.forEach((layerNodes) => {
      const stack: Array<{ node: HierarchyNode; group?: { id: string; name: string } }> =
        layerNodes.map(node => ({ node }))
      while (stack.length > 0) {
        const { node, group } = stack.pop()!
        const here = node.isLogical ? { id: node.id, name: node.name } : group
        if (!node.isLogical && here) map.set(node.id, here)
        for (const child of node.children) stack.push({ node: child, group: here })
      }
    })
    return map
  }, [nodesByLayer])

  // Loaded nodes that render nowhere — absent from every layer's emitted
  // hierarchy. Derived from nodeLayerMap so it exactly mirrors what the
  // canvas actually shows.
  const unassignedNodes = useMemo(
    () => nodes.filter((n: { id: string; data?: Record<string, unknown> }) =>
      !nodeLayerMap.has(n.id)
      && !layerGrouping.promotedAnchors.has((n.data?.urn as string | undefined) ?? n.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodeEdgeFingerprint, nodeLayerMap, layerGrouping],
  )

  return { layerRules, nodesByLayer, displayFlat, displayMap, urnToIdMap, nodeLayerMap, nodeGroupMap, unassignedNodes, promotedAnchors: layerGrouping.promotedAnchors }
}
