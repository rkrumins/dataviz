/**
 * May this person publish a view to everyone signed in — here, over
 * this source?
 *
 * Publishing used to be a single permission check, because publishing
 * was admin-only. That made the tier unreachable for almost everyone:
 * a workspace member could build a lineage view and then had nobody
 * to hand it to. Since what these views expose is metadata — names,
 * types, and the lineage between them — the default posture is now
 * open, and the answer is a small ladder instead of one bit:
 *
 *   1. The PLATFORM ceiling binds everyone. `off` withdraws the tier
 *      outright; `request` forces a review even where a workspace has
 *      opened publishing to its members. It is the one control a
 *      workspace admin cannot opt out of, so it is checked first and
 *      the publish permission does not satisfy it.
 *   2. Holding `workspace:view:publish` publishes directly.
 *   3. Otherwise an OPEN workspace publishes directly, unless the
 *      underlying source is marked restricted — publishing exposes
 *      read-only access to that whole source, so the sources that
 *      deserve a human in the loop carry the flag themselves.
 *   4. Otherwise the person asks, and a publisher answers.
 *
 * The backend decides this for real (`can_publish_under_policy`); this
 * exists so the UI says the same thing BEFORE the click. Divergence
 * here is not a cosmetic bug — it is the difference between "Publish"
 * and "Request publication" on the button the user is looking at.
 */
export type WorkspacePublishPolicy = 'open' | 'request'

/** The deployment-wide ceiling (Admin → Features → "Publishing views to
 *  everyone"). `workspaces` = each workspace decides; `request` = every
 *  publish is reviewed, whatever a workspace has set; `off` = the tier
 *  is withdrawn. */
export type PlatformPublishPolicy = 'workspaces' | 'request' | 'off'

/** Which control is holding publication back, for the sentence shown to
 *  the user. */
export type PublishBlockedBy = 'platform' | 'workspace' | 'source' | null

export interface PublishGateInputs {
    /** Holds `workspace:view:publish` in the target workspace. */
    hasPublishPermission: boolean
    /** The workspace's policy. Undefined while the workspace list is
     *  still loading — treated as the platform default, not as a lock. */
    publishPolicy?: WorkspacePublishPolicy | string | null
    /** The view's data source is marked restricted. */
    sourceRestricted?: boolean
    /** The deployment's ceiling. Binds everyone INCLUDING publish-permission
     *  holders — a limit only non-admins obey is not a limit. */
    platformPolicy?: PlatformPublishPolicy | string | null
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
    /** WHICH control is holding publication back. `null` when nothing is. */
    blockedBy: PublishBlockedBy
    /** The tier exists on this deployment at all. False HIDES the option
     *  rather than disabling it — a choice nobody here can ever make is
     *  noise, and a permanently grey tile invites people to keep asking
     *  why it is grey. */
    enterpriseAvailable: boolean
}

export function resolvePublishGate(inputs: PublishGateInputs): PublishGate {
    const restricted = Boolean(inputs.sourceRestricted)
    // An unset value means "not loaded yet", not "locked down" — mirror
    // the platform default rather than flashing a restriction the next
    // render contradicts.
    const platform = inputs.platformPolicy ?? 'workspaces'

    if (platform === 'off') {
        // Nothing to route around: nobody on this deployment could
        // approve it, so offering the ask would be a dead end.
        return {
            canPublish: false, canRequestPublish: false,
            restrictedSource: restricted, blockedBy: 'platform',
            enterpriseAvailable: false,
        }
    }

    if (inputs.hasPublishPermission) {
        return {
            canPublish: true, canRequestPublish: false,
            restrictedSource: restricted, blockedBy: null,
            enterpriseAvailable: true,
        }
    }

    const policy = inputs.publishPolicy ?? 'open'
    const blockedBy: PublishBlockedBy =
        platform === 'request' ? 'platform'
        : restricted ? 'source'
        : policy !== 'open' ? 'workspace'
        : null

    return {
        canPublish: blockedBy === null,
        canRequestPublish: blockedBy !== null,
        restrictedSource: restricted,
        blockedBy,
        enterpriseAvailable: true,
    }
}
