/**
 * LayerStudio
 *
 * Three-panel WYSIWYG Layer Studio for the ViewWizard Assignment Step.
 *
 * Layout:
 *   ┌──────────────────┬──────────────────────────┬───────────────┐
 *   │  Layer Hierarchy │  Entity Browser           │  Live Preview │
 *   │  (25%)           │  (45%)                    │  (30%)        │
 *   └──────────────────┴──────────────────────────┴───────────────┘
 *
 * Features:
 * - Click any layer or group → becomes active drop target
 * - Drag entity from browser → assigned to active target (layer + optional node)
 * - Full logical node CRUD with undo/redo
 * - "Auto-Organize" heuristic suggestions with review sheet
 * - Live mini canvas preview (toggle-able)
 *
 * Assignments write to `formData.assignments` (the canonical flattened
 * urn -> layer map — same shape the canvas persists via persistReferenceLayout),
 * NOT into `layers[].entityAssignments` (legacy, deprecated). The wizard no
 * longer autosaves a draft context model; formData is the sole buffer until
 * the wizard's own Submit persists it.
 */

import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Undo2,
    Redo2,
    Sparkles,
    Wand2,
    Eye,
    EyeOff,
    AlertCircle,
    Check,
    X,
    ChevronRight,
    Loader2,
} from 'lucide-react'
import { cn, generateId } from '@/lib/utils'
import { LayerHierarchyPanel, type ActiveTarget, type DropPayload } from './LayerHierarchyPanel'
import { WizardAssignmentTree, type BrowserSnapshot } from '../views/ViewWizard/WizardAssignmentTree'
import { useWizardEntityIndex, fallbackNameFromUrn } from '../views/ViewWizard/useWizardEntityIndex'
import { suggestLayerMappings, type MagicMapSuggestion } from '../views/ViewWizard/magicMap'
import { LAYER_COLORS } from '../views/ViewWizard/steps/LayoutStep'
import { useLogicalNodes } from '@/hooks/useLogicalNodes'
import { useAutoOrganize, type GroupingSuggestion } from '@/hooks/useAutoOrganize'
import { assignEntities, unassignEntities } from '@/components/canvas/context-view/assignmentMutations'
import type { NormalizedReferenceLayout } from '@/utils/referenceLayout'
import type { ViewLayerConfig, LayerAssignmentEntry } from '@/types/schema'
import type { WizardFormData } from '../views/ViewWizard/ViewWizard'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { useCanvasStore } from '@/store/canvas'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { useContainmentEdgeTypes, normalizeEdgeType, isContainmentEdgeType } from '@/store/schema'
import { useToast } from '@/components/ui/toast'
import { ChildReassignConfirmDialog, type ChildReassignInfo } from '../dialogs/ChildReassignConfirmDialog'

// ─── Types ────────────────────────────────────────────────────────────────────

interface LayerStudioProps {
    formData: WizardFormData
    updateFormData: (updates: Partial<WizardFormData>) => void
}

// ─── Auto-Organize Review Sheet ────────────────────────────────────────────────

