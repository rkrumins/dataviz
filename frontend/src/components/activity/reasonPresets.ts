/**
 * Quick reasons, per kind of change.
 *
 * A reason is never required, so the cost of giving one has to be close to
 * nothing: one click on the phrase that fits. Each kind of change gets the
 * handful of reasons people actually have for it, worded as they would say
 * it, so the log reads as sentences rather than codes.
 */
export type ReasonContext =
    | 'aggregation'
    | 'purge'
    | 'cancel'
    | 'delete-run'
    | 'skip'
    | 'refresh'
    | 'reconcile'
    | 'hold'
    | 'member-add'
    | 'member-remove'
    | 'versioning'
    | 'duplicates'
    | 'cache'

export const REASON_PRESETS: Record<ReasonContext, readonly string[]> = {
    aggregation: [
        'Source data changed upstream',
        'Previous run failed',
        'Ontology or containment changed',
        'Verifying a fix',
        'Requested by the data owner',
    ],
    purge: [
        'Stored rollups look wrong',
        'Ontology changed',
        'Source is being retired',
    ],
    cancel: [
        'Started by mistake',
        'Wrong settings',
        'Load on the graph store',
        'Superseded by another run',
    ],
    'delete-run': ['Test run', 'Duplicate record', 'Clean-up'],
    skip: ['Not needed for this source', 'Lineage not used here', 'Rebuilding later'],
    refresh: [
        'Source data changed upstream',
        'Stuck after a failed rebuild',
        'Verifying a fix',
        'Requested by the data owner',
    ],
    reconcile: ['Checking after an incident', 'Verifying a policy change', 'Routine check'],
    hold: ['Maintenance window', 'Incident in progress', 'Too much load', 'Maintenance finished'],
    'member-add': [
        'Joined the team',
        'Needs access for a project',
        'Covering for a colleague',
        'Approved access request',
    ],
    'member-remove': ['Left the team', 'Project ended', 'Access no longer needed', 'Offboarding'],
    versioning: [
        'Team wants drafts and reviews',
        'Need a full change history',
        'Source changed during the copy',
        'Turned on by mistake',
    ],
    duplicates: ['Source loaded twice', 'Known duplicates upstream', 'Left over from a migration'],
    cache: [
        'Graph changed outside the app',
        'Restored from a backup',
        'Views show stale data',
    ],
}

/** Who can read a reason once it is saved — said under the field, because a
 *  reason is free text and the person typing it should know its readers. */
export type ReasonAudience = 'platform' | 'workspace'

export const REASON_READERS: Record<ReasonAudience, string> = {
    platform: 'Saved with your name in the activity log, which auditors can read.',
    workspace: 'Saved with your name in the activity log, which auditors and this workspace’s admins can read.',
}
