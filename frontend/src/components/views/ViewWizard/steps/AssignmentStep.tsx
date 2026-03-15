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

import { useMemo, useCallback, useEffect } from 'react'
import { LayerStudio } from '../../LayerStudio'
import { WizardAssignmentTree } from '../WizardAssignmentTree'
import { LayerManager } from '../../LayerManager'
import { useSchemaStore } from '@/store/schema'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import type { EntityAssignmentConfig } from '@/types/schema'
import type { WizardFormData } from '../ViewWizard'

interface AssignmentStepProps {
    formData: WizardFormData
    updateFormData: (updates: Partial<WizardFormData>) => void
    linkedContextModelId?: string | null
    onDraftSaved?: (modelId: string) => void
}

export function AssignmentStep({ formData, updateFormData, linkedContextModelId, onDraftSaved }: AssignmentStepProps) {
    const schema = useSchemaStore(s => s.schema)
    const setLayers = useReferenceModelStore(s => s.setLayers)
    const bulkAssignEntitiesToLayer = useReferenceModelStore(s => s.bulkAssignEntitiesToLayer)

    // Sync layers with store for conflict detection
    useEffect(() => {
        if (formData.layers) {
            setLayers(formData.layers)
        }
    }, [formData.layers, setLayers])

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
    const containmentEdgeTypes = useMemo(() => {
        const configured = formData.scopeEdges?.edgeTypes
        if (configured && configured.length > 0) return configured
        return schema?.containmentEdgeTypes || [
            'contains', 'CONTAINS',
            'has_schema', 'HAS_SCHEMA',
            'has_dataset', 'HAS_DATASET',
            'has_column', 'HAS_COLUMN'
        ]
    }, [formData.scopeEdges?.edgeTypes, schema?.containmentEdgeTypes])

    // eslint-disable-next-line react-hooks/rules-of-hooks
    const handleAssignmentChange = useCallback((entityId: string, layerId: string | null) => {
        if (!formData.layers) return
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
    }, [formData.layers, updateFormData])

    // eslint-disable-next-line react-hooks/rules-of-hooks
    const handleBulkAssignment = useCallback((layerId: string, entityIds: string[]) => {
        if (!formData.layers) return
        bulkAssignEntitiesToLayer(entityIds, layerId, { inheritsChildren: true })
        const updatedLayers = formData.layers.map(layer => {
            const filteredAssignments = (layer.entityAssignments || [])
                .filter(a => !entityIds.includes(a.entityId))
            if (layer.id === layerId) {
                const newConfigs: EntityAssignmentConfig[] = entityIds.map(id => ({
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
    }, [formData.layers, bulkAssignEntitiesToLayer, updateFormData])

    return (
        <div className="flex h-[650px] gap-6">
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
    )
}
