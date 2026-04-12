/**
 * AssignmentStep - Dispatches to the correct layout-specific implementation.
 *
 * 'reference' → AssignmentStepReference (full Layer Studio)
 * everything else → AssignmentStepLegacy (tree + LayerManager two-panel)
 *
 * This shell has zero hooks so both branches are proper React components
 * with no rules-of-hooks violations.
 */
import { AssignmentStepReference } from './AssignmentStepReference'
import { AssignmentStepLegacy } from './AssignmentStepLegacy'
import type { WizardFormData } from '../ViewWizard'

export interface AssignmentStepProps {
    formData: WizardFormData
    updateFormData: (updates: Partial<WizardFormData>) => void
    linkedContextModelId?: string | null
    onDraftSaved?: (modelId: string) => void
}

export function AssignmentStep(props: AssignmentStepProps) {
    return props.formData.layoutType === 'reference'
        ? <AssignmentStepReference {...props} />
        : <AssignmentStepLegacy {...props} />
}
