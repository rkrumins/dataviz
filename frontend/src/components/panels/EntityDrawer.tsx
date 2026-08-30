/**
 * EntityDrawer - Unified entity details and editing drawer
 *
 * A modern slide-in drawer that appears when any entity is selected, providing:
 * - View mode: Rich entity details, properties (nested-JSON tree), lineage preview, activity
 * - Edit mode: Inline property editing with PropertyEditor for nested values
 * - Raw JSON mode: Advanced editing for power users
 * - Quick actions: Trace, Pin, External links
 *
 * Property values are plain JSON (Text/Date/Link→string, Number→number,
 * Yes/No→bool, Tags→string[], Group→object); friendly field types are INFERRED
 * from the value on read (see property/fieldTypes.ts), so nothing extra is
 * persisted. FalkorDB already stores arbitrary JSON property bags (scalars +
 * flat scalar-lists as native node props, complex values in a `propertiesRaw`
 * JSON blob — see falkordb_provider._split_user_properties), so these values
 * round-trip as-is once the write path below lands.
 *
 * TODO(backend): Drawer edits currently stage as `update_entity` with a no-op
 * apply hook. To persist edits, mirror the existing edge PATCH pattern:
 *   1. `PATCH /api/v1/{wsId}/graph/nodes/{urn}` route in
 *      backend/app/api/v1/endpoints/graph.py (mirror PATCH /edges/{id})
 *   2. `GraphDataProvider.update_node(urn, payload)` (mirror `update_edge`),
 *      implemented for FalkorDB (Neo4j/Spanner can follow).
 *   3. `RemoteGraphProvider.updateNode` + replace the `apply` console.warn
 *      below with the call.
 * Payload persists the editable surface: `properties` + descriptive fields
 * (displayName, description, qualifiedName, sourceSystem, layerAssignment, tags).
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import {
  useSchemaStore,
  useActiveView,
  useEntityTypes,
  useRootEntityTypes,
  useEntityTypeHierarchyMap,
  useRelationshipTypes,
  useContainmentEdgeTypes,
  normalizeEdgeType,
  isContainmentEdgeType,
} from '@/store/schema'
import { allowedChildTypeIds, setHasId, deriveContainmentEdges } from '@/services/ontologyPreflightService'
import { relationshipLabel, parentPlacementPhrase } from '@/lib/relationshipLabel'
import { useReparentNode } from '@/components/canvas/context-view/useReparentNode'
import { usePersonaStore } from '@/store/persona'
import { useEntityColorSet } from '@/hooks/useEntityVisual'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useFeature } from '@/store/features'
import { PropertyEditor } from '@/components/panels/PropertyEditor'
import { useRestoreGhost } from '@/features/versioning/canvas/useRestoreGhost'
import { PanelErrorBoundary } from '@/components/panels/PanelErrorBoundary'
import { LineageNeighbors } from '@/components/panels/LineageNeighbors'
import { useResolveGraph, useEntityHistory, useProjectionWatermark } from '@/features/versioning/hooks/useVersioning'
import { useViewExecutionContext } from '@/providers/ViewExecutionContext'
import { timeAgo, formatUtc } from '@/lib/timeAgo'
import { useEffectiveBranchId, useBranchStore } from '@/store/branchStore'
import { EntityHistory } from '@/features/versioning/components/EntityHistory'
import { normalizeReferenceLayout } from '@/utils/referenceLayout'
import { cn } from '@/lib/utils'
import { MOTION } from '@/lib/motion'

// ============================================
// Types
// ============================================

interface EntityDrawerProps {
  /** Writes are refused by the surface that owns this drawer — currently a
   *  canvas trace, which is read-only for its whole life. Hides the Edit tab
   *  and takes away the property editor's edit rights, so the drawer cannot
   *  offer what the canvas would reject. */
  writesLocked?: boolean
  /** Open the Lineage Lens (ego-graph overlay) on this node. */
  onFocusConnections?: (nodeId: string) => void
  /** Callback when trace upstream is triggered */
  onTraceUp?: (nodeId: string) => void
  /** Callback when trace downstream is triggered */
  onTraceDown?: (nodeId: string) => void
  /** Callback when full trace is triggered */
  onFullTrace?: (nodeId: string) => void
  /** Reveal the underlying canvas on the given node id — expands any
   *  collapsed ancestors (lazy-loading from the backend if needed), then
   *  pans/scrolls to the target. May return a promise; the drawer's
   *  neighbor row awaits it to show a loading spinner. */
  onFocusNode?: (nodeId: string) => void | Promise<void>
  /** Reveal a set of neighbors at once and fit the canvas around them.
   *  Used by the LineageNeighbors multi-select action bar. */
  onLocateMany?: (nodeIds: string[]) => void | Promise<void>
  /** External link URL builder */
  getExternalUrl?: (urn: string) => string | null
  /** Entities the surface is DRAWING that the canvas store does not hold —
   *  currently a trace overlay's partner cards, which come from the walk
   *  model and are deliberately never written to the store. Consulted only
   *  when the store has no node with this id, so browse is unchanged. */
  resolveNode?: (id: string) => LineageNode | null
}

type ViewMode = 'view' | 'edit' | 'json'

// ============================================
// Main Component
// ============================================

