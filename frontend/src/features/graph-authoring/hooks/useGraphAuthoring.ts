/**
 * useGraphAuthoring — THE authoring controller for the Context View canvas.
 *
 * Owns one explicit mode (see authoringMode.ts) and exposes the commands that
 * drive every CRUD gesture, delegating all staging to the graph-authoring model
 * functions. Replaces the authoring half of useCanvasInteractions + the separate
 * useEdgeConnect state machine + the scattered creation-state flags in
 * ContextViewCanvas.
 *
 * Every `begin*` command opens a draft FIRST (ensureDraftOpen, a no-op when one
 * is already open) before any optimistic mutation — switching branches reloads
 * the canvas, so opening a draft after staging would discard the in-progress
 * edit. Node/edge editing stays selection-driven (drawer / edge panel); the
 * controller only adds the create-panel and compose right-rail modes.
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { useCanvasStore } from '@/store/canvas'
import {
  useEntityTypes,
  useRelationshipTypes,
  useContainmentEdgeTypes,
  useRootEntityTypes,
  useEntityTypeHierarchyMap,
} from '@/store/schema'
import { ensureDraftOpen } from '@/features/versioning/model/ensureDraftOpen'
import {
  IDLE,
  decideConnectResolution,
  type AuthoringMode,
} from '../model/authoringMode'
import {
  deriveConnectableEdges,
  connectableTargetTypes,
} from '../model/ontologyGuard'
import {
  stageEntityCreate,
  stageNodeUpdate,
  stageNodeDelete,
  type StageEntityCreateInput,
} from '../model/stageNode'
import {
  stageEdgeCreate,
  stageEdgeDelete,
  stageEdgeReverse,
  stageEdgeRetype,
  stageEdgePropertyEdit,
} from '../model/stageEdge'

export interface UseGraphAuthoringOptions {
  /** Expand a parent after a child is created so the new node is visible. */
  onExpandParent?: (parentId: string) => void
  /** Toast surface for explain-not-prevent messaging. */
  notify?: (message: string, kind?: 'info' | 'error') => void
}

export interface ConnectContext {
  sourceId: string
  /** Entity type ids a connect from `sourceId` may legally land on. */
  validTypeIds: Set<string>
}

const nodeTypeOf = (id: string): string | null =>
  (useCanvasStore.getState().nodes.find((n) => n.id === id)?.data.type as string) ?? null

