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
 * - Autosave to backend (debounced 800ms) with status indicator
 * - "Auto-Organize" heuristic suggestions with review sheet
 * - Live mini canvas preview (toggle-able)
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
    Eye,
    EyeOff,
    CheckCircle2,
    AlertCircle,
    Loader2,
    Check,
    X,
    ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { LayerHierarchyPanel, type ActiveTarget, type DropPayload } from './LayerHierarchyPanel'
import { WizardAssignmentTree } from '../views/ViewWizard/WizardAssignmentTree'
import { useLogicalNodes } from '@/hooks/useLogicalNodes'
import { useAutoOrganize, type GroupingSuggestion } from '@/hooks/useAutoOrganize'
import { makeDraftSave, type ContextModelCreateRequest } from '@/services/contextModelService'
import type { ViewLayerConfig, EntityAssignmentConfig } from '@/types/schema'
import type { WizardFormData } from '../views/ViewWizard/ViewWizard'
import { useWorkspacesStore } from '@/store/workspaces'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { useCanvasStore } from '@/store/canvas'
import { useContainmentEdgeTypes, normalizeEdgeType, isContainmentEdgeType } from '@/store/schema'
import { ChildReassignConfirmDialog, type ChildReassignInfo } from '../dialogs/ChildReassignConfirmDialog'

// ─── Types ────────────────────────────────────────────────────────────────────