export function EntityDrawer({
  writesLocked = false,
  onFocusConnections,
  onTraceUp,
  onTraceDown,
  onFullTrace,
  onFocusNode,
  onLocateMany,
  getExternalUrl,
  resolveNode,
}: EntityDrawerProps) {
  // Subscribe with narrow selectors so the (heavy) drawer only re-renders when
  // its own node / actions change — NOT on every unrelated canvas store mutation
  // (selection, hover, node drags, layout ticks), which otherwise re-renders the
  // whole drawer continuously and makes everything in it feel laggy.
  const updateNode = useCanvasStore((s) => s.updateNode)
  const clearSelection = useCanvasStore((s) => s.clearSelection)
  const closeNodeDrawer = useCanvasStore((s) => s.closeNodeDrawer)
  const schema = useSchemaStore((s) => s.schema)
  const mode = usePersonaStore((s) => s.mode)

  // Versioning context for the per-entity History section — resolve the active view's data source
  // to its graph (cached; the same resolve the canvas versioning bar uses). Null when version
  // control isn't enabled, in which case the History section hides.
  const activeView = useActiveView()
  const resolve = useResolveGraph(activeView?.workspaceId, activeView?.dataSourceId ?? null, activeView?.id ?? null)
  // Version history is a membership-gated surface and has no meaning for
  // a read-only shared viewer (no drafts, no commits they can act on) —
  // withholding the ids keeps every versioning query from firing.
  const readOnlyView = useViewExecutionContext()?.readOnly ?? false
  const historyWsId = readOnlyView ? undefined : activeView?.workspaceId
  const historyGraphId = readOnlyView ? null : (resolve.data?.graphId ?? null)
  const historyMainBranch = resolve.data?.mainBranchId ?? null
  // The active draft (if any), so the History section also shows this branch's unmerged commits.
  // Scoped by the active view's id (branch-per-view) so this never shows another view's draft
  // commits on the same data source.
  const historyBranchId = useEffectiveBranchId(activeView?.workspaceId ?? '', activeView?.dataSourceId ?? null, activeView?.id ?? null)

  // The drawer is sticky: it shows whichever entity it was last opened on
  // (drawerNodeId), independent of canvas highlight selection. It stays open
  // until explicitly closed via the X button.
  // Logical nodes (id starts with "logical:") are virtual groupings, not physical entities.
  const drawerNodeId = useCanvasStore((s) => s.drawerNodeId)
  const storeNode = useCanvasStore((s) =>
    s.drawerNodeId && !s.drawerNodeId.startsWith('logical:')
      ? s.nodes.find((n) => n.id === s.drawerNodeId) ?? null
      : null,
  )
  // OVERLAY ENTITIES (2026-08-22): a canvas trace draws its partners from the
  // walk model and writes nothing to the store — which is what makes leaving a
  // trace free — so the store cannot answer for them and the drawer opened on
  // nothing, however many times a card was clicked (26 of 28 cards on a live
  // board). The surface drawing them can answer; ask it, but only after the
  // store has missed.
  const selectedNode = storeNode ?? (
    drawerNodeId && !drawerNodeId.startsWith('logical:')
      ? resolveNode?.(drawerNodeId) ?? null
      : null
  )

  const isOpen = !!selectedNode

  // Committed-deletion ghost: the drawer is READ-ONLY (no edit/trace) and offers Restore instead.
  const isGhost = (selectedNode?.data as { isGhost?: boolean } | undefined)?.isGhost === true
  const restoreGhost = useRestoreGhost()

  // Real "last updated" timestamp — the most recent COMMIT that touched this entity (source of
  // truth), not the stale `lastSyncedAt` (which is set at sync/creation and doesn't move on edits).
  // Shared query with the History section (no extra fetch). Both are versioning
  // surfaces: when the admin turns version control off, the queries stop and the
  // History section disappears (undefined ids disable the hooks).
  const versioningEnabled = useFeature('versioningEnabled')
  // Independent switch: OFF means every canvas is view-only even with versioning on
  // (POST /nodes/create, /edges, PATCH/DELETE /edges, /changes all 403 server-side).
  const editModeEnabled = useFeature('editModeEnabled')
  const entityHistory = useEntityHistory(
    versioningEnabled ? historyWsId : undefined,
    versioningEnabled ? historyGraphId : undefined,
    selectedNode?.id ?? undefined,
  )
  const lastUpdatedAt = useMemo(() => {
    const versions = (entityHistory.data?.versions ?? []) as Array<{ created_at?: string; commit_seq?: number }>
    if (!versions.length) return undefined
    return [...versions].sort((a, b) => (b.commit_seq ?? 0) - (a.commit_seq ?? 0))[0]?.created_at
  }, [entityHistory.data])
  // "Synced" = when the live read layer (FalkorDB) last caught up — always >= the last update, so it
  // never conflicts with "Updated". While actively catching up we show a live "Syncing…" state.
  const watermark = useProjectionWatermark(historyWsId, historyGraphId)
  const syncing = watermark.data?.fresh === false
    && (watermark.data?.status === 'projecting' || watermark.data?.status === 'rebuilding')
  const lastSyncedAt = watermark.data?.lastProjectedAt ?? undefined

  // Local state
  const [viewMode, setViewMode] = useState<ViewMode>('view')
  const [formData, setFormData] = useState<Record<string, any>>({})
  const [rawJson, setRawJson] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [hasChanges, setHasChanges] = useState(false)
  const [showSaved, setShowSaved] = useState(false)
  const [copiedUrn, setCopiedUrn] = useState(false)
  const drawerRef = useRef<HTMLElement>(null)
  // Unsaved-changes guard: confirm before closing or switching nodes.
  const [confirmClose, setConfirmClose] = useState(false)
  const [pendingSwitchId, setPendingSwitchId] = useState<string | null>(null)
  const prevIdRef = useRef<string | null>(null)
  const bypassGuardRef = useRef(false)

  // Reset state when selection changes — but if there are unsaved edits, hold on
  // the current node and ask the user first (revert the selection meanwhile).
  useEffect(() => {
    const id = selectedNode?.id ?? null
    if (id === prevIdRef.current) return
    if (!bypassGuardRef.current && hasChanges && prevIdRef.current && id) {
      setPendingSwitchId(id)
      useCanvasStore.getState().openNodeDrawer(prevIdRef.current) // revert; stay put
      return
    }
    bypassGuardRef.current = false
    prevIdRef.current = id
    if (selectedNode) {
      const data = selectedNode.data as Record<string, any>
      setFormData({ ...data })
      setRawJson(JSON.stringify(data, null, 2))
      setHasChanges(false)
      setJsonError(null)
      setViewMode('view')
    }
  }, [selectedNode?.id, hasChanges])

  // Get entity type info from schema
  const entityType = useMemo(() => {
    if (!selectedNode || !schema) return null
    return schema.entityTypes.find(t => t.id === selectedNode.data.type)
  }, [selectedNode, schema])

  // Colors based on entity type (resolved from schema with hash-based fallback)
  const colors = useEntityColorSet((selectedNode?.data.type as string) ?? '')

  // Get display label based on persona mode
  const displayLabel = useMemo(() => {
    if (!selectedNode) return ''
    const data = selectedNode.data as Record<string, any>
    return mode === 'business'
      ? (data.businessLabel || data.label || data.name || selectedNode.id)
      : (data.technicalLabel || data.label || data.name || selectedNode.id)
  }, [selectedNode, mode])

  // Handle form field changes
  const handleChange = useCallback((key: string, value: any) => {
    const newData = { ...formData, [key]: value }
    setFormData(newData)
    setHasChanges(true)
    setJsonError(null)
  }, [formData])

  // Replace the entire `properties` bag — PropertyEditor emits a fresh object
  // on every mutation (add/remove/rename/type-change/reorder). Other top-level
  // canvas-store fields are untouched.
  const handlePropertiesChange = useCallback(
    (nextProperties: Record<string, any>) => {
      const next = { ...formData, properties: nextProperties }
      setFormData(next)
      setHasChanges(true)
      setJsonError(null)
    },
    [formData],
  )

  // `rawJson` is only rendered in the JSON view, so serialize lazily when the
  // user opens it (not on every keystroke — that pretty-prints the whole entity).
  const openJsonView = useCallback(() => {
    setRawJson(JSON.stringify(formData, null, 2))
    setViewMode('json')
  }, [formData])

  // Handle raw JSON changes
  const handleRawJsonChange = useCallback((value: string) => {
    setRawJson(value)
    setHasChanges(true)
    try {
      const parsed = JSON.parse(value)
      setFormData(parsed)
      setJsonError(null)
    } catch (e) {
      setJsonError((e as Error).message)
    }
  }, [])

  // Stage changes — recorded for review, not committed to backend until the
  // user clicks Save Blueprint.
  //
  // Diff strategy: if only `label` differs, stage as `rename_entity` (existing
  // semantics). For any other change (including nested objects like `metadata`),
  // stage as `update_entity` carrying the full before/after diff. The canvas is
  // mutated immediately for visual feedback; staging captures provenance so the
  // review panel can render and discard the change.
  const handleSave = useCallback(() => {
    if (!selectedNode) return
    if (jsonError) return

    const previousData = { ...(selectedNode.data as Record<string, any>) }
    const previousLabel = (previousData.label as string) ?? ''
    const newLabel = (formData.label as string) ?? previousLabel

    updateNode(selectedNode.id, formData)
    setHasChanges(false)
    setShowSaved(true)
    setTimeout(() => setShowSaved(false), 2000)
    setRawJson(JSON.stringify(formData, null, 2))

    // Compute changed keys via shallow JSON-equality (handles nested objects).
    const allKeys = new Set([
      ...Object.keys(previousData),
      ...Object.keys(formData),
    ])
    const changedKeys: string[] = []
    for (const k of allKeys) {
      // Layer placement is VIEW config now (referenceLayout.assignments, managed on the canvas), not an
      // editable node property — never stage it as an update_entity field.
      if (k === 'layerAssignment') continue
      if (JSON.stringify(previousData[k]) !== JSON.stringify(formData[k])) {
        changedKeys.push(k)
      }
    }

    if (changedKeys.length === 0) return

    const stagedChanges = useStagedChangesStore.getState()
    const onlyLabel = changedKeys.length === 1 && changedKeys[0] === 'label'

    if (onlyLabel) {
      stagedChanges.stageOrReplace(
        (c) => c.type === 'rename_entity' && c.targetId === selectedNode.id,
        {
          type: 'rename_entity',
          targetId: selectedNode.id,
          targetUrn: previousData.urn,
          before: previousData,
          after: { ...formData },
          summary: `Rename '${previousLabel}' → '${newLabel}'`,
          discard: () => {
            useCanvasStore.getState().updateNode(selectedNode.id, previousData)
          },
        },
      )
      return
    }

    // Multi-field edit — stage as update_entity. Apply hook is a stub until
    // the backend ships PATCH /api/v1/{wsId}/graph/nodes/{urn}; see the file
    // header for the full backlog.
    stagedChanges.stageOrReplace(
      (c) => c.type === 'update_entity' && c.targetId === selectedNode.id,
      {
        type: 'update_entity',
        targetId: selectedNode.id,
        targetUrn: previousData.urn,
        before: previousData,
        after: { ...formData },
        summary: `Edit ${changedKeys.length} field${changedKeys.length === 1 ? '' : 's'} on '${previousLabel || selectedNode.id}'`,
        discard: () => {
          useCanvasStore.getState().updateNode(selectedNode.id, previousData)
        },
        apply: async () => {
          // TODO(backend): replace with
          //   await authFetch(`/api/v1/${wsId}/graph/nodes/${urn}`, {
          //     method: 'PATCH', body: JSON.stringify({ properties: after })
          //   })
          // once the endpoint and provider methods land.
          console.warn(
            '[update_entity] TODO: PATCH /api/v1/{wsId}/graph/nodes/{urn} not yet implemented',
            { targetId: selectedNode.id, urn: previousData.urn, changedKeys },
          )
        },
      },
    )
  }, [selectedNode, formData, jsonError, updateNode])

  // Cancel changes
  const handleCancel = useCallback(() => {
    if (selectedNode) {
      const data = selectedNode.data as Record<string, any>
      setFormData({ ...data })
      setRawJson(JSON.stringify(data, null, 2))
      setHasChanges(false)
      setJsonError(null)
    }
    setViewMode('view')
  }, [selectedNode])

  // Copy URN
  const handleCopyUrn = useCallback(async () => {
    const urn = formData.urn || selectedNode?.id
    if (urn) {
      await navigator.clipboard.writeText(urn)
      setCopiedUrn(true)
      setTimeout(() => setCopiedUrn(false), 2000)
    }
  }, [formData.urn, selectedNode?.id])

  // Close drawer — the X button is the only close path. The drawer is
  // sticky: clicking other entities or the canvas background never closes
  // it, it only swaps the data shown inside.
  // Close always closes. It used to return early while the drawer was
  // "pinned" — the X became a dead control with no tooltip, no disabled state
  // and no way back except reloading the page. That flag was local state and
  // nothing else in the app ever read it, so the pin did nothing but this.
  const handleClose = useCallback(() => {
    if (hasChanges) { setConfirmClose(true); return }
    closeNodeDrawer()
    clearSelection()
  }, [closeNodeDrawer, clearSelection, hasChanges])

  // Resolve the unsaved-changes prompt (shared by close + node-switch).
  const discardAndProceed = useCallback(() => {
    bypassGuardRef.current = true
    setHasChanges(false)
    if (pendingSwitchId) {
      const target = pendingSwitchId
      setPendingSwitchId(null)
      useCanvasStore.getState().openNodeDrawer(target)
    } else if (confirmClose) {
      setConfirmClose(false)
      closeNodeDrawer()
      clearSelection()
    }
  }, [pendingSwitchId, confirmClose, closeNodeDrawer, clearSelection])

  const keepEditing = useCallback(() => {
    setPendingSwitchId(null)
    setConfirmClose(false)
  }, [])

  // Get external URL
  const externalUrl = useMemo(() => {
    const urn = formData.urn || selectedNode?.id
    return urn && getExternalUrl ? getExternalUrl(urn) : null
  }, [formData.urn, selectedNode?.id, getExternalUrl])

  // Don't render if no node selected
  if (!isOpen || !selectedNode) return null

  const urn = formData.urn || selectedNode.id
  const childCount = formData.childCount || formData._collapsedChildCount || 0

  // After the converter cleanup in useGraphHydration, the editable property
  // bag lives in a single explicit field (`properties`). PropertyEditor
  // targets it directly; everything else on `data` is structured.
  const propertiesBag: Record<string, any> =
    (formData.properties as Record<string, any> | undefined) ?? {}

  // NOTE: no local <AnimatePresence> here. The drawer is conditionally
  // rendered inside ContextViewCanvas's right-rail AnimatePresence, which
  // owns the exit animation; a nested AnimatePresence wrapping an
  // always-rendered child creates its own presence context and can strand
  // the exiting aside (StrictMode / rapid open-close).
  return (
      <motion.aside
        ref={drawerRef}
        data-panel="entity-drawer"
        initial={{ width: 0, opacity: 0 }}
        animate={{ width: 'clamp(420px, 32vw, 560px)', opacity: 1 }}
        exit={{ width: 0, opacity: 0 }}
        transition={MOTION.drawerSlide}
        className={cn(
          "relative h-full flex-shrink-0 overflow-hidden",
          // Opaque, no backdrop-blur: this drawer is a flex sibling that pushes
          // the canvas aside, so nothing paints behind it — the blur was
          // invisible yet re-rasterized every frame of the width spring.
          "bg-canvas-elevated",
          "border-l border-glass-border shadow-lg shadow-black/20"
        )}
      >
        <div className="w-[clamp(420px,32vw,560px)] h-full flex flex-col overflow-hidden">
        {/* Unsaved-changes guard */}
        {(confirmClose || pendingSwitchId) && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/40 backdrop-blur-sm p-6">
            <div className="w-full max-w-xs rounded-2xl border border-glass-border bg-canvas-elevated shadow-xl p-5">
              <h4 className="text-sm font-semibold text-ink">Unsaved changes</h4>
              <p className="text-xs text-ink-muted mt-1.5">
                You have unsaved property changes. {pendingSwitchId ? 'Switch entity' : 'Close'} and discard them?
              </p>
              <div className="flex items-center justify-end gap-2 mt-4">
                <button onClick={keepEditing} className="px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-ink hover:bg-white/5 transition-colors">
                  Keep editing
                </button>
                <button onClick={discardAndProceed} className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-red-500 text-white hover:brightness-110 transition-all">
                  Discard
                </button>
              </div>
            </div>
          </div>
        )}
        {/* Header */}
        <div
          className="flex-shrink-0 p-5 border-b border-glass-border/50"
          style={{
            background: `linear-gradient(135deg, ${colors.accent}10 0%, transparent 60%)`
          }}
        >
          {/* Type Badge & Close */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span
                className="px-2.5 py-1 rounded-lg text-xs font-semibold uppercase tracking-wide"
                style={{ backgroundColor: colors.bg, color: colors.text }}
              >
                {entityType?.name || selectedNode.data.type}
              </span>
              {formData.confidence !== undefined && (
                <span className={cn(
                  "text-xs font-medium",
                  formData.confidence >= 0.8 ? "text-green-500" :
                    formData.confidence >= 0.5 ? "text-amber-500" : "text-red-500"
                )}>
                  {Math.round(formData.confidence * 100)}%
                </span>
              )}
            </div>
            <button
              onClick={handleClose}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-white/10 transition-colors duration-150"
            >
              <LucideIcons.X className="w-4 h-4" />
            </button>
          </div>

          {/* Entity Name */}
          <h2 className="text-xl font-display font-semibold text-ink leading-tight mb-4">
            {displayLabel}
          </h2>

          {/* Committed-deletion ghost → a Restore banner takes the place of the trace/edit actions. */}
          {isGhost && (
            <div className="mb-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30">
              <div className="flex items-center gap-2 mb-1.5">
                <LucideIcons.Trash2 className="w-4 h-4 text-rose-500" />
                <span className="text-sm font-semibold text-rose-600 dark:text-rose-400">Deleted in this draft</span>
              </div>
              <p className="text-xs text-ink-muted mb-3">
                Removed on this branch — it disappears once the draft merges. Restore to bring it back
                (nested under its parent when that parent still exists).
              </p>
              <button
                onClick={() => restoreGhost(((selectedNode.data as Record<string, unknown>).urn as string) || selectedNode.id)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-rose-500/30 text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 text-xs font-medium transition-colors"
              >
                <LucideIcons.RotateCcw className="w-3.5 h-3.5" /> Restore
              </button>
            </div>
          )}

          {/* Prominent Trace Actions - Industry-Standard One-Click Lineage */}
          {!isGhost && (
          <div className="flex flex-col gap-3 mb-4">
            <div className="grid grid-cols-3 gap-2">
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => onTraceUp?.(selectedNode.id)}
                className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 hover:bg-blue-500/20 transition-colors duration-150 group"
              >
                <div className="w-10 h-10 rounded-full bg-blue-500/20 flex items-center justify-center group-hover:bg-blue-500/30 transition-colors">
                  <LucideIcons.ArrowUpLeft className="w-5 h-5 text-blue-500" />
                </div>
                <span className="text-xs font-medium text-blue-600 dark:text-blue-400">Root Cause</span>
                <span className="text-[10px] text-blue-500/60">Trace Upstream</span>
              </motion.button>

              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => onTraceDown?.(selectedNode.id)}
                className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-green-500/10 border border-green-500/20 hover:bg-green-500/20 transition-colors duration-150 group"
              >
                <div className="w-10 h-10 rounded-full bg-green-500/20 flex items-center justify-center group-hover:bg-green-500/30 transition-colors">
                  <LucideIcons.ArrowDownRight className="w-5 h-5 text-green-500" />
                </div>
                <span className="text-xs font-medium text-green-600 dark:text-green-400">Impact</span>
                <span className="text-[10px] text-green-500/60">Trace Downstream</span>
              </motion.button>

              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => onFullTrace?.(selectedNode.id)}
                className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-purple-500/10 border border-purple-500/20 hover:bg-purple-500/20 transition-colors duration-150 group"
              >
                <div className="w-10 h-10 rounded-full bg-purple-500/20 flex items-center justify-center group-hover:bg-purple-500/30 transition-colors">
                  <LucideIcons.GitBranch className="w-5 h-5 text-purple-500" />
                </div>
                <span className="text-xs font-medium text-purple-600 dark:text-purple-400">Full Lineage</span>
                <span className="text-[10px] text-purple-500/60">Both Directions</span>
              </motion.button>
            </div>
          </div>
          )}

          {/* Secondary Quick Actions */}
          <div className="flex items-center gap-2 flex-wrap">
            {onFocusConnections && !isGhost && (
              <ActionButton
                icon={LucideIcons.Focus}
                label="Focus"
                onClick={() => onFocusConnections(selectedNode.id)}
              />
            )}
            <ActionButton
              icon={LucideIcons.Copy}
              label={copiedUrn ? "Copied!" : "Copy URN"}
              onClick={() => {
                const urn = (selectedNode.data as Record<string, any>).urn || selectedNode.id
                navigator.clipboard.writeText(urn)
                setCopiedUrn(true)
                setTimeout(() => setCopiedUrn(false), 2000)
              }}
            />
            {externalUrl && (
              <ActionButton
                icon={LucideIcons.ExternalLink}
                label="Open"
                onClick={() => window.open(externalUrl, '_blank')}
              />
            )}
          </div>

          {/* Mode Toggle Strip */}
          <div className="flex items-center gap-1 mt-4 p-1 rounded-xl bg-black/5 dark:bg-white/5">
            <ModeTab
              active={viewMode === 'view'}
              onClick={() => setViewMode('view')}
              icon={LucideIcons.Eye}
              label="View"
            />
            {!isGhost && versioningEnabled && editModeEnabled && !writesLocked && (
              <ModeTab
                active={viewMode === 'edit'}
                onClick={() => setViewMode('edit')}
                icon={LucideIcons.Pencil}
                label="Edit"
                badge={hasChanges ? '•' : undefined}
              />
            )}
            <ModeTab
              active={viewMode === 'json'}
              onClick={openJsonView}
              icon={LucideIcons.Code}
              label="JSON"
            />
          </div>

          {/* Status Indicators */}
          <AnimatePresence>
            {(hasChanges || showSaved || jsonError) && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-3"
              >
                {jsonError ? (
                  <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-xs flex items-center gap-2">
                    <LucideIcons.AlertCircle className="w-4 h-4" />
                    Invalid JSON: {jsonError}
                  </div>
                ) : showSaved ? (
                  <div className="px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/20 text-green-500 text-xs flex items-center gap-2">
                    <LucideIcons.CheckCircle className="w-4 h-4" />
                    Changes saved successfully
                  </div>
                ) : hasChanges ? (
                  <div className="px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-500 text-xs flex items-center gap-2">
                    <LucideIcons.AlertTriangle className="w-4 h-4" />
                    You have unsaved changes
                  </div>
                ) : null}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          {viewMode === 'view' && (
            <ViewModeContent
              nodeId={selectedNode.id}
              formData={formData}
              urn={urn}
              childCount={childCount}
              colors={colors}
              entityType={entityType}
              propertiesBag={propertiesBag}
              onCopyUrn={handleCopyUrn}
              copiedUrn={copiedUrn}
              onFocusNode={onFocusNode}
              onLocateMany={onLocateMany}
              wsId={historyWsId}
              graphId={historyGraphId}
              mainBranchId={historyMainBranch}
              branchId={historyBranchId}
            />
          )}

          {viewMode === 'edit' && (
            <EditModeContent
              nodeId={selectedNode.id}
              formData={formData}
              entityType={entityType}
              urn={urn}
              propertiesBag={propertiesBag}
              onChange={handleChange}
              onPropertiesChange={handlePropertiesChange}
              onCopyUrn={handleCopyUrn}
            />
          )}

          {viewMode === 'json' && (
            <JsonModeContent
              rawJson={rawJson}
              jsonError={jsonError}
              onChange={handleRawJsonChange}
              canEdit={!isGhost && versioningEnabled && editModeEnabled && !writesLocked}
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 p-4 border-t border-glass-border/50 bg-canvas-elevated/50">
          {viewMode === 'view' ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <TimeStat
                  icon={<LucideIcons.PencilLine className="w-4 h-4" />}
                  label="Updated" iso={lastUpdatedAt} tone="indigo"
                  loading={entityHistory.isLoading} emptyText="No changes yet"
                />
                <TimeStat
                  icon={syncing
                    ? <LucideIcons.Loader2 className="w-4 h-4 animate-spin" />
                    : <LucideIcons.RefreshCcw className="w-4 h-4" />}
                  label={syncing ? 'Syncing' : 'Synced'}
                  iso={syncing ? undefined : lastSyncedAt}
                  tone={syncing ? 'amber' : 'emerald'}
                  live={!syncing && watermark.data?.fresh === true}
                  overrideValue={syncing ? 'In progress…' : undefined}
                  emptyText="—"
                />
              </div>
              {externalUrl && (
                <button
                  onClick={() => window.open(externalUrl, '_blank')}
                  className="w-full flex items-center justify-center gap-1 pt-0.5 text-[11px] text-accent-lineage hover:underline"
                >
                  View in DataHub <LucideIcons.ArrowUpRight className="w-3 h-3" />
                </button>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={handleCancel}
                className="px-4 py-2 text-sm font-medium text-ink-muted hover:text-ink hover:bg-white/5 rounded-xl transition-colors duration-150"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!hasChanges || !!jsonError}
                className={cn(
                  "px-5 py-2 rounded-xl text-sm font-semibold flex items-center gap-2 transition-colors duration-150",
                  hasChanges && !jsonError
                    ? "bg-accent-lineage text-white hover:brightness-110 shadow-lg shadow-accent-lineage/25"
                    : "bg-white/5 text-ink-muted cursor-not-allowed"
                )}
              >
                <LucideIcons.Save className="w-4 h-4" />
                Stage Changes
              </button>
            </div>
          )}
        </div>
        </div>
      </motion.aside>
  )
}

// ============================================
// Sub-Components
// ============================================

interface ActionButtonProps {
  icon: React.ComponentType<{ className?: string }>
  label: string
  primary?: boolean
  active?: boolean
  onClick?: () => void
}

function ActionButton({ icon: Icon, label, primary, active, onClick }: ActionButtonProps) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={cn(
        "h-9 px-3 rounded-xl flex items-center gap-2 text-sm font-medium transition-colors duration-150 duration-200",
        primary
          ? "bg-accent-lineage text-white hover:brightness-110 shadow-md shadow-accent-lineage/20"
          : active
            ? "bg-white/15 text-ink"
            : "bg-white/5 text-ink-muted hover:text-ink hover:bg-white/10"
      )}
    >
      <Icon className="w-4 h-4" />
      <span className="hidden lg:inline">{label}</span>
    </button>
  )
}

