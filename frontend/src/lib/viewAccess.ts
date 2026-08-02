/**
 * Caller capabilities on a view.
 *
 * The backend's single-view read returns an `access` envelope computed
 * by the same evaluator that enforces every request — when it's
 * present, the UI must not re-derive rules from permission claims (the
 * two drift). The legacy branch exists only so the app keeps working
 * against a backend that predates the envelope.
 */
import type { ViewAccess } from '@/services/viewApiService'

export interface LegacyCapabilityInputs {
    /** The signed-in user created this view. */
    isCreator: boolean
    /** Holds `workspace:view:edit` in the view's workspace. */
    canEditPerm: boolean
    /** Holds `workspace:admin` in the view's workspace. */
    canAdminPerm: boolean
    /** Holds `workspace:view:publish` in the view's workspace. */
    canPublishPerm: boolean
}

export interface ViewCapabilities {
    canEdit: boolean
    canManageGrants: boolean
    canChangeVisibility: boolean
    canPublish: boolean
    /** The data plane is read-only for this caller — hide every edit
     *  affordance (draft mode, layout saves, versioning chrome). */
    readOnlyData: boolean
}

export function deriveViewCapabilities(
    access: ViewAccess | null | undefined,
    legacy: LegacyCapabilityInputs,
): ViewCapabilities {
    if (access) {
        return {
            canEdit: access.canEdit,
            canManageGrants: access.canManageGrants,
            canChangeVisibility: access.canChangeVisibility,
            canPublish: access.canPublish,
            readOnlyData: access.dataAccess === 'readonly',
        }
    }
    return {
        canEdit: legacy.canEditPerm || legacy.isCreator,
        canManageGrants: legacy.canAdminPerm || legacy.isCreator,
        canChangeVisibility: legacy.canAdminPerm || legacy.isCreator,
        canPublish: legacy.canPublishPerm,
        readOnlyData: false,
    }
}
