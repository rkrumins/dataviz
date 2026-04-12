/**
 * AssignmentStepReference - Assignment step for 'reference' layout views.
 * Renders the full Layer Studio (three-panel WYSIWYG).
 */
import { LayerStudio } from '../../LayerStudio'
import type { AssignmentStepProps } from './AssignmentStep'

export function AssignmentStepReference({ formData, updateFormData, linkedContextModelId, onDraftSaved }: AssignmentStepProps) {
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