export function useGraphAuthoring(options: UseGraphAuthoringOptions = {}) {
  const { onExpandParent, notify } = options
  const [mode, setMode] = useState<AuthoringMode>(IDLE)
  // Mirror for command callbacks so they read the latest mode without stale
  // closures and without running side effects inside a setState updater (which
  // React may invoke twice). Commands read modeRef.current, then setMode purely.
  const modeRef = useRef(mode)
  modeRef.current = mode

  const entityTypes = useEntityTypes()
  const relationshipTypes = useRelationshipTypes()
  const containmentEdgeTypes = useContainmentEdgeTypes()
  const rootEntityTypes = useRootEntityTypes()
  const hierarchyMap = useEntityTypeHierarchyMap()
  const entityTypeIds = useMemo(() => entityTypes.map((e) => e.id), [entityTypes])

  // ── connect-target validity (drives live highlight/dim in the canvas) ──────
  const connectContext: ConnectContext | null = useMemo(() => {
    if (mode.kind !== 'connect') return null
    const sourceType = nodeTypeOf(mode.sourceId)
    return {
      sourceId: mode.sourceId,
      validTypeIds: connectableTargetTypes(sourceType, entityTypeIds, relationshipTypes, containmentEdgeTypes),
    }
  }, [mode, entityTypeIds, relationshipTypes, containmentEdgeTypes])

  // ── create ────────────────────────────────────────────────────────────────
  const beginInlineCreate = useCallback(async (layerId: string, parentId: string | null = null) => {
    await ensureDraftOpen()
    setMode({ kind: 'inline-create', layerId, parentId })
  }, [])

  const beginCreatePanel = useCallback(async (seed?: { parentId?: string | null; layerId?: string | null }) => {
    await ensureDraftOpen()
    setMode({ kind: 'create-panel', parentId: seed?.parentId ?? null, layerId: seed?.layerId ?? null })
  }, [])

  const beginCompose = useCallback(async (seed?: { seedParentId?: string | null; seedLayerId?: string | null }) => {
    await ensureDraftOpen()
    setMode({ kind: 'compose', seedParentId: seed?.seedParentId ?? null, seedLayerId: seed?.seedLayerId ?? null })
  }, [])

  /**
   * Stage one entity from the inline card or detailed panel and (for inline)
   * stay in create mode for rapid sibling entry. Returns the new temp urn.
   */
  const commitCreate = useCallback((input: StageEntityCreateInput, opts?: { keepOpen?: boolean }) => {
    const tempUrn = stageEntityCreate(input)
    if (input.parentUrn) onExpandParent?.(input.parentUrn)
    if (!opts?.keepOpen) setMode(IDLE)
    return tempUrn
  }, [onExpandParent])

  // ── connect ────────────────────────────────────────────────────────────────
  const beginConnect = useCallback(async (sourceId: string, via: 'drag' | 'armed', start?: { x: number; y: number }) => {
    await ensureDraftOpen()
    setMode({ kind: 'connect', sourceId, via, pointer: start ?? null, hoverTargetId: null })
  }, [])

  /** Live drag feedback — update the rubber-band pointer and hovered target. */
  const updatePointer = useCallback((pointer: { x: number; y: number } | null, hoverTargetId: string | null = null) => {
    setMode((m) => (m.kind === 'connect' ? { ...m, pointer, hoverTargetId } : m))
  }, [])

  /**
   * Resolve a connect target (the gesture supplies the node id under the drop
   * point). Opens the edge-type picker for a valid pair, otherwise explains why
   * and returns to idle.
   */
  const resolveTarget = useCallback((targetId: string | null, position: { x: number; y: number }) => {
    const m = modeRef.current
    if (m.kind !== 'connect') return
    const sourceType = nodeTypeOf(m.sourceId)
    const targetType = targetId ? nodeTypeOf(targetId) : null
    const opts = deriveConnectableEdges(sourceType, targetType, relationshipTypes, containmentEdgeTypes)
    const decision = decideConnectResolution(m.sourceId, targetId, opts)
    if (decision.action === 'reject') {
      if (decision.reason) notify?.(decision.reason, 'error')
      setMode(IDLE)
      return
    }
    setMode({ kind: 'edge-type-pick', sourceId: m.sourceId, targetId: targetId!, position })
  }, [relationshipTypes, containmentEdgeTypes, notify])

  const confirmEdgeType = useCallback((edgeType: string) => {
    const m = modeRef.current
    if (m.kind === 'edge-type-pick') stageEdgeCreate(m.sourceId, m.targetId, edgeType)
    setMode(IDLE)
  }, [])

  /** Drawable edge options for the currently-picking endpoints (for the picker UI). */
  const edgeTypeOptions = useMemo(() => {
    if (mode.kind !== 'edge-type-pick') return []
    return deriveConnectableEdges(
      nodeTypeOf(mode.sourceId),
      nodeTypeOf(mode.targetId),
      relationshipTypes,
      containmentEdgeTypes,
    )
  }, [mode, relationshipTypes, containmentEdgeTypes])

  // ── generic ────────────────────────────────────────────────────────────────
  const cancel = useCallback(() => setMode(IDLE), [])

  /** ESC handler for the canvas cascade: true if it consumed an active mode. */
  const handleEscape = useCallback((): boolean => {
    if (modeRef.current.kind === 'idle') return false
    setMode(IDLE)
    return true
  }, [])

  return {
    mode,
    connectContext,
    edgeTypeOptions,
    // ontology helpers exposed for pickers/menus (single source)
    allowedChildContext: { entityTypes, rootEntityTypes, hierarchyMap, containmentEdgeTypes },
    // create
    beginInlineCreate,
    beginCreatePanel,
    beginCompose,
    commitCreate,
    // connect
    beginConnect,
    updatePointer,
    resolveTarget,
    confirmEdgeType,
    // generic
    cancel,
    handleEscape,
    // selection-driven editing + menu actions (passthrough to the model)
    stageNodeUpdate,
    stageNodeDelete,
    stageEdgeDelete,
    stageEdgeReverse,
    stageEdgeRetype,
    stageEdgePropertyEdit,
  }
}

export type GraphAuthoringController = ReturnType<typeof useGraphAuthoring>