interface ModeTabProps {
  active: boolean
  onClick: () => void
  icon: React.ComponentType<{ className?: string }>
  label: string
  badge?: string
}

function ModeTab({ active, onClick, icon: Icon, label, badge }: ModeTabProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors duration-150 duration-200",
        active
          ? "bg-white/10 text-ink shadow-sm"
          : "text-ink-muted hover:text-ink hover:bg-white/5"
      )}
    >
      <Icon className="w-4 h-4" />
      {label}
      {badge && (
        <span className="text-amber-500 text-xs">{badge}</span>
      )}
    </button>
  )
}

interface SectionProps {
  title: string
  icon?: React.ComponentType<{ className?: string }>
  children: React.ReactNode
  action?: React.ReactNode
  /** Let content extend closer to the drawer edges (title stays aligned).
   *  Used for the content-dense Properties section. */
  flush?: boolean
}

function Section({ title, icon: Icon, children, action, flush }: SectionProps) {
  return (
    <div className="px-5 py-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          {Icon && <Icon className="w-4 h-4 text-ink-muted" />}
          <h3 className="text-xs font-semibold text-ink-muted uppercase tracking-wider">
            {title}
          </h3>
        </div>
        {action}
      </div>
      {flush ? <div className="-mx-3">{children}</div> : children}
    </div>
  )
}

