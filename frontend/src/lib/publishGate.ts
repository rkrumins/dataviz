/**
 * May this person publish a view to everyone signed in — here, over
 * this source?
 *
 * Publishing used to be a single permission check, because publishing
 * was admin-only. That made the tier unreachable for almost everyone:
 * a workspace member could build a lineage view and then had nobody
 * to hand it to. Since what these views expose is metadata — names,
 * types, and the lineage between them — the default posture is now
 * open, and the answer is a small policy decision instead of one bit:
 *
 *   1. Holding `workspace:view:publish` publishes directly, always.
 *   2. Otherwise an OPEN workspace publishes directly, unless the
 *      underlying source is marked restricted — publishing exposes
 *      read-only access to that whole source, so the sources that
 *      deserve a human in the loop carry the flag themselves.
 *   3. Otherwise the person asks, and a publisher answers.
 *
 * The backend decides this for real (`can_publish_under_policy`); this
 * exists so the UI says the same thing BEFORE the click. Divergence
 * here is not a cosmetic bug — it is the difference between "Publish"
 * and "Request publication" on the button the user is looking at.
 */
export type WorkspacePublishPolicy = 'open' | 'request'

export interface PublishGateInputs {
    /** Holds `workspace:view:publish` in the target workspace. */
    hasPublishPermission: boolean
    /** The workspace's policy. Undefined while the workspace list is
     *  still loading — treated as the platform default, not as a lock. */
    publishPolicy?: WorkspacePublishPolicy | string | null
    /** The view's data source is marked restricted. */
    sourceRestricted?: boolean
}

export interface PublishGate {
    /** Choosing Enterprise publishes the view now. */
    canPublish: boolean
    /** Choosing Enterprise files a request for someone else to answer. */
    canRequestPublish: boolean
    /** The block came from the SOURCE, not the workspace — the reason
     *  shown to the user has to say so, or an open-workspace member
     *  reads the request badge as a bug. */
    restrictedSource: boolean
}

export function resolvePublishGate(inputs: PublishGateInputs): PublishGate {
    const restricted = Boolean(inputs.sourceRestricted)

    if (inputs.hasPublishPermission) {
        return { canPublish: true, canRequestPublish: false, restrictedSource: restricted }
    }

    // An unset policy is a workspace that hasn't loaded yet, not a
    // closed one — mirror the backend's default rather than showing a
    // request badge that the next render contradicts.
    const policy = inputs.publishPolicy ?? 'open'
    const canPublish = policy === 'open' && !restricted

    return { canPublish, canRequestPublish: !canPublish, restrictedSource: restricted }
}
