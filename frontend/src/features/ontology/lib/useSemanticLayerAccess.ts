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
 *   _GATE_CREATE + workspace:ontology:create → canCreate, canImportNew, canClone (a NEW layer)
 *
 * Given a layer, the server's own answer for it (`ontology.access`) wins for what may be done to
 * that layer: an org layer by the rules above, and only where its holder looks after it — a
 * workspace that uses or owns it, or the one who made it while nothing uses it; a Playground
 * maker's own layer by being its maker, whatever the switches say. Export, history and suggest
 * stay with the switches, except that an owned layer can always be exported and its history read.
 *
 * Every "no" carries a reason (`…BlockedBy`, worded by `BLOCKED_REASON`), so a control the person
 * could otherwise reach is shown switched off with why, not silently taken away.
 */
import { useFeature } from '@/store/features'
import { usePermission, useAnyWorkspacePermission } from '@/store/auth'
import type { LayerAccess, OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'

/** Why something that makes a NEW layer is unavailable. `permission`: they manage no layers at all
 *  (a reader, who is not offered it); `create-permission`: they look after layers but may not start
 *  one. */
export type NewLayerBlockedBy = 'permission' | 'create-permission' | 'creation-off' | 'feature-off' | 'admins-only'

/** Why editing a layer is unavailable. `not-yours`: they manage layers, but not this one. */
export type EditingBlockedBy = 'permission' | 'feature-off' | 'admins-only' | 'not-yours'

/** What a person reads when a control is off — naming the switch or permission that decides it, so
 *  it is something an administrator can act on. */
export const BLOCKED_REASON: Record<NewLayerBlockedBy | EditingBlockedBy, string> = {
    permission: 'Your role lets you read semantic layers, not change them.',
    'create-permission': 'Your role looks after semantic layers but can’t start new ones. An administrator can give it workspace:ontology:create.',
    'creation-off': 'Creating semantic layers is turned off for this deployment. An administrator can turn on “Create semantic layers” under Admin → Features.',
    'feature-off': 'Semantic layers are read-only for this deployment. An administrator can turn on “Edit semantic layers” under Admin → Features.',
    'admins-only': 'Only administrators can change semantic layers in this deployment.',
    'not-yours': 'Only people who manage semantic layers in a workspace that uses this layer can change it — or, while nothing uses it, whoever made it.',
}

export interface SemanticLayerAccess extends LayerAccess {
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
    /** Start a new layer: a blank draft, or one built from a graph. */
    canCreate: boolean
    /** Import a file as a NEW layer: creating, and the import switch. */
    canImportNew: boolean
    /** Why editing is unavailable, when it is — so the UI can say so instead of just going quiet. */
    editingBlockedBy: EditingBlockedBy | null
    /** Why starting a new layer is unavailable. */
    createBlockedBy: NewLayerBlockedBy | null
    /** Why cloning is: the same rules, but a clone survives a frozen model (as on the server). */
    cloneBlockedBy: NewLayerBlockedBy | null
}

export function useSemanticLayerAccess(
    ontology?: Pick<OntologyDefinitionResponse, 'access'> | null,
): SemanticLayerAccess {
    // Rules of Hooks: call every probe unconditionally, then combine the booleans.
    const isPlatformAdmin = usePermission('system:admin')
    const hasOntologyManage = useAnyWorkspacePermission('workspace:ontology:manage')
    const canManage = isPlatformAdmin || hasOntologyManage
    const hasOntologyCreate = useAnyWorkspacePermission('workspace:ontology:create')

    const creationOn = useFeature('semanticLayerCreation')
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

    // A new layer answers to the creating rules on top of the write it arrives as: a blank draft or
    // an import is a content write (the edit switch applies), a clone a lifecycle one (it doesn't).
    // The server's order: the switches, then who may write, then the permission.
    const newLayerBlockedBy = (contentWrite: boolean): NewLayerBlockedBy | null => {
        if (!canManage) return 'permission'
        if (!creationOn) return 'creation-off'
        if (contentWrite && !editModeOn) return 'feature-off'
        if (!allowedToWrite) return 'admins-only'
        if (!isPlatformAdmin && !hasOntologyCreate) return 'create-permission'
        return null
    }
    const createBlockedBy = newLayerBlockedBy(true)
    const cloneBlockedBy = newLayerBlockedBy(false)

    const byOrgRules: SemanticLayerAccess = {
        canEdit,
        canImport: canEdit && importOn,
        canExport: exportOn,
        // Server-side /suggest requires ontology:manage (ontologies.py) on top of
        // the feature flag — mirror it or readers see a button that 403s.
        canSuggest: canManage && suggestOn,
        canSeeHistory: historyOn,
        canPublish: canManage && allowedToWrite,
        canDelete: canEdit,
        canClone: cloneBlockedBy === null,
        canShare: false,
        canAssign: canManage,
        isOwn: false,
        canCreate: createBlockedBy === null,
        canImportNew: createBlockedBy === null && importOn,
        editingBlockedBy,
        createBlockedBy,
        cloneBlockedBy,
    }

    const layer = ontology?.access
    if (!layer) return byOrgRules
    return {
        ...byOrgRules,
        ...layer,
        // Importing into a layer is editing it; an org layer's import still needs its switch.
        canImport: layer.canEdit && (layer.isOwn || importOn),
        canExport: layer.isOwn || exportOn,
        canSeeHistory: layer.isOwn || historyOn,
        // A maker's own layer is imported into a new one of their own, through the Playground.
        canImportNew: layer.isOwn || byOrgRules.canImportNew,
        // The org switches never block a maker's own layer. Where they would allow it and the
        // layer still says no, it is someone else's to change.
        editingBlockedBy: layer.canEdit ? null : layer.isOwn ? 'permission' : byOrgRules.editingBlockedBy ?? 'not-yours',
        cloneBlockedBy: layer.canClone ? null : byOrgRules.cloneBlockedBy ?? 'permission',
    }
}