// A rich freshness stat — icon chip + label (with an optional live pulse) + the relative time, and
// the exact UTC timestamp on hover. Used for "Updated" (last change) and "Synced" (live layer).
const TIMESTAT_TONES = {
  indigo: {
    box: 'bg-indigo-50/70 dark:bg-indigo-950/25 border-indigo-100 dark:border-indigo-900/40',
    chip: 'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-500',
    label: 'text-indigo-600/70 dark:text-indigo-400/70',
  },
  emerald: {
    box: 'bg-emerald-50/70 dark:bg-emerald-950/25 border-emerald-100 dark:border-emerald-900/40',
    chip: 'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-500',
    label: 'text-emerald-600/70 dark:text-emerald-400/70',
  },
  amber: {
    box: 'bg-amber-50/70 dark:bg-amber-950/25 border-amber-100 dark:border-amber-900/40',
    chip: 'bg-amber-100 dark:bg-amber-900/50 text-amber-500',
    label: 'text-amber-600/70 dark:text-amber-400/70',
  },
} as const

function TimeStat({ icon, label, iso, tone, loading, live, overrideValue, emptyText }: {
  icon: React.ReactNode
  label: string
  iso?: string
  tone: keyof typeof TIMESTAT_TONES
  loading?: boolean
  live?: boolean
  overrideValue?: string
  emptyText?: string
}) {
  const t = TIMESTAT_TONES[tone]
  const value = loading ? 'Loading…' : (overrideValue ?? (iso ? timeAgo(iso) : (emptyText ?? '—')))
  return (
    <div
      className={cn('flex items-center gap-2.5 px-3 py-2 rounded-xl border transition-colors', t.box)}
      title={iso ? formatUtc(iso) : undefined}
    >
      <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0', t.chip)}>{icon}</div>
      <div className="min-w-0">
        <div className={cn('text-[10px] font-semibold uppercase tracking-wide flex items-center gap-1', t.label)}>
          {label}
          {live && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />}
        </div>
        <div className="text-xs font-bold text-ink truncate">{value}</div>
      </div>
    </div>
  )
}