interface LayerStudioProps {
    formData: WizardFormData
    updateFormData: (updates: Partial<WizardFormData>) => void
    /** Draft context model ID (if editing existing) */
    linkedContextModelId?: string | null
    onDraftSaved?: (modelId: string) => void
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

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

// ─── Main Component ───────────────────────────────────────────────────────────

export function LayerStudio({
    formData,
    updateFormData,
    linkedContextModelId,
    onDraftSaved,
}: LayerStudioProps) {
    const activeWorkspaceId = useWorkspacesStore(s => s.activeWorkspaceId)
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

    // Build layer assignment lookup from formData.layers (wizard state)
    // AND store effectiveAssignments (backend state).
    // Wizard formData.layers entityAssignments are the immediate source of truth
    // when the user is actively assigning in the wizard.
    const layerAssignmentMap = useMemo(() => {
        const map = new Map<string, string>() // entityId -> layerId
        // Start with store assignments (lower priority)
        storeEffectiveAssignments.forEach((a, entityId) => {
            map.set(entityId, a.layerId)
        })
        // Override with wizard formData.layers assignments (higher priority)
        ;(formData.layers ?? []).forEach(layer => {
            layer.entityAssignments?.forEach(a => {
                map.set(a.entityId, layer.id)
            })
        })
        return map
    }, [storeEffectiveAssignments, formData.layers])

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

    // ── Node name lookup for confirmation dialog ────────────────────────────────
    const canvasNodes = useCanvasStore(s => s.nodes)
    const nodeNameMap = useMemo(() => {
        const map = new Map<string, string>()
        canvasNodes.forEach(n => {
            map.set(n.id, (n.data as { label?: string; businessLabel?: string }).label
                ?? (n.data as { businessLabel?: string }).businessLabel ?? n.id)
        })
        return map
    }, [canvasNodes])

    // ── Confirmation dialog for child reassignment ────────────────────────────
    const [pendingReassign, setPendingReassign] = useState<{
        info: ChildReassignInfo
        /** Callback that performs the actual reassignment */
        commit: () => void
    } | null>(null)

    // ── Layer state ─────────────────────────────────────────────────────────────
    const layers = formData.layers ?? []

    const handleUpdateLayers = useCallback(
        (next: ViewLayerConfig[]) => updateFormData({ layers: next }),
        [updateFormData]
    )

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

    // ── Autosave ────────────────────────────────────────────────────────────────
    const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
    const draftIdRef = useRef<string | null>(linkedContextModelId ?? null)

    const autosave = useMemo(
        () => (activeWorkspaceId ? makeDraftSave(activeWorkspaceId, 800) : null),
        [activeWorkspaceId]
    )

    // Trigger autosave on any layer change
    useEffect(() => {
        if (!autosave || !activeWorkspaceId) return

        setSaveStatus('saving')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const payload: ContextModelCreateRequest = {
            name: formData.name || 'Draft Context View',
            description: formData.description,
            layersConfig: layers as any,
            instanceAssignments: buildInstanceAssignments(layers) as any,
        }

        autosave(
            payload,
            draftIdRef,
            model => {
                setSaveStatus('saved')
                onDraftSaved?.(model.id)
                setTimeout(() => setSaveStatus('idle'), 2500)
            },
            () => setSaveStatus('error')
        )
    }, [layers]) // eslint-disable-line react-hooks/exhaustive-deps

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
    const commitAssignment = useCallback(
        (entityIds: string[], descendantsToMove: string[], layerId: string, logicalNodeId?: string) => {
            const allMovedIds = new Set([...entityIds, ...descendantsToMove])
            const next = layers.map(l => {
                const filtered: EntityAssignmentConfig[] = (l.entityAssignments ?? []).filter(
                    a => !allMovedIds.has(a.entityId)
                )
                if (l.id === layerId) {
                    return {
                        ...l,
                        entityAssignments: [
                            ...filtered,
                            ...entityIds.map(id => ({
                                entityId: id,
                                layerId,
                                logicalNodeId,
                                inheritsChildren: true,
                                priority: 1000,
                                assignedBy: 'user' as const,
                                assignedAt: new Date().toISOString(),
                            })),
                            ...descendantsToMove.map(dId => ({
                                entityId: dId,
                                layerId,
                                inheritsChildren: true,
                                priority: 999,
                                assignedBy: 'rule' as const,
                                assignedAt: new Date().toISOString(),
                            })),
                        ],
                    }
                }
                return { ...l, entityAssignments: filtered }
            })
            handleUpdateLayers(next)
        },
        [layers, handleUpdateLayers]
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
                    ? (nodeNameMap.get(entityIds[0]) ?? entityIds[0])
                    : `${entityIds.length} entities`,
                targetLayerId: layerId,
                descendantsToMove: descendantsToMove.map(dId => ({
                    id: dId,
                    name: nodeNameMap.get(dId) ?? dId,
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
        [commitAssignment, nodeNameMap, layerAssignmentMap]
    )

    // ── Assignment from entity tree ─────────────────────────────────────────────
    const handleAssignmentChange = useCallback(
        (entityId: string, layerId: string | null) => {
            // Unassign explicitly if layerId is empty or null (e.g. clicking 'X')
            if (!layerId) {
                const next = layers.map(l => ({
                    ...l,
                    entityAssignments: (l.entityAssignments ?? []).filter(a => a.entityId !== entityId)
                }))
                handleUpdateLayers(next)
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
        [activeTarget, layers, handleUpdateLayers, isContainmentLocked, getDescendantsInDifferentLayer, showAssignmentWarning, confirmOrCommit]
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

    // ── Auto-organize ───────────────────────────────────────────────────────────
    const autoOrganize = useAutoOrganize()
    const [showSuggestions, setShowSuggestions] = useState(false)

    // ── Preview pane toggle ─────────────────────────────────────────────────────
    const [showPreview, setShowPreview] = useState(false)

    // ── Render ──────────────────────────────────────────────────────────────────

    return (
        <div className="flex flex-col h-full gap-0">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-1 pb-3">
                <div className="flex items-center gap-2">
                    {/* Undo / Redo */}
                    <button
                        onClick={logicalNodes.undo}
                        disabled={!logicalNodes.canUndo}
                        className={cn(
                            'p-1.5 rounded-lg transition-colors text-slate-400',
                            logicalNodes.canUndo
                                ? 'hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-700 dark:hover:text-slate-200'
                                : 'opacity-30 cursor-not-allowed'
                        )}
                        title="Undo (⌘Z)"
                    >
                        <Undo2 className="w-4 h-4" />
                    </button>
                    <button
                        onClick={logicalNodes.redo}
                        disabled={!logicalNodes.canRedo}
                        className={cn(
                            'p-1.5 rounded-lg transition-colors text-slate-400',
                            logicalNodes.canRedo
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
                </div>

                <div className="flex items-center gap-3">
                    {/* Save status indicator */}
                    <AnimatePresence mode="wait">
                        {saveStatus === 'saving' && (
                            <motion.div
                                key="saving"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                className="flex items-center gap-1.5 text-xs text-slate-400"
                            >
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                Saving…
                            </motion.div>
                        )}
                        {saveStatus === 'saved' && (
                            <motion.div
                                key="saved"
                                initial={{ opacity: 0, scale: 0.9 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0 }}
                                className="flex items-center gap-1.5 text-xs text-emerald-600"
                            >
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                Draft saved
                            </motion.div>
                        )}
                        {saveStatus === 'error' && (
                            <motion.div
                                key="error"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                className="flex items-center gap-1.5 text-xs text-red-500"
                                title="Autosave failed — your changes are still in local state"
                            >
                                <AlertCircle className="w-3.5 h-3.5" />
                                Save failed
                            </motion.div>
                        )}
                    </AnimatePresence>

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
                        activeTarget={activeTarget}
                        logicalNodes={logicalNodes}
                        onSetActiveTarget={setActiveTarget}
                        onDrop={handleHierarchyDrop}
                        onUnassign={(entityId) => handleAssignmentChange(entityId, null)}
                        onReorderLayers={handleReorderLayers}
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
                            activeTarget={activeTarget}
                            onAssignmentChange={handleAssignmentChange}
                            onBulkAssign={handleBulkAssignment}
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
                                    <ContextModelMiniPreview layers={layers} />
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

function ContextModelMiniPreview({ layers }: { layers: ViewLayerConfig[] }) {
    if (layers.length === 0) {
        return <span>No layers to preview</span>
    }

    return (
        <div className="w-full space-y-2">
            {layers.map(l => {
                const assigned = l.entityAssignments?.length ?? 0
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

/**
 * Build the instanceAssignments payload for the backend.
 * Format: { [entityId]: { layerId, logicalNodeId?, inheritsChildren } }
 */
function buildInstanceAssignments(
    layers: ViewLayerConfig[]
): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const l of layers) {
        for (const a of l.entityAssignments ?? []) {
            result[a.entityId] = {
                layerId: a.layerId,
                logicalNodeId: a.logicalNodeId ?? null,
                inheritsChildren: a.inheritsChildren,
                assignedBy: a.assignedBy ?? 'user',
            }
        }
    }
    return result
}
