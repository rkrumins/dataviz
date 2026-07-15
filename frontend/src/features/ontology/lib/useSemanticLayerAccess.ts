/**
 * What this user may do to a semantic layer, in this deployment.
 *
 * Two independent things decide it, and conflating them is how you get a UI that lies:
 *
 *   PERMISSION — may THIS PERSON manage layers?     (`workspace:ontology:manage`, RBAC)
 *   FEATURE    — is that available in THIS DEPLOYMENT? (Admin → Features)
 *
 * The page already had the first. It had none of the second: the six semantic-layer toggles on
 * the admin page were enforced nowhere, so an admin could turn Import off and watch people go on
 * importing. The server now refuses those calls (`api/v1/endpoints/ontologies.py`), and this hook
 * is the other half — so nobody is offered a button that is going to 403.
 *
 * It deliberately mirrors the server's gate stack one-for-one. If the two ever disagree, the user
 * sees a control that fails, which is worse than not seeing it: they conclude the product is
 * broken rather than that a setting is off.
 *
 *   server                                    here
 *   ─────────────────────────────────────────────────────────────────────
 *   _GATE_EDIT     (semanticLayerEditMode)  → canEdit
 *   _GATE_WRITER   (…NonAdminEditing)       → canEdit  (and only for non-admins)
 *   _GATE_IMPORT   (…ImportEnabled)         → canImport   (import is also editing)
 *   _GATE_EXPORT   (…ExportEnabled)         → canExport
 *   _GATE_SUGGEST  (…AutoSuggest)           → canSuggest
 *   _GATE_HISTORY  (…VersionHistory)        → canSeeHistory
 */
import { useFeature } from '@/store/features'
import { usePermission, useAnyWorkspacePermission } from '@/store/auth'

export interface SemanticLayerAccess {
    /** Create, rename, restructure, delete, new-version. The lever behind every write control. */
    canEdit: boolean
    /** Import is editing that arrives as a file — so it needs BOTH flags, exactly like the server. */
    canImport: boolean
    canExport: boolean
    /** Score layers against a graph ("Suggest from Graph"). */
    canSuggest: boolean
    /** The History tab. Hidden, never deleted — every version is still retained. */
    canSeeHistory: boolean
    /** Publish and clone survive a frozen model, so they answer to permission alone. */
    canPublish: boolean
    /** Why editing is unavailable, when it is — so the UI can say so instead of just going quiet. */
    editingBlockedBy: 'permission' | 'feature-off' | 'admins-only' | null
}

export function useSemanticLayerAccess(): SemanticLayerAccess {
    // Rules of Hooks: call every probe unconditionally, then combine the booleans.
    const isPlatformAdmin = usePermission('system:admin')
    const hasOntologyManage = useAnyWorkspacePermission('workspace:ontology:manage')
    const canManage = isPlatformAdmin || hasOntologyManage

    const editModeOn = useFeature('semanticLayerEditMode')
    const nonAdminEditingOn = useFeature('semanticLayerNonAdminEditing')
    const importOn = useFeature('semanticLayerImportEnabled')
    const exportOn = useFeature('semanticLayerExportEnabled')
    const suggestOn = useFeature('semanticLayerAutoSuggest')
    const historyOn = useFeature('semanticLayerVersionHistory')

    // "May a non-admin write?" — the flag only ever restricts people who are NOT platform admins.
    // Asking it of an admin would lock them out of their own product.
    const allowedToWrite = isPlatformAdmin || nonAdminEditingOn

    const canEdit = canManage && editModeOn && allowedToWrite

    const editingBlockedBy = canEdit
        ? null
        : !canManage
            ? 'permission'
            : !editModeOn
                ? 'feature-off'
                : 'admins-only'

    return {
        canEdit,
        canImport: canEdit && importOn,
        canExport: exportOn,
        // Server-side /suggest requires ontology:manage (ontologies.py) on top of
        // the feature flag — mirror it or readers see a button that 403s.
        canSuggest: canManage && suggestOn,
        canSeeHistory: historyOn,
        canPublish: canManage && allowedToWrite,
        editingBlockedBy,
    }
}