/**
 * Read-only display of the descriptive backend fields surfaced on
 * `LineageNode.data` (qualifiedName, sourceSystem, layerAssignment,
 * lastSyncedAt, childCount, description). Hidden entirely when none have
 * values so empty entities don't show a useless section.
 */
function DetailsList({ formData }: { formData: Record<string, any> }) {
  const rows: Array<{ key: string; label: string; value: React.ReactNode }> = []
  const push = (key: string, label: string, raw: unknown) => {
    if (raw === undefined || raw === null || raw === '') return
    rows.push({ key, label, value: String(raw) })
  }
  push('qualifiedName', 'Qualified name', formData.qualifiedName)
  push('description', 'Description', formData.description)
  push('sourceSystem', 'Source system', formData.sourceSystem)
  push('layerAssignment', 'Layer', formData.layerAssignment)
  push('lastSyncedAt', 'Last synced', formData.lastSyncedAt)
  // Child count lives in the Relationship summary ("Contains N items") — not duplicated here.
  if (rows.length === 0) return null
  return (
    <Section title="Details" icon={LucideIcons.Info}>
      <div className="space-y-1">
        {rows.map((row) => (
          <div key={row.key} className="flex items-start justify-between gap-4 py-1.5">
            <span className="text-xs text-ink-muted min-w-[110px]">{row.label}</span>
            <span className="text-xs text-ink text-right break-all">{row.value}</span>
          </div>
        ))}
      </div>
    </Section>
  )
}

/**
 * useContainmentPlacement — derives a node's place in the containment hierarchy from the live canvas
 * graph: its parent (+ the friendly relationship), the ontology-allowed relationship types for the
 * current parent→child pair, valid move targets, and its loaded children. Shared by the read-only
 * view summary and the edit-mode editor so both read the topology identically.
 */
