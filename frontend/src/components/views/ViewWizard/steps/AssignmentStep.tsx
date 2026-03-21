/**
 * AssignmentStep - Hosts the Layer Studio for reference layout views,
 * or falls back to the original tree + LayerManager for other layouts.
 *
 * The Layer Studio provides:
 * - Three-panel WYSIWYG: Layer Hierarchy | Entity Browser | Live Preview
 * - Logical node (group) CRUD with undo/redo
 * - Autosave to backend (debounced 800ms)
 * - Auto-organize suggestions
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LayerStudio } from '../../LayerStudio'
import { WizardAssignmentTree } from '../WizardAssignmentTree'
import { LayerManager } from '../../LayerManager'

import { useReferenceModelStore } from '@/store/referenceModelStore'
import { useCanvasStore } from '@/store/canvas'
import { useContainmentEdgeTypes, normalizeEdgeType, isContainmentEdgeType } from '@/store/schema'
import type { EntityAssignmentConfig } from '@/types/schema'
import type { WizardFormData } from '../ViewWizard'

interface AssignmentStepProps {
    formData: WizardFormData
    updateFormData: (updates: Partial<WizardFormData>) => void
    linkedContextModelId?: string | null
    onDraftSaved?: (modelId: string) => void
}

export function AssignmentStep({ formData, updateFormData, linkedContextModelId, onDraftSaved }: AssignmentStepProps) {
    const setLayers = useReferenceModelStore(s => s.setLayers)
    const bulkAssignEntitiesToLayer = useReferenceModelStore(s => s.bulkAssignEntitiesToLayer)

    // Sync layers with store for conflict detection
    useEffect(() => {
        if (formData.layers) {
            setLayers(formData.layers)
        }
    }, [formData.layers, setLayers])

    // Build containment parent map from canvas edges (ground truth for wizard context)
    const canvasEdges = useCanvasStore(s => s.edges)
    const containmentEdgeTypes = useContainmentEdgeTypes()
    const storeParentMap = useReferenceModelStore(s => s.parentMap)
    const storeEffectiveAssignments = useReferenceModelStore(s => s.effectiveAssignments)

    const parentMap = useMemo(() => {
        const map = new Map<string, string>()
        canvasEdges.forEach(edge => {
            if (isContainmentEdgeType(normalizeEdgeType(edge), containmentEdgeTypes)) {
                map.set(edge.target, edge.source)
            }
        })
        return map.size > 0 ? map : storeParentMap
    }, [canvasEdges, containmentEdgeTypes, storeParentMap])

    // Layer assignment lookup: wizard formData.layers > store effectiveAssignments
    const layerAssignmentMap = useMemo(() => {
        const map = new Map<string, string>()
        storeEffectiveAssignments.forEach((a, entityId) => map.set(entityId, a.layerId))
        ;(formData.layers ?? []).forEach(layer => {
            layer.entityAssignments?.forEach(a => map.set(a.entityId, layer.id))
        })
        return map
    }, [storeEffectiveAssignments, formData.layers])

    const [assignmentWarning, setAssignmentWarning] = useState<string | null>(null)
    const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const isReferenceLayout = formData.layoutType === 'reference'

    // ── Reference layout → full Layer Studio ──────────────────────────────────
    if (isReferenceLayout) {
        return (
            <div className="h-[680px] flex flex-col">
                <LayerStudio
                    formData={formData}
                    updateFormData={updateFormData}
                    linkedContextModelId={linkedContextModelId}
                    onDraftSaved={onDraftSaved}
                />
            </div>
        )
    }

    // ── Fallback: original two-panel for non-reference layouts ─────────────────
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const handleAssignmentChange = useCallback((entityId: string, layerId: string | null) => {
        if (!formData.layers) return

        // HARD RULE: Block containment children from being assigned to a different layer
        if (layerId) {
            const parentId = parentMap.get(entityId)
            if (parentId) {
                const parentLayerId = layerAssignmentMap.get(parentId)
                if (parentLayerId && parentLayerId !== layerId) {
                    setAssignmentWarning('Cannot assign child to a different layer than its parent. Children always inherit their parent\'s layer assignment.')
                    if (warningTimerRef.current) clearTimeout(warningTimerRef.current)
                    warningTimerRef.current = setTimeout(() => setAssignmentWarning(null), 5000)
                    return
                }
            }
        }

        const updatedLayers = formData.layers.map(layer => {
            const filteredAssignments = (layer.entityAssignments || [])
                .filter(a => a.entityId !== entityId)
            if (layer.id === layerId) {
                const newAssignment: EntityAssignmentConfig = {
                    entityId,
                    layerId: layer.id,
                    inheritsChildren: true,
                    priority: 1000,
                    assignedBy: 'user',
                    assignedAt: new Date().toISOString()
                }
                return { ...layer, entityAssignments: [...filteredAssignments, newAssignment] }
            }
            return { ...layer, entityAssignments: filteredAssignments }
        })
        updateFormData({ layers: updatedLayers })
    }, [formData.layers, updateFormData, parentMap, layerAssignmentMap])

    // eslint-disable-next-line react-hooks/rules-of-hooks
    const handleBulkAssignment = useCallback((layerId: string, entityIds: string[]) => {
        if (!formData.layers) return

        // Filter out containment-locked children
        const allowed = entityIds.filter(id => {
            const parentId = parentMap.get(id)
            if (!parentId) return true
            const parentLayerId = layerAssignmentMap.get(parentId)
            return !parentLayerId || parentLayerId === layerId
        })
        const blockedCount = entityIds.length - allowed.length
        if (blockedCount > 0) {
            setAssignmentWarning(`${blockedCount} assignment(s) blocked: children inherit their parent's layer.`)
            if (warningTimerRef.current) clearTimeout(warningTimerRef.current)
            warningTimerRef.current = setTimeout(() => setAssignmentWarning(null), 5000)
        }
        if (allowed.length === 0) return

        bulkAssignEntitiesToLayer(allowed, layerId, { inheritsChildren: true })
        const allowedSet = new Set(allowed)
        const updatedLayers = formData.layers.map(layer => {
            const filteredAssignments = (layer.entityAssignments || [])
                .filter(a => !allowedSet.has(a.entityId))
            if (layer.id === layerId) {
                const newConfigs: EntityAssignmentConfig[] = allowed.map(id => ({
                    entityId: id,
                    layerId: layer.id,
                    inheritsChildren: true,
                    priority: 1000,
                    assignedBy: 'user' as const,
                    assignedAt: new Date().toISOString()
                }))
                return { ...layer, entityAssignments: [...filteredAssignments, ...newConfigs] }
            }
            return { ...layer, entityAssignments: filteredAssignments }
        })
        updateFormData({ layers: updatedLayers })
    }, [formData.layers, bulkAssignEntitiesToLayer, updateFormData, parentMap, layerAssignmentMap])

    return (
        <div className="flex flex-col h-[650px] gap-2">
            {/* Containment inheritance warning */}
            {assignmentWarning && (
                <div className="mx-2 px-3 py-2 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-xs flex items-center gap-2">
                    <span className="font-medium">Assignment blocked.</span>
                    <span className="flex-1">{assignmentWarning}</span>
                    <button onClick={() => setAssignmentWarning(null)} className="text-red-400 hover:text-red-600">&times;</button>
                </div>
            )}
            <div className="flex flex-1 min-h-0 gap-6">
            <div className="w-2/5 min-w-[380px] flex flex-col">
                <WizardAssignmentTree
                    layers={formData.layers || []}
                    onAssignmentChange={handleAssignmentChange}
                    onBulkAssign={handleBulkAssignment}
                    className="h-full"
                />
            </div>
            <div className="flex-1 flex flex-col min-h-0">
                <div className="mb-3">
                    <h3 className="text-lg font-semibold text-slate-800 dark:text-white">Layer Targets</h3>
                    <p className="text-sm text-slate-500">Drop entities here or use the dropdown in the tree</p>
                </div>
                <div className="flex-1 overflow-y-auto pr-2">
                    <LayerManager
                        layers={formData.layers || []}
                        onUpdate={(layers) => updateFormData({ layers })}
                        onBulkAssign={handleBulkAssignment}
                        mode="assignment"
                        className="pb-4"
                    />
                </div>
            </div>
            </div>
        </div>
    )
}