function AutoOrganizeSheet({
    suggestions,
    onAcceptAll,
    onAcceptOne,
    onDismissOne,
    onClose,
}: {
    suggestions: GroupingSuggestion[]
    onAcceptAll: () => void
    onAcceptOne: (s: GroupingSuggestion) => void
    onDismissOne: (entityId: string) => void
    onClose: () => void
}) {
    const grouped = useMemo(() => {
        const map = new Map<string, GroupingSuggestion[]>()
        for (const s of suggestions) {
            const key = `${s.suggestedLayerName} → ${s.suggestedNodeName}`
            map.set(key, [...(map.get(key) ?? []), s])
        }
        return Array.from(map.entries())
    }, [suggestions])

    const confidenceColor = (c: GroupingSuggestion['confidence']) => ({
        high: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/30',
        medium: 'text-amber-600 bg-amber-50 dark:bg-amber-900/30',
        low: 'text-slate-500 bg-slate-100 dark:bg-slate-700',
    }[c])

    return (
        <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.97 }}
            className={cn(
                'absolute inset-x-0 bottom-0 z-50 mx-4 mb-4',
                'bg-white dark:bg-slate-900 rounded-2xl shadow-2xl',
                'border border-slate-200 dark:border-slate-700',
                'max-h-[55%] flex flex-col overflow-hidden'
            )}
        >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
                <div>
                    <h3 className="font-semibold text-slate-800 dark:text-white">
                        Auto-Organize Suggestions
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                        {suggestions.length} suggestions based on entity names
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={onAcceptAll}
                        className="px-3 py-1.5 bg-blue-500 text-white text-sm font-medium rounded-lg hover:bg-blue-600 transition-colors"
                    >
                        Accept All
                    </button>
                    <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800">
                        <X className="w-4 h-4 text-slate-500" />
                    </button>
                </div>
            </div>

            {/* Suggestions list */}
            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
                {grouped.map(([groupLabel, items]) => (
                    <div key={groupLabel}>
                        <div className="flex items-center gap-1.5 mb-2">
                            <ChevronRight className="w-3 h-3 text-slate-400" />
                            <span className="text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wide">
                                {groupLabel}
                            </span>
                        </div>
                        <div className="space-y-1.5 ml-4">
                            {items.map(s => (
                                <div
                                    key={s.entityId}
                                    className="flex items-center gap-2 px-3 py-2 bg-slate-50 dark:bg-slate-800 rounded-lg"
                                >
                                    <span className={cn('text-xs px-1.5 py-0.5 rounded font-medium', confidenceColor(s.confidence))}>
                                        {s.confidence}
                                    </span>
                                    <span className="flex-1 text-sm text-slate-700 dark:text-slate-300 truncate">
                                        {s.entityName}
                                        <span className="ml-1 text-xs text-slate-400">({s.entityType})</span>
                                    </span>
                                    <div className="flex items-center gap-1">
                                        <button
                                            onClick={() => onAcceptOne(s)}
                                            className="p-1 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900/40 text-emerald-500"
                                            title="Accept"
                                        >
                                            <Check className="w-3.5 h-3.5" />
                                        </button>
                                        <button
                                            onClick={() => onDismissOne(s.entityId)}
                                            className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400"
                                            title="Dismiss"
                                        >
                                            <X className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </motion.div>
    )
}

// ─── Magic Map Review Sheet ────────────────────────────────────────────────────

function MagicMapSheet({
    suggestions,
    scanned,
    total,
    hasMore,
    busy,
    onLoadAll,
    onAcceptAll,
    onAcceptOne,
    onDismissOne,
    onClose,
}: {
    suggestions: MagicMapSuggestion[]
    scanned: number
    total: number
    hasMore: boolean
    busy: boolean
    onLoadAll: () => void
    onAcceptAll: () => void
    onAcceptOne: (s: MagicMapSuggestion) => void
    onDismissOne: (urn: string) => void
    onClose: () => void
}) {
    const grouped = useMemo(() => {
        const map = new Map<string, MagicMapSuggestion[]>()
        for (const s of suggestions) {
            map.set(s.layerName, [...(map.get(s.layerName) ?? []), s])
        }
        return Array.from(map.entries())
    }, [suggestions])

    const confidenceColor = (c: MagicMapSuggestion['confidence']) => ({
        high: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-900/30',
        medium: 'text-amber-600 bg-amber-50 dark:bg-amber-900/30',
        low: 'text-slate-500 bg-slate-100 dark:bg-slate-700',
    }[c])

    return (
        <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.97 }}
            className={cn(
                'absolute inset-x-0 bottom-0 z-50 mx-4 mb-4',
                'bg-white dark:bg-slate-900 rounded-2xl shadow-2xl',
                'border border-slate-200 dark:border-slate-700',
                'max-h-[60%] flex flex-col overflow-hidden'
            )}
        >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 dark:border-slate-800">
                <div className="min-w-0">
                    <h3 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
                        <Wand2 className="w-4 h-4 text-violet-500" />
                        Magic Map
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                        {suggestions.length > 0
                            ? `${suggestions.length} top-level ${suggestions.length === 1 ? 'entity matches a layer' : 'entities match your layers'} by name — their children inherit automatically`
                            : 'No name matches found between your top-level entities and layer names'}
                        {hasMore && (
                            <>
                                {' · '}
                                <span className="text-amber-600 dark:text-amber-400">
                                    scanned {scanned} of {total}
                                </span>
                            </>
                        )}
                    </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {hasMore && (
                        <button
                            onClick={onLoadAll}
                            disabled={busy}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-60"
                        >
                            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                            Scan all {total}
                        </button>
                    )}
                    {suggestions.length > 0 && (
                        <button
                            onClick={onAcceptAll}
                            className="px-3 py-1.5 bg-violet-500 text-white text-sm font-medium rounded-lg hover:bg-violet-600 transition-colors"
                        >
                            Accept all {suggestions.length}
                        </button>
                    )}
                    <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800">
                        <X className="w-4 h-4 text-slate-500" />
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
                {grouped.length === 0 ? (
                    <p className="text-center text-sm text-slate-400 py-6">
                        Rename a layer to match a root entity (or vice versa) and run this again.
                    </p>
                ) : grouped.map(([layerName, items]) => (
                    <div key={layerName}>
                        <div className="flex items-center gap-1.5 mb-2">
                            <ChevronRight className="w-3 h-3 text-slate-400" />
                            <span className="text-xs font-semibold text-slate-600 dark:text-slate-300 uppercase tracking-wide">
                                {layerName}
                            </span>
                            <span className="text-[10px] text-slate-400">{items.length}</span>
                        </div>
                        <div className="space-y-1.5 ml-4">
                            {items.map(s => (
                                <div
                                    key={s.urn}
                                    className="flex items-center gap-2 px-3 py-2 bg-slate-50 dark:bg-slate-800 rounded-lg"
                                >
                                    <span className={cn('text-xs px-1.5 py-0.5 rounded font-medium shrink-0', confidenceColor(s.confidence))}>
                                        {s.confidence}
                                    </span>
                                    <span className="flex-1 min-w-0 text-sm text-slate-700 dark:text-slate-300 truncate" title={s.reason}>
                                        {s.name}
                                        <span className="ml-1 text-xs text-slate-400">({s.type})</span>
                                    </span>
                                    <div className="flex items-center gap-1 shrink-0">
                                        <button
                                            onClick={() => onAcceptOne(s)}
                                            className="p-1 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900/40 text-emerald-500"
                                            title="Accept"
                                        >
                                            <Check className="w-3.5 h-3.5" />
                                        </button>
                                        <button
                                            onClick={() => onDismissOne(s.urn)}
                                            className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400"
                                            title="Dismiss"
                                        >
                                            <X className="w-3.5 h-3.5" />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </motion.div>
    )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function LayerStudio({
    formData,
    updateFormData,
}: LayerStudioProps) {
    const storeParentMap = useReferenceModelStore(s => s.parentMap)
    const storeEffectiveAssignments = useReferenceModelStore(s => s.effectiveAssignments)

    // Build containment parent map from canvas edges (ground truth).
    // The referenceModelStore.parentMap may be empty in the wizard context
    // because computeAssignments hasn't run yet.
    const canvasEdges = useCanvasStore(s => s.edges)
    const containmentEdgeTypes = useContainmentEdgeTypes()

    const canvasParentMap = useMemo(() => {
        const map = new Map<string, string>() // childId -> parentId
        canvasEdges.forEach(edge => {
            if (isContainmentEdgeType(normalizeEdgeType(edge), containmentEdgeTypes)) {
                map.set(edge.target, edge.source)
            }
        })
        return map
    }, [canvasEdges, containmentEdgeTypes])

    // Merge: canvas-derived parent map takes precedence (always fresh),
    // then fall back to store parent map (populated after computeAssignments)
    const parentMap = useMemo(() => {
        if (canvasParentMap.size > 0) return canvasParentMap
        return storeParentMap
    }, [canvasParentMap, storeParentMap])

    // Build layer assignment lookup from formData.assignments (wizard's canonical
    // buffer) AND store effectiveAssignments (backend state). formData.assignments
    // is the immediate source of truth when the user is actively assigning in the
    // wizard; legacy layers[].entityAssignments (still written by Auto-Organize,
    // untouched by this refactor) is consulted as a lower-priority fallback so
    // its in-session suggestions still render as assigned.
    const layerAssignmentMap = useMemo(() => {
        const map = new Map<string, string>() // entityId -> layerId
        // Start with store assignments (lowest priority)
        storeEffectiveAssignments.forEach((a, entityId) => {
            map.set(entityId, a.layerId)
        })
        // Legacy per-layer entityAssignments (e.g. Auto-Organize suggestions)
        ;(formData.layers ?? []).forEach(layer => {
            layer.entityAssignments?.forEach(a => {
                map.set(a.entityId, layer.id)
            })
        })
        // Canonical formData.assignments wins (highest priority)
        Object.entries(formData.assignments ?? {}).forEach(([urn, entry]) => {
            map.set(urn, entry.layerId)
        })
        return map
    }, [storeEffectiveAssignments, formData.layers, formData.assignments])

    // ── Containment inheritance enforcement ──────────────────────────────────────
    const [assignmentWarning, setAssignmentWarning] = useState<string | null>(null)
    const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const showAssignmentWarning = useCallback((message: string) => {
        setAssignmentWarning(message)
        if (warningTimerRef.current) clearTimeout(warningTimerRef.current)
        warningTimerRef.current = setTimeout(() => setAssignmentWarning(null), 5000)
    }, [])

    /** Check if an entity is a containment child whose parent is in a different layer */
    const isContainmentLocked = useCallback((entityId: string, targetLayerId: string): boolean => {
        const parentId = parentMap.get(entityId)
        if (!parentId) return false
        const parentLayerId = layerAssignmentMap.get(parentId)
        return !!parentLayerId && parentLayerId !== targetLayerId
    }, [parentMap, layerAssignmentMap])

    /** Build reverse child map from parentMap */
    const childMap = useMemo(() => {
        const map = new Map<string, string[]>()
        parentMap.forEach((pId, cId) => {
            const list = map.get(pId) ?? []
            list.push(cId)
            map.set(pId, list)
        })
        return map
    }, [parentMap])

    /** Get all containment descendants currently assigned to a different layer */
    const getDescendantsInDifferentLayer = useCallback((entityId: string, targetLayerId: string): string[] => {
        const result: string[] = []
        const queue = [...(childMap.get(entityId) ?? [])]
        const visited = new Set<string>()
        while (queue.length > 0) {
            const cId = queue.shift()!
            if (visited.has(cId)) continue
            visited.add(cId)
            const currentLayer = layerAssignmentMap.get(cId)
            if (currentLayer && currentLayer !== targetLayerId) {
                result.push(cId)
            }
            queue.push(...(childMap.get(cId) ?? []))
        }
        return result
    }, [childMap, layerAssignmentMap])

    // ── Entity identity (names + children) ──────────────────────────────────────
    // The wizard has NO canvas, so identity comes from the entity browser's own
    // data (published as a snapshot) plus on-demand getNode() lookups for
    // assignments the browser hasn't paged in yet (edit mode).
    const provider = useGraphProvider()
    const [snapshot, setSnapshot] = useState<BrowserSnapshot | null>(null)
    const entityIndex = useWizardEntityIndex({
        provider,
        containmentEdgeTypes,
        assignments: formData.assignments ?? {},
        snapshot,
    })
    const nameOf = useCallback(
        (urn: string) => entityIndex.resolve(urn)?.name ?? fallbackNameFromUrn(urn),
        [entityIndex],
    )
    const { showToast } = useToast()

    // ── Confirmation dialog for child reassignment ────────────────────────────
    const [pendingReassign, setPendingReassign] = useState<{
        info: ChildReassignInfo
        /** Callback that performs the actual reassignment */
        commit: () => void
    } | null>(null)

    // ── Layer + assignment state with undo/redo ──────────────────────────────────
    // Undo/redo snapshots the FULL {layers, assignments} pair so an assignment
    // gesture and a layer-structure edit (logical nodes, reorder, auto-organize)
    // share one history.
    const layers = formData.layers ?? []
    const assignments = formData.assignments ?? {}

    const undoStackRef = useRef<NormalizedReferenceLayout[]>([])
    const redoStackRef = useRef<NormalizedReferenceLayout[]>([])
    const isUndoRedoRef = useRef(false)

    const commitLayout = useCallback(
        (next: NormalizedReferenceLayout) => {
            if (!isUndoRedoRef.current) {
                undoStackRef.current = [...undoStackRef.current, { layers, assignments }]
                redoStackRef.current = []
                // Cap stack size
                if (undoStackRef.current.length > 50) undoStackRef.current.shift()
            }
            updateFormData({ layers: next.layers, assignments: next.assignments })
        },
        [updateFormData, layers, assignments]
    )

    // Layer-structure-only updates (logical node CRUD, reorder, auto-organize)
    // leave assignments untouched.
    const handleUpdateLayers = useCallback(
        (nextLayers: ViewLayerConfig[]) => commitLayout({ layers: nextLayers, assignments }),
        [commitLayout, assignments]
    )

    const canUndo = undoStackRef.current.length > 0
    const canRedo = redoStackRef.current.length > 0

    const handleUndo = useCallback(() => {
        if (undoStackRef.current.length === 0) return
        const prev = undoStackRef.current[undoStackRef.current.length - 1]
        undoStackRef.current = undoStackRef.current.slice(0, -1)
        redoStackRef.current = [...redoStackRef.current, { layers, assignments }]
        isUndoRedoRef.current = true
        updateFormData({ layers: prev.layers, assignments: prev.assignments })
        isUndoRedoRef.current = false
    }, [updateFormData, layers, assignments])

    const handleRedo = useCallback(() => {
        if (redoStackRef.current.length === 0) return
        const next = redoStackRef.current[redoStackRef.current.length - 1]
        redoStackRef.current = redoStackRef.current.slice(0, -1)
        undoStackRef.current = [...undoStackRef.current, { layers, assignments }]
        isUndoRedoRef.current = true
        updateFormData({ layers: next.layers, assignments: next.assignments })
        isUndoRedoRef.current = false
    }, [updateFormData, layers, assignments])

    // Keyboard shortcuts for undo/redo
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
                e.preventDefault()
                if (e.shiftKey) {
                    handleRedo()
                } else {
                    handleUndo()
                }
            }
        }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [handleUndo, handleRedo])

    // ── Logical nodes ───────────────────────────────────────────────────────────
    const logicalNodes = useLogicalNodes(layers, handleUpdateLayers)

    // ── Active drop target ──────────────────────────────────────────────────────
    const [activeTarget, setActiveTarget] = useState<ActiveTarget | null>(() =>
        layers.length > 0 ? { layerId: layers[0].id, label: layers[0].name } : null
    )

    // Always default to first layer when layers change
    useEffect(() => {
        if (!activeTarget && layers.length > 0) {
            setActiveTarget({ layerId: layers[0].id, label: layers[0].name })
        }
    }, [layers.length]) // eslint-disable-line react-hooks/exhaustive-deps

    // ── Layer reorder ───────────────────────────────────────────────────────────
    const handleReorderLayers = useCallback(
        (newIds: string[]) => {
            const reordered = newIds
                .map(id => layers.find(l => l.id === id))
                .filter((l): l is ViewLayerConfig => !!l)
                .map((l, i) => ({ ...l, order: i, sequence: i }))
            handleUpdateLayers(reordered)
        },
        [layers, handleUpdateLayers]
    )

    // ── Shared: commit entity + descendants to a layer ─────────────────────────
    // Descendants in a different layer are cleared (not re-stamped) so they fall
    // back to containment inheritance from the newly-assigned parent — mirrors
    // the canvas's handleAssignToLayer/moveToLayer (assignmentMutations.ts).
    const commitAssignment = useCallback(
        (entityIds: string[], descendantsToMove: string[], layerId: string, logicalNodeId?: string) => {
            const next = assignEntities(
                { layers, assignments },
                entityIds,
                layerId,
                { logicalNodeId, clearDescendants: descendantsToMove },
            )
            commitLayout(next)

            // Make the inheritance rule visible: placing one root silently covers
            // its whole subtree, which is exactly what people don't expect.
            const inherited = entityIds.reduce(
                (sum, id) => sum + (entityIndex.resolve(id)?.childCount ?? 0),
                0,
            )
            if (inherited > 0) {
                const layerName = layers.find(l => l.id === layerId)?.name ?? 'layer'
                const what = entityIds.length === 1 ? nameOf(entityIds[0]) : `${entityIds.length} entities`
                showToast('success', `${what} → ${layerName} · ${inherited} ${inherited === 1 ? 'child inherits' : 'children inherit'} automatically`)
            }
        },
        [layers, assignments, commitLayout, entityIndex, nameOf, showToast]
    )

    /** Show confirmation dialog if descendants need moving, otherwise commit immediately */
    const confirmOrCommit = useCallback(
        (entityIds: string[], descendantsToMove: string[], layerId: string, logicalNodeId?: string) => {
            if (descendantsToMove.length === 0) {
                commitAssignment(entityIds, [], layerId, logicalNodeId)
                return
            }
            // Build info for the confirmation dialog
            const info: ChildReassignInfo = {
                entityId: entityIds[0],
                entityName: entityIds.length === 1
                    ? nameOf(entityIds[0])
                    : `${entityIds.length} entities`,
                targetLayerId: layerId,
                descendantsToMove: descendantsToMove.map(dId => ({
                    id: dId,
                    name: nameOf(dId),
                    currentLayerId: layerAssignmentMap.get(dId) ?? '',
                })),
            }
            setPendingReassign({
                info,
                commit: () => {
                    commitAssignment(entityIds, descendantsToMove, layerId, logicalNodeId)
                    setPendingReassign(null)
                },
            })
        },
        [commitAssignment, nameOf, layerAssignmentMap]
    )

    // ── Assignment from entity tree ─────────────────────────────────────────────
    const handleAssignmentChange = useCallback(
        (entityId: string, layerId: string | null) => {
            // Unassign explicitly if layerId is empty or null (e.g. clicking 'X')
            if (!layerId) {
                commitLayout(unassignEntities({ layers, assignments }, [entityId]))
                return
            }

            // HARD RULE: Block containment children from being assigned to a different layer
            if (isContainmentLocked(entityId, layerId)) {
                showAssignmentWarning('Cannot assign child to a different layer than its parent. Children always inherit their parent\'s layer assignment.')
                return
            }

            // DOWN check: gather descendants in a different layer
            const descendantsToMove = getDescendantsInDifferentLayer(entityId, layerId)
            const targetNodeId = layerId === activeTarget?.layerId ? activeTarget?.nodeId : undefined

            confirmOrCommit([entityId], descendantsToMove, layerId, targetNodeId)
        },
        [activeTarget, layers, assignments, commitLayout, isContainmentLocked, getDescendantsInDifferentLayer, showAssignmentWarning, confirmOrCommit]
    )

    const handleBulkAssignment = useCallback(
        (layerId: string, entityIds: string[]) => {
            // UP check: filter out containment-locked children
            const allowed = entityIds.filter(id => !isContainmentLocked(id, layerId))
            const blockedCount = entityIds.length - allowed.length
            if (blockedCount > 0) {
                showAssignmentWarning(`${blockedCount} assignment(s) blocked: children inherit their parent's layer.`)
            }
            if (allowed.length === 0) return

            // DOWN check: collect containment descendants that need to follow
            const allDescendantsToMove: string[] = []
            allowed.forEach(id => {
                allDescendantsToMove.push(...getDescendantsInDifferentLayer(id, layerId))
            })

            const targetNodeId = layerId === activeTarget?.layerId ? activeTarget?.nodeId : undefined
            confirmOrCommit(allowed, allDescendantsToMove, layerId, targetNodeId)
        },
        [activeTarget, isContainmentLocked, getDescendantsInDifferentLayer, showAssignmentWarning, confirmOrCommit]
    )

    // ── Direct drop onto hierarchy panel layer/node ─────────────────────────────
    const handleHierarchyDrop = useCallback(
        (layerId: string, nodeId: string | undefined, payload: DropPayload) => {
            const rawIds: string[] = payload.entityIds?.length
                ? payload.entityIds
                : payload.entityId
                    ? [payload.entityId]
                    : []

            if (rawIds.length === 0) return

            // UP check: filter out containment-locked children
            const entityIds = rawIds.filter(id => !isContainmentLocked(id, layerId))
            const blockedCount = rawIds.length - entityIds.length
            if (blockedCount > 0) {
                showAssignmentWarning(`${blockedCount} assignment(s) blocked: children inherit their parent's layer.`)
            }
            if (entityIds.length === 0) return

            // DOWN check: collect all containment descendants that need to follow
            const allDescendantsToMove: string[] = []
            entityIds.forEach(id => {
                allDescendantsToMove.push(...getDescendantsInDifferentLayer(id, layerId))
            })

            confirmOrCommit(entityIds, allDescendantsToMove, layerId, nodeId)

            // Update active target to reflect where the drop landed
            const layer = layers.find(l => l.id === layerId)
            if (layer) {
                const nodeLabel = nodeId
                    ? logicalNodes.nodePathLabel(layerId, nodeId)
                    : ''
                setActiveTarget({
                    layerId,
                    nodeId,
                    label: nodeLabel ? `${layer.name} → ${nodeLabel}` : layer.name,
                })
            }
        },
        [layers, logicalNodes, isContainmentLocked, getDescendantsInDifferentLayer, showAssignmentWarning, confirmOrCommit]
    )

    // ── Layer CRUD (in-step) ────────────────────────────────────────────────────
    // Routed through commitLayout so add/rename/delete share ONE undo history
    // with assignments — you never have to walk back to the Layout step because
    // you forgot a layer.
    const handleAddLayer = useCallback((name: string) => {
        const nextLayer: ViewLayerConfig = {
            id: generateId('layer'),
            name,
            description: '',
            color: LAYER_COLORS[layers.length % LAYER_COLORS.length],
            entityTypes: [],
            order: layers.length,
            sequence: layers.length,
        }
        handleUpdateLayers([...layers, nextLayer])
    }, [layers, handleUpdateLayers])

    const handleRenameLayer = useCallback((layerId: string, name: string) => {
        handleUpdateLayers(layers.map(l => (l.id === layerId ? { ...l, name } : l)))
    }, [layers, handleUpdateLayers])

    /** Deleting a layer also drops every placement into it — one atomic commit,
     *  so a single undo restores both the layer AND its assignments. */
    const handleDeleteLayer = useCallback((layerId: string) => {
        const nextLayers = layers
            .filter(l => l.id !== layerId)
            .map((l, i) => ({ ...l, order: i, sequence: i }))
        const nextAssignments = Object.fromEntries(
            Object.entries(assignments).filter(([, entry]) => entry.layerId !== layerId)
        )
        commitLayout({ layers: nextLayers, assignments: nextAssignments })
        setActiveTarget(prev => (prev?.layerId === layerId
            ? (nextLayers.length > 0 ? { layerId: nextLayers[0].id, label: nextLayers[0].name } : null)
            : prev))
    }, [layers, assignments, commitLayout])

    // ── Auto-organize ───────────────────────────────────────────────────────────
    const autoOrganize = useAutoOrganize()
    const [showSuggestions, setShowSuggestions] = useState(false)

    // ── Magic Map ───────────────────────────────────────────────────────────────
    // Matches top-level entity names against layer names ("Staging" → Staging)
    // and proposes the whole mapping at once. Each accepted suggestion is ONE
    // assignment entry with inheritsChildren — an 888-child root is placed
    // without enumerating a single child.
    const [magicSuggestions, setMagicSuggestions] = useState<MagicMapSuggestion[] | null>(null)
    const [magicBusy, setMagicBusy] = useState(false)

    const runMagicMap = useCallback(() => {
        if (!snapshot) return
        const unassignedRoots = snapshot.topLevelIds
            .filter(urn => !assignments[urn])
            .map(urn => {
                const identity = snapshot.directory.get(urn)
                return identity
                    ? { urn, name: identity.name, type: identity.type }
                    : null
            })
            .filter((c): c is { urn: string; name: string; type: string } => c !== null)
        setMagicSuggestions(suggestLayerMappings(unassignedRoots, layers))
    }, [snapshot, assignments, layers])

    /** Scan every top-level entity, not just the loaded page. */
    const loadAllThenMagicMap = useCallback(async () => {
        if (!snapshot) return
        setMagicBusy(true)
        try {
            await snapshot.loadAllTopLevel()
        } finally {
            setMagicBusy(false)
        }
    }, [snapshot])

    // Re-run whenever the scanned population changes (e.g. after "Load all").
    useEffect(() => {
        if (magicSuggestions !== null && !magicBusy) runMagicMap()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [snapshot?.topLevelIds.length, magicBusy])

    /** Apply N suggestions in ONE commit → one undo step. */
    const applyMagicSuggestions = useCallback((accepted: MagicMapSuggestion[]) => {
        if (accepted.length === 0) return
        let working: NormalizedReferenceLayout = { layers, assignments }
        const byLayer = new Map<string, string[]>()
        accepted.forEach(s => byLayer.set(s.layerId, [...(byLayer.get(s.layerId) ?? []), s.urn]))
        byLayer.forEach((urns, layerId) => {
            working = assignEntities(working, urns, layerId, { assignedBy: 'rule' })
        })
        commitLayout(working)
        setMagicSuggestions(prev => (prev ?? []).filter(s => !accepted.some(a => a.urn === s.urn)))
        showToast('success', `Placed ${accepted.length} ${accepted.length === 1 ? 'entity' : 'entities'} — their children inherit automatically`)
    }, [layers, assignments, commitLayout, showToast])

    // ── Preview pane toggle ─────────────────────────────────────────────────────
    const [showPreview, setShowPreview] = useState(false)

    // ── Render ──────────────────────────────────────────────────────────────────

    return (
        <div className="flex flex-col h-full gap-0">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-1 pb-3">
                <div className="flex items-center gap-2">
                    {/* Undo / Redo — covers assignments, logical nodes, reordering */}
                    <button
                        onClick={handleUndo}
                        disabled={!canUndo}
                        className={cn(
                            'p-1.5 rounded-lg transition-colors text-slate-400',
                            canUndo
                                ? 'hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-700 dark:hover:text-slate-200'
                                : 'opacity-30 cursor-not-allowed'
                        )}
                        title="Undo (⌘Z)"
                    >
                        <Undo2 className="w-4 h-4" />
                    </button>
                    <button
                        onClick={handleRedo}
                        disabled={!canRedo}
                        className={cn(
                            'p-1.5 rounded-lg transition-colors text-slate-400',
                            canRedo
                                ? 'hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-700 dark:hover:text-slate-200'
                                : 'opacity-30 cursor-not-allowed'
                        )}
                        title="Redo (⌘⇧Z)"
                    >
                        <Redo2 className="w-4 h-4" />
                    </button>

                    <div className="w-px h-4 bg-slate-200 dark:bg-slate-700" />

                    {/* Auto-organize */}
                    <button
                        onClick={() => {
                            // TODO: pass entity list from tree when available via ref/context
                            setShowSuggestions(v => !v)
                        }}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-violet-600 hover:text-violet-700 hover:bg-violet-50 dark:hover:bg-violet-900/20 rounded-lg transition-colors"
                    >
                        <Sparkles className="w-4 h-4" />
                        Auto-Organize
                        {autoOrganize.suggestions.length > 0 && (
                            <span className="px-1.5 py-0.5 text-xs bg-violet-100 dark:bg-violet-900/40 text-violet-700 rounded-full">
                                {autoOrganize.suggestions.length}
                            </span>
                        )}
                    </button>

                    {/* Magic Map — name-match top-level entities to layers in one pass */}
                    <button
                        onClick={() => {
                            if (magicSuggestions !== null) { setMagicSuggestions(null); return }
                            runMagicMap()
                        }}
                        disabled={layers.length === 0 || !snapshot}
                        title={layers.length === 0
                            ? 'Add a layer first'
                            : 'Match top-level entities to layers by name'}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        <Wand2 className="w-4 h-4" />
                        Magic Map
                    </button>
                </div>

                <div className="flex items-center gap-3">
                    {/* Preview toggle */}
                    <button
                        onClick={() => setShowPreview(v => !v)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
                    >
                        {showPreview ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        {showPreview ? 'Hide' : 'Preview'}
                    </button>
                </div>
            </div>

            {/* Containment inheritance warning */}
            {assignmentWarning && (
                <div className="mx-1 mb-2 px-3 py-2 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-xs flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    <span className="flex-1"><span className="font-medium">Assignment blocked.</span> {assignmentWarning}</span>
                    <button onClick={() => setAssignmentWarning(null)} className="text-red-400 hover:text-red-600">&times;</button>
                </div>
            )}

            {/* Three-panel layout */}
            <div className="relative flex-1 min-h-0">
                <div
                    className={cn(
                        'h-full grid gap-4',
                        showPreview ? 'grid-cols-[240px_1fr_260px]' : 'grid-cols-[240px_1fr]'
                    )}
                >
                    {/* Left: Layer hierarchy */}
                    <LayerHierarchyPanel
                        layers={layers}
                        assignments={assignments}
                        activeTarget={activeTarget}
                        logicalNodes={logicalNodes}
                        entityIndex={entityIndex}
                        onSetActiveTarget={setActiveTarget}
                        onDrop={handleHierarchyDrop}
                        onUnassign={(entityId) => handleAssignmentChange(entityId, null)}
                        onReorderLayers={handleReorderLayers}
                        onAddLayer={handleAddLayer}
                        onRenameLayer={handleRenameLayer}
                        onDeleteLayer={handleDeleteLayer}
                        className="min-h-0"
                    />

                    {/* Center: Entity browser */}
                    <div className="min-h-0 flex flex-col">
                        {/* Active target strip */}
                        {activeTarget && (
                            <div className="mb-2 flex items-center gap-2 px-3 py-2 rounded-xl bg-blue-50 dark:bg-blue-950/50 border border-blue-200 dark:border-blue-800">
                                <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse shrink-0" />
                                <span className="text-xs text-blue-600 dark:text-blue-400">
                                    Dropping into:{' '}
                                    <strong>{activeTarget.label}</strong>
                                </span>
                            </div>
                        )}
                        <WizardAssignmentTree
                            layers={layers}
                            assignments={assignments}
                            activeTarget={activeTarget}
                            onAssignmentChange={handleAssignmentChange}
                            onBulkAssign={handleBulkAssignment}
                            onBrowserSnapshot={setSnapshot}
                            className="flex-1 min-h-0"
                        />
                    </div>

                    {/* Right: Preview pane */}
                    <AnimatePresence>
                        {showPreview && (
                            <motion.div
                                initial={{ opacity: 0, x: 20 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: 20 }}
                                className={cn(
                                    'min-h-0 rounded-2xl overflow-hidden',
                                    'bg-slate-50 dark:bg-slate-900',
                                    'border border-slate-200 dark:border-slate-700',
                                    'flex flex-col'
                                )}
                            >
                                <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-700">
                                    <p className="text-xs font-medium text-slate-500">Live Preview</p>
                                </div>
                                <div className="flex-1 flex items-center justify-center text-xs text-slate-400 p-4 text-center">
                                    {/* Mini canvas preview — rendered at scale */}
                                    <ContextModelMiniPreview layers={layers} assignments={assignments} />
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>

                {/* Suggestions sheet overlay */}
                <AnimatePresence>
                    {showSuggestions && autoOrganize.suggestions.length > 0 && (
                        <AutoOrganizeSheet
                            suggestions={autoOrganize.suggestions}
                            onAcceptAll={() => {
                                autoOrganize.acceptAll(layers, handleUpdateLayers)
                                setShowSuggestions(false)
                            }}
                            onAcceptOne={s => autoOrganize.acceptOne(s, layers, handleUpdateLayers)}
                            onDismissOne={autoOrganize.dismissOne}
                            onClose={() => setShowSuggestions(false)}
                        />
                    )}
                </AnimatePresence>

                {/* Magic Map review sheet */}
                <AnimatePresence>
                    {magicSuggestions !== null && snapshot && (
                        <MagicMapSheet
                            suggestions={magicSuggestions}
                            scanned={snapshot.topLevelIds.length}
                            total={Math.max(snapshot.topLevelTotalCount, snapshot.topLevelIds.length)}
                            hasMore={snapshot.topLevelHasMore}
                            busy={magicBusy}
                            onLoadAll={loadAllThenMagicMap}
                            onAcceptAll={() => {
                                applyMagicSuggestions(magicSuggestions)
                                setMagicSuggestions(null)
                            }}
                            onAcceptOne={s => applyMagicSuggestions([s])}
                            onDismissOne={urn => setMagicSuggestions(prev => (prev ?? []).filter(s => s.urn !== urn))}
                            onClose={() => setMagicSuggestions(null)}
                        />
                    )}
                </AnimatePresence>
            </div>

            {/* Child reassignment confirmation dialog */}
            <ChildReassignConfirmDialog
                info={pendingReassign?.info ?? null}
                layers={layers}
                onConfirm={() => pendingReassign?.commit()}
                onCancel={() => setPendingReassign(null)}
            />
        </div>
    )
}

// ─── Mini preview ─────────────────────────────────────────────────────────────

function ContextModelMiniPreview({
    layers,
    assignments,
}: {
    layers: ViewLayerConfig[]
    assignments: Record<string, LayerAssignmentEntry>
}) {
    const assignedCounts = useMemo(() => {
        const counts = new Map<string, number>()
        Object.values(assignments).forEach(a => counts.set(a.layerId, (counts.get(a.layerId) ?? 0) + 1))
        return counts
    }, [assignments])

    if (layers.length === 0) {
        return <span>No layers to preview</span>
    }

    return (
        <div className="w-full space-y-2">
            {layers.map(l => {
                const assigned = assignedCounts.get(l.id) ?? 0
                const nodeCount = countNodes(l.logicalNodes ?? [])
                return (
                    <div key={l.id} className="w-full">
                        {/* Layer bar */}
                        <div
                            className="flex items-center justify-between px-2 py-1.5 rounded-lg text-white text-xs font-medium"
                            style={{ backgroundColor: l.color ?? '#3b82f6' }}
                        >
                            <span className="truncate">{l.name}</span>
                            <span className="ml-2 opacity-80 shrink-0">{assigned}</span>
                        </div>
                        {/* Logical node pills */}
                        {nodeCount > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1 ml-2">
                                {(l.logicalNodes ?? []).slice(0, 3).map(n => (
                                    <span
                                        key={n.id}
                                        className="text-[10px] px-1.5 py-0.5 rounded"
                                        style={{
                                            backgroundColor: (l.color ?? '#3b82f6') + '20',
                                            color: l.color ?? '#3b82f6',
                                        }}
                                    >
                                        {n.name}
                                    </span>
                                ))}
                                {nodeCount > 3 && (
                                    <span className="text-[10px] text-slate-400">+{nodeCount - 3}</span>
                                )}
                            </div>
                        )}
                    </div>
                )
            })}
        </div>
    )
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function countNodes(nodes: import('@/types/schema').LogicalNodeConfig[]): number {
    return nodes.reduce((acc, n) => acc + 1 + countNodes(n.children ?? []), 0)
}