function useContainmentPlacement(nodeId: string) {
  const entityTypes = useEntityTypes()
  const rootEntityTypes = useRootEntityTypes()
  const hierarchyMap = useEntityTypeHierarchyMap()
  const relationshipTypes = useRelationshipTypes()
  const containmentEdgeTypes = useContainmentEdgeTypes()

  // Subscribe narrowly so this re-derives when the graph topology changes (e.g. after a move
  // restages edges) but not on unrelated canvas mutations.
  const nodes = useCanvasStore((s) => s.nodes)
  const edges = useCanvasStore((s) => s.edges)

  const node = useMemo(() => nodes.find((n) => n.id === nodeId), [nodes, nodeId])
  const childType = (node?.data.type as string) ?? ''

  const isContainment = useCallback(
    (e: { data?: { edgeType?: string; relationship?: string } }) =>
      isContainmentEdgeType(normalizeEdgeType(e), containmentEdgeTypes),
    [containmentEdgeTypes],
  )

  // Current containment parent edge (stored parent→child, so target===nodeId).
  const parentEdge = useMemo(
    () => edges.find((e) => e.target === nodeId && isContainment(e)),
    [edges, nodeId, isContainment],
  )
  const parentNode = useMemo(
    () => (parentEdge ? nodes.find((n) => n.id === parentEdge.source) : undefined),
    [parentEdge, nodes],
  )
  const parentType = (parentNode?.data.type as string) ?? ''
  const parentName = (parentNode?.data.label as string) || parentEdge?.source
  const currentEdgeType = parentEdge ? normalizeEdgeType(parentEdge) : ''

  // Loaded children (containment edges leaving this node).
  const childCountLoaded = useMemo(
    () => edges.filter((e) => e.source === nodeId && isContainment(e)).length,
    [edges, nodeId, isContainment],
  )

  // Allowed relationship types for the CURRENT parent→child pair (human labels).
  const relTypeOptions = useMemo(
    () =>
      parentNode
        ? deriveContainmentEdges(parentType, childType, relationshipTypes, containmentEdgeTypes).filter((o) => o.allowed)
        : [],
    [parentNode, parentType, childType, relationshipTypes, containmentEdgeTypes],
  )

  // Descendants of this node — excluded from the move list (can't move under self/child).
  const descendants = useMemo(() => {
    const childrenOf = new Map<string, string[]>()
    for (const e of edges) {
      if (!e.source || !e.target || !isContainment(e)) continue
      const arr = childrenOf.get(e.source)
      if (arr) arr.push(e.target)
      else childrenOf.set(e.source, [e.target])
    }
    const out = new Set<string>([nodeId])
    const stack = [nodeId]
    while (stack.length) {
      const id = stack.pop()!
      for (const c of childrenOf.get(id) ?? []) {
        if (!out.has(c)) { out.add(c); stack.push(c) }
      }
    }
    return out
  }, [edges, nodeId, isContainment])

  // Candidate parents: canvas nodes whose type can contain this node's type,
  // excluding self, descendants, and the current parent.
  const moveTargets = useMemo(() => {
    if (!node) return []
    return nodes
      .filter((n) => {
        if (descendants.has(n.id)) return false
        if (n.id === parentNode?.id) return false
        const candidateType = n.data.type as string
        return setHasId(allowedChildTypeIds(candidateType, entityTypes, rootEntityTypes, hierarchyMap), childType)
      })
      .map((n) => ({
        id: n.id,
        label: (n.data.label as string) || n.id,
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [node, nodes, descendants, parentNode?.id, entityTypes, rootEntityTypes, hierarchyMap, childType])

  return { node, parentNode, parentName, currentEdgeType, relTypeOptions, moveTargets, childCountLoaded }
}

/**
 * RelationshipSummary — the READ-ONLY, plain-language view of where an entity sits in the
 * hierarchy. No jargon, no controls: "Part of <Parent>" (tap to jump to it) and "Contains N items".
 * The actual editing (change relationship / move) lives in Edit mode — see {@link RelationshipEditor}.
 */
function RelationshipSummary({
  nodeId,
  childCount,
  onFocusNode,
}: {
  nodeId: string
  childCount: number
  onFocusNode?: (nodeId: string) => void | Promise<void>
}) {
  const { node, parentNode, parentName, currentEdgeType, childCountLoaded } = useContainmentPlacement(nodeId)
  const openNodeDrawer = useCanvasStore((s) => s.openNodeDrawer)
  const selectNode = useCanvasStore((s) => s.selectNode)
  if (!node) return null

  const childrenTotal = Math.max(childCount ?? 0, childCountLoaded)
  const placement = parentPlacementPhrase(currentEdgeType)

  // Mirror LineageNeighbors: swap the drawer + selection to the parent first (instant), then pan.
  const goToParent = () => {
    if (!parentNode) return
    openNodeDrawer(parentNode.id)
    selectNode(parentNode.id)
    onFocusNode?.(parentNode.id)
  }

  return (
    <Section title="Relationship" icon={LucideIcons.Network}>
      <div className="space-y-2">
        {parentNode ? (
          <button
            onClick={goToParent}
            className="group w-full flex items-center gap-3 px-3 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 hover:bg-black/[0.07] dark:hover:bg-white/[0.08] transition-colors duration-150 text-left"
            title={`Go to ${parentName}`}
          >
            <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-accent-lineage/10 text-accent-lineage shrink-0">
              <LucideIcons.CornerLeftUp className="w-4 h-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] text-ink-muted">{placement}</span>
              <span className="block text-sm font-medium text-ink truncate">{parentName}</span>
            </span>
            <LucideIcons.ArrowUpRight className="w-3.5 h-3.5 text-ink-muted opacity-0 group-hover:opacity-100 transition-opacity duration-150 shrink-0" />
          </button>
        ) : (
          <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-black/5 dark:bg-white/5">
            <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-black/5 dark:bg-white/10 text-ink-muted shrink-0">
              <LucideIcons.Home className="w-4 h-4" />
            </span>
            <span className="text-sm text-ink-muted">Top-level item</span>
          </div>
        )}

        {childrenTotal > 0 && (
          <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-black/5 dark:bg-white/5">
            <span className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-500 shrink-0">
              <LucideIcons.CornerRightDown className="w-4 h-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[11px] text-ink-muted">Contains</span>
              <span className="block text-sm font-medium text-ink">
                {childrenTotal} {childrenTotal === 1 ? 'item' : 'items'}
              </span>
            </span>
          </div>
        )}
      </div>
    </Section>
  )
}

/**
 * RelationshipEditor — the EDIT-mode controls for an entity's placement: switch how it relates to
 * its parent, or move it under a different parent. Both go through useReparentNode (ontology-
 * validated, staged for review). Containment edits only persist inside a draft, so outside one we
 * show a clear note instead of dead controls.
 */
function RelationshipEditor({ nodeId }: { nodeId: string }) {
  const { reparent, retypeContainment } = useReparentNode()
  const { node, parentNode, parentName, currentEdgeType, relTypeOptions, moveTargets } = useContainmentPlacement(nodeId)
  const inDraft = useBranchStore((s) => !!s.currentBranchId)
  if (!node) return null

  return (
    <div className="pt-5 border-t border-glass-border/30">
      <h4 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-4 flex items-center gap-2">
        <LucideIcons.Network className="w-3.5 h-3.5" />
        Relationship
      </h4>

      {!inDraft ? (
        <div className="px-3 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-600 dark:text-amber-400 text-xs flex items-start gap-2">
          <LucideIcons.Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>Switch to a draft to change where this entity sits or how it relates to its parent.</span>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <span className="text-xs text-ink-muted">Currently</span>
            <span className="text-xs text-ink text-right font-medium break-words">
              {parentNode ? `${parentPlacementPhrase(currentEdgeType)} ${parentName}` : 'Top-level item'}
            </span>
          </div>

          {parentNode && (
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-ink-muted">How it relates</label>
              <select
                value={currentEdgeType}
                onChange={(e) => retypeContainment(nodeId, e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10 focus:border-accent-lineage/50 transition-colors duration-150 outline-none text-sm text-ink"
              >
                {/* Keep the current type selectable even if no longer ontology-allowed. */}
                {!relTypeOptions.some((o) => o.edgeType === currentEdgeType) && (
                  <option value={currentEdgeType}>{relationshipLabel(currentEdgeType)}</option>
                )}
                {relTypeOptions.map((o) => (
                  <option key={o.edgeType} value={o.edgeType}>
                    {o.label}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-ink-muted">How this entity belongs to {parentName}.</p>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-ink-muted">Move to a different parent</label>
            {moveTargets.length > 0 ? (
              <select
                value=""
                onChange={(e) => { if (e.target.value) reparent(nodeId, e.target.value) }}
                className="w-full px-3 py-2 rounded-xl bg-white/5 border border-white/10 focus:border-accent-lineage/50 transition-colors duration-150 outline-none text-sm text-ink"
              >
                <option value="" disabled>
                  Choose a new parent…
                </option>
                {moveTargets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-ink-muted italic">
                No other entity here can contain this one.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================
// View Mode Content
// ============================================

interface ViewModeContentProps {
  nodeId: string
  formData: Record<string, any>
  urn: string
  childCount: number
  colors: { hex: string; bg: string; text: string; accent: string }
  entityType: any
  propertiesBag: Record<string, any>
  onCopyUrn: () => void
  copiedUrn: boolean
  onFocusNode?: (nodeId: string) => void | Promise<void>
  onLocateMany?: (nodeIds: string[]) => void | Promise<void>
  wsId?: string
  graphId?: string | null
  mainBranchId?: string | null
  branchId?: string | null
}

function ViewModeContent({
  nodeId,
  formData,
  urn,
  childCount,
  colors,
  propertiesBag,
  onCopyUrn,
  copiedUrn,
  onFocusNode,
  onLocateMany,
  wsId,
  graphId,
  mainBranchId,
  branchId,
}: ViewModeContentProps) {
  const hasAdditional = Object.keys(propertiesBag).length > 0
  const versioningEnabledForHistory = useFeature('versioningEnabled')
  return (
    <div className="divide-y divide-glass-border/30">
      {/* Identifier */}
      <Section title="Identifier" icon={LucideIcons.Link}>
        <div className="flex items-center gap-2 p-3 rounded-xl bg-black/5 dark:bg-white/5">
          <code className="flex-1 text-xs font-mono text-ink-muted truncate">
            {urn}
          </code>
          <button
            onClick={onCopyUrn}
            className="p-2 rounded-lg hover:bg-white/10 text-ink-muted hover:text-ink transition-colors duration-150"
            title="Copy URN"
          >
            {copiedUrn ? (
              <LucideIcons.Check className="w-4 h-4 text-green-500" />
            ) : (
              <LucideIcons.Copy className="w-4 h-4" />
            )}
          </button>
        </div>
      </Section>

      {/* Details — first-class descriptive fields carried from the backend
          GraphNode. Only rendered when at least one has a real value. */}
      <DetailsList formData={formData} />

      {/* Relationship — read-only, plain-language summary of where this entity sits in the
          hierarchy ("Part of <Parent>", "Contains N"). Editing (change relationship / move) lives
          in Edit mode so the view stays calm and non-technical. */}
      <RelationshipSummary nodeId={nodeId} childCount={childCount} onFocusNode={onFocusNode} />

      {/* Properties — nested-JSON tree rendered read-only via PropertyEditor.
          `readOnly` keeps the recursive UI navigable (expand, search, copy,
          open-in-modal-to-read) while blocking edits; the same component is
          used (editable) in Edit mode. */}
      <Section title="Properties" icon={LucideIcons.FileText} flush={hasAdditional}>
        {hasAdditional ? (
          <PanelErrorBoundary resetKeys={[urn]}>
            <PropertyEditor value={propertiesBag} onChange={() => {}} readOnly searchable groupByPath bare />
          </PanelErrorBoundary>
        ) : (
          <p className="text-xs text-ink-muted italic">
            No properties yet. Switch to Edit to add metadata.
          </p>
        )}
      </Section>

      {/* Classifications */}
      {formData.classifications && Array.isArray(formData.classifications) && formData.classifications.length > 0 && (
        <Section title="Classifications" icon={LucideIcons.Tag}>
          <div className="flex flex-wrap gap-2">
            {(formData.classifications as string[]).map(tag => (
              <span
                key={tag}
                className="px-3 py-1.5 rounded-lg text-xs font-medium"
                style={{ backgroundColor: colors.bg, color: colors.text }}
              >
                {tag}
              </span>
            ))}
          </div>
        </Section>
      )}

      {/* Lineage — real 1-hop neighbors with direction/entity/edge filters. */}
      <LineageNeighbors
        nodeId={nodeId}
        onFocusNode={onFocusNode}
        onLocateMany={onLocateMany}
      />

      {/* History — real per-entity revision history (main line). Hidden when version control is off. */}
      {versioningEnabledForHistory && wsId && graphId && (
        <Section title="History" icon={LucideIcons.History}>
          <EntityHistory wsId={wsId} graphId={graphId} entityId={nodeId} mainBranchId={mainBranchId} branchId={branchId} />
        </Section>
      )}
    </div>
  )
}

// ============================================
// Edit Mode Content
// ============================================

interface EditModeContentProps {
  nodeId: string
  formData: Record<string, any>
  entityType: any
  urn: string
  propertiesBag: Record<string, any>
  onChange: (key: string, value: any) => void
  onPropertiesChange: (next: Record<string, any>) => void
  onCopyUrn: () => void
}

function EditModeContent({
  nodeId,
  formData,
  entityType,
  urn,
  propertiesBag,
  onChange,
  onPropertiesChange,
  onCopyUrn,
}: EditModeContentProps) {
  // Layer placement is VIEW config now (referenceLayout.assignments), managed on the canvas — not an
  // editable node property. Show the RESOLVED layer name read-only (explicit assignment; inherited
  // placement resolves live on the canvas). A Context View node's id IS its urn, so the map is keyed here.
  const activeView = useActiveView()
  const resolvedLayerName = useMemo(() => {
    const { layers, assignments } = normalizeReferenceLayout(activeView?.layout?.referenceLayout)
    const layerId = assignments[urn]?.layerId
    if (!layerId) return ''
    return layers.find((l) => l.id === layerId)?.name ?? layerId
  }, [activeView?.layout?.referenceLayout, urn])
  return (
    <div className="p-5 space-y-5">
      {/* Core Fields */}
      <div className="space-y-4">
        {/* Name/Label */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-ink-muted flex items-center gap-2">
            <LucideIcons.Type className="w-3.5 h-3.5" />
            Name
          </label>
          <input
            type="text"
            value={formData.label || formData.name || ''}
            onChange={(e) => onChange('label', e.target.value)}
            className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 focus:border-accent-lineage/50 focus:bg-white/8 transition-colors duration-150 outline-none text-sm"
            placeholder="Entity name..."
          />
        </div>

        {/* Business Label */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-ink-muted flex items-center gap-2">
            <LucideIcons.Briefcase className="w-3.5 h-3.5" />
            Business Label
          </label>
          <input
            type="text"
            value={formData.businessLabel || ''}
            onChange={(e) => onChange('businessLabel', e.target.value)}
            className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 focus:border-accent-lineage/50 focus:bg-white/8 transition-colors duration-150 outline-none text-sm"
            placeholder="Business-friendly name..."
          />
        </div>

        {/* Description */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-ink-muted flex items-center gap-2">
            <LucideIcons.FileText className="w-3.5 h-3.5" />
            Description
          </label>
          <textarea
            value={formData.description || ''}
            onChange={(e) => onChange('description', e.target.value)}
            rows={3}
            className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 focus:border-accent-lineage/50 focus:bg-white/8 transition-colors duration-150 outline-none text-sm resize-none"
            placeholder="Add a description..."
          />
        </div>

        {/* URN (read-only) */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-ink-muted flex items-center gap-2">
            <LucideIcons.Link className="w-3.5 h-3.5" />
            URN (read-only)
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={urn}
              readOnly
              className="flex-1 px-4 py-3 rounded-xl bg-black/10 dark:bg-white/5 border border-transparent text-ink-muted text-sm font-mono cursor-not-allowed"
            />
            <button
              onClick={onCopyUrn}
              className="p-3 rounded-xl bg-white/5 hover:bg-white/10 text-ink-muted hover:text-ink transition-colors duration-150"
              title="Copy URN"
            >
              <LucideIcons.Copy className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Relationship — where this entity sits in the hierarchy. The editing controls live in
          Edit mode (not the calm read-only View) and persist inside a draft. */}
      <RelationshipEditor nodeId={nodeId} />

      {/* Metadata — first-class descriptive fields carried from the backend
          GraphNode. lastSyncedAt and childCount are backend-managed and
          rendered read-only; the rest accept user edits. */}
      <div className="pt-5 border-t border-glass-border/30">
        <h4 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-4">
          Metadata
        </h4>
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-xs font-semibold text-ink-muted flex items-center gap-2">
              <LucideIcons.AtSign className="w-3.5 h-3.5" />
              Qualified name
            </label>
            <input
              type="text"
              value={(formData.qualifiedName as string) || ''}
              onChange={(e) => onChange('qualifiedName', e.target.value)}
              className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 focus:border-accent-lineage/50 transition-colors duration-150 outline-none text-sm"
              placeholder="Fully qualified name..."
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-semibold text-ink-muted flex items-center gap-2">
              <LucideIcons.Database className="w-3.5 h-3.5" />
              Source system
            </label>
            <input
              type="text"
              value={(formData.sourceSystem as string) || ''}
              onChange={(e) => onChange('sourceSystem', e.target.value)}
              className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 focus:border-accent-lineage/50 transition-colors duration-150 outline-none text-sm"
              placeholder="Origin system identifier..."
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs font-semibold text-ink-muted flex items-center gap-2">
              <LucideIcons.Layers className="w-3.5 h-3.5" />
              Layer
            </label>
            <div className="w-full px-4 py-3 rounded-xl bg-black/10 dark:bg-white/5 border border-transparent text-ink-muted text-sm">
              {resolvedLayerName || <span className="italic opacity-60">Placed on the canvas</span>}
            </div>
          </div>
          {(formData.lastSyncedAt || typeof formData.childCount === 'number') && (
            <div className="flex items-center justify-between gap-4 px-4 py-3 rounded-xl bg-black/5 dark:bg-white/[0.03] text-xs">
              {formData.lastSyncedAt ? (
                <div className="flex items-center gap-2 text-ink-muted">
                  <LucideIcons.Clock className="w-3.5 h-3.5" />
                  <span>Last synced</span>
                  <span className="text-ink">{String(formData.lastSyncedAt)}</span>
                </div>
              ) : <span />}
              {typeof formData.childCount === 'number' && formData.childCount > 0 && (
                <div className="flex items-center gap-2 text-ink-muted">
                  <LucideIcons.GitBranch className="w-3.5 h-3.5" />
                  <span>{formData.childCount} children</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Dynamic Schema Fields */}
      {entityType?.fields && entityType.fields.filter((f: any) => !['name', 'label', 'description', 'urn', 'businessLabel'].includes(f.id)).length > 0 && (
        <div className="pt-5 border-t border-glass-border/30">
          <h4 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-4">
            Schema Properties
          </h4>
          <div className="space-y-4">
            {entityType.fields.filter((f: any) => !['name', 'label', 'description', 'urn', 'businessLabel'].includes(f.id)).map((field: any) => (
              <div key={field.id} className="space-y-2">
                <label className="text-xs font-medium text-ink-muted">{field.name}</label>
                {field.type === 'textarea' || field.type === 'markdown' ? (
                  <textarea
                    value={formData[field.id] || ''}
                    onChange={(e) => onChange(field.id, e.target.value)}
                    rows={2}
                    className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 focus:border-accent-lineage/50 transition-colors duration-150 outline-none text-sm resize-none"
                  />
                ) : (
                  <input
                    type="text"
                    value={formData[field.id] || ''}
                    onChange={(e) => onChange(field.id, e.target.value)}
                    className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 focus:border-accent-lineage/50 transition-colors duration-150 outline-none text-sm"
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Properties — nested-JSON CRUD via PropertyEditor. Targets the
          single `properties` bag on node.data (renamed from `metadata`).
          Users can add/remove/rename keys, change value types, and
          drag-reorder array items. */}
      <div className="pt-5 border-t border-glass-border/30">
        <h4 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-4">
          Properties
        </h4>
        <div className="-mx-3">
          <PanelErrorBoundary resetKeys={[urn]}>
            <PropertyEditor
              value={propertiesBag}
              onChange={(next) => onPropertiesChange(next as Record<string, any>)}
              searchable
              groupByPath
              bare
            />
          </PanelErrorBoundary>
        </div>
      </div>
    </div>
  )
}

// ============================================
// JSON Mode Content
// ============================================

interface JsonModeContentProps {
  rawJson: string
  jsonError: string | null
  onChange: (value: string) => void
  canEdit: boolean
}

function JsonModeContent({ rawJson, jsonError, onChange, canEdit }: JsonModeContentProps) {
  return (
    <div className="p-5">
      <div className="flex items-center justify-between mb-3">
        <label className="text-xs font-semibold text-ink-muted flex items-center gap-2">
          <LucideIcons.Code className="w-3.5 h-3.5" />
          Raw JSON Data
        </label>
        <span className={cn(
          "text-xs px-2 py-1 rounded-lg",
          jsonError
            ? "bg-red-500/10 text-red-500"
            : "bg-green-500/10 text-green-500"
        )}>
          {jsonError ? '⚠️ Invalid' : '✓ Valid'}
        </span>
      </div>
      <textarea
        value={rawJson}
        onChange={(e) => onChange(e.target.value)}
        readOnly={!canEdit}
        className={cn(
          "w-full h-[500px] px-4 py-3 rounded-xl bg-black/10 dark:bg-white/5 border transition-colors duration-150 outline-none text-xs font-mono resize-none custom-scrollbar",
          jsonError
            ? "border-red-500/30 focus:border-red-500/50"
            : "border-white/10 focus:border-accent-lineage/50"
        )}
        spellCheck={false}
      />
    </div>
  )
}

// ============================================
// Helper Components
// ============================================

export default EntityDrawer

