/**
 * AssignmentStep - Tree-based entity assignment for ViewWizard
 * 
 * Features:
 * - Hierarchical entity browser with virtualization
 * - Drag-and-drop to layer cards
 * - Bulk selection and assignment
 * - Configurable containment edge types
 */

import { useMemo, useCallback, useEffect } from 'react'
import { WizardAssignmentTree } from '../WizardAssignmentTree'
import { LayerManager } from '../../LayerManager'
import { useSchemaStore } from '@/store/schema'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import type { EntityAssignmentConfig } from '@/types/schema'
import type { WizardFormData } from '../ViewWizard'

interface AssignmentStepProps {
    formData: WizardFormData
    updateFormData: (updates: Partial<WizardFormData>) => void
}

export function AssignmentStep({ formData, updateFormData }: AssignmentStepProps) {
    const schema = useSchemaStore(s => s.schema)
    const setLayers = useReferenceModelStore(s => s.setLayers)
    const bulkAssignEntitiesToLayer = useReferenceModelStore(s => s.bulkAssignEntitiesToLayer)

    // Sync layers with store for conflict detection
    useEffect(() => {
        if (formData.layers) {
            setLayers(formData.layers)
        }
    }, [formData.layers, setLayers])

    // Get containment edge types from scope configuration or schema with fallback
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

    // Handle assignment changes from tree
    const handleAssignmentChange = useCallback((entityId: string, layerId: string | null) => {
        if (!formData.layers) return

        const updatedLayers = formData.layers.map(layer => {
            // Remove entity from all layers first
            const filteredAssignments = (layer.entityAssignments || [])
                .filter(a => a.entityId !== entityId)

            if (layer.id === layerId) {
                // Add to target layer
                const newAssignment: EntityAssignmentConfig = {
                    entityId,
                    layerId: layer.id,
                    inheritsChildren: true,
                    priority: 1000,
                    assignedBy: 'user',
                    assignedAt: new Date().toISOString()
                }
                return {
                    ...layer,
                    entityAssignments: [...filteredAssignments, newAssignment]
                }
            }

            return {
                ...layer,
                entityAssignments: filteredAssignments
            }
        })

        updateFormData({ layers: updatedLayers })
    }, [formData.layers, updateFormData])

    // Handle bulk assignment from tree or drops
    const handleBulkAssignment = useCallback((layerId: string, entityIds: string[]) => {
        if (!formData.layers) return

        // 1. Update store for conflict detection and graph compute
        bulkAssignEntitiesToLayer(entityIds, layerId, { inheritsChildren: true })

        // 2. Update local wizard state immediately
        const updatedLayers = formData.layers.map(layer => {
            // Remove entity from all layers first
            const filteredAssignments = (layer.entityAssignments || [])
                .filter(a => !entityIds.includes(a.entityId))

            if (layer.id === layerId) {
                // Add all successful to target layer
                const newConfigs: EntityAssignmentConfig[] = entityIds.map(id => ({
                    entityId: id,
                    layerId: layer.id,
                    inheritsChildren: true,
                    priority: 1000,
                    assignedBy: 'user',
                    assignedAt: new Date().toISOString()
                }))

                return {
                    ...layer,
                    entityAssignments: [...filteredAssignments, ...newConfigs]
                }
            }

            return {
                ...layer,
                entityAssignments: filteredAssignments
            }
        })

        updateFormData({ layers: updatedLayers })
    }, [formData.layers, bulkAssignEntitiesToLayer, updateFormData])

    return (
        <div className="flex h-[650px] gap-6">
            {/* Left Panel: Entity Tree Browser */}
            <div className="w-2/5 min-w-[380px] flex flex-col">
                <WizardAssignmentTree
                    layers={formData.layers || []}
                    containmentEdgeTypes={containmentEdgeTypes}
                    onAssignmentChange={handleAssignmentChange}
                    onBulkAssign={handleBulkAssignment}
                    className="h-full"
                />
            </div>

            {/* Right Panel: Layer Drop Targets */}
            <div className="flex-1 flex flex-col min-h-0">
                <div className="mb-3">
                    <h3 className="text-lg font-semibold text-slate-800 dark:text-white">
                        Layer Targets
                    </h3>
                    <p className="text-sm text-slate-500">
                        Drop entities here or use the dropdown in the tree
                    </p>
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
