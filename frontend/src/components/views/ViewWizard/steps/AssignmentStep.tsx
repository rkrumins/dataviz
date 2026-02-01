import { useMemo } from 'react'
import type { CreateViewRequest } from '@/services/viewService'
import { SmartAssignmentPanel } from '../../SmartAssignmentPanel'
import { LayerManager } from '../../LayerManager'

interface AssignmentStepProps {
    formData: CreateViewRequest
    updateFormData: (updates: Partial<CreateViewRequest>) => void
}

export function AssignmentStep({ formData, updateFormData }: AssignmentStepProps) {
    // Collect all entities that are already manually assigned to any layer
    const assignedEntityIds = useMemo(() => {
        const set = new Set<string>()
        if (formData.layers) {
            for (const layer of formData.layers) {
                if (layer.entityAssignments) {
                    for (const assignment of layer.entityAssignments) {
                        set.add(assignment.entityId)
                    }
                }
            }
        }
        return set
    }, [formData.layers])

    return (
        <div className="flex h-[600px] gap-6">
            {/* Left Panel: Available Entities */}
            <div className="w-1/3 min-w-[320px] flex flex-col">
                <div className="mb-2">
                    <h3 className="text-lg font-semibold text-slate-800 dark:text-white">Entities</h3>
                    <p className="text-sm text-slate-500">Drag to assign to layers</p>
                </div>
                <div className="flex-1 min-h-0">
                    <SmartAssignmentPanel
                        assignedEntityIds={assignedEntityIds}
                        className="h-full shadow-sm"
                    />
                </div>
            </div>

            {/* Right Panel: Layer Drop Targets */}
            <div className="flex-1 flex flex-col min-h-0">
                <div className="mb-2">
                    <h3 className="text-lg font-semibold text-slate-800 dark:text-white">Layers</h3>
                    <p className="text-sm text-slate-500">Drop entities here</p>
                </div>
                <div className="flex-1 overflow-y-auto pr-2">
                    <LayerManager
                        layers={formData.layers || []}
                        onUpdate={(layers) => updateFormData({ layers })}
                        mode="assignment"
                        className="pb-4"
                    />
                </div>
            </div>
        </div>
    )
}
