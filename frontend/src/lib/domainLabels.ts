/**
 * Domain vocabulary — the one place a stored enum becomes words a person reads.
 *
 * WHY THIS EXISTS
 * `view_type` is stored as `reference`, and every surface in the product calls
 * that a **Context View**. The mapping was written out by hand in four separate
 * places — `ViewEditor`, `ViewWizard`, `CanvasRouter`, and the backend's
 * `allowedViewModes` options — which is fine right up until a fifth surface
 * appears and doesn't know. Analytics was that fifth surface: it rendered the
 * raw enum, so the dashboard called it "Reference" while the rest of the app
 * called it "Context View", and the same object had two names depending on
 * which page you were looking at.
 *
 * Renaming the stored value was the other option and is the wrong one: it is a
 * migration across `views.view_type`, saved view configs, the `allowedViewModes`
 * flag and every persisted layout, in exchange for nothing a user can see. The
 * database keeps its value; this module owns the word.
 *
 * `domainLabels.test.ts` asserts these stay in step with the backend's seeded
 * option labels, so the two halves cannot drift apart silently again.
 */

/**
 * View layout types, keyed by the value stored in `views.view_type`.
 *
 * `reference` → "Context View" is the one that matters: the key is historical
 * and the label is what the product has always called it.
 */
export const VIEW_TYPE_LABELS: Record<string, string> = {
    graph: 'Graph',
    hierarchy: 'Hierarchy',
    reference: 'Context View',
    'layered-lineage': 'Layered Lineage',
    tree: 'Tree',
    list: 'List',
    grid: 'Grid',
    timeline: 'Timeline',
}

/** Who a view is shared with, keyed by `views.visibility`. */
export const VISIBILITY_LABELS: Record<string, string> = {
    private: 'Private to author',
    workspace: 'Whole workspace',
    enterprise: 'Everyone',
}

/**
 * How an account came into existence, keyed by `users.signup_source`.
 * The stored values are implementation words (`sso_jit`); these are not.
 */
export const SIGNUP_SOURCE_LABELS: Record<string, string> = {
    local_signup: 'Signed up directly',
    sso_jit: 'Provisioned by SSO',
    invite: 'Invited',
    admin_created: 'Created by an admin',
    admin_linked: 'Linked by an admin',
}

/** Entries in `view_activity_log.action`, as a person would say them. */
export const VIEW_ACTION_LABELS: Record<string, string> = {
    created: 'Created a view',
    updated: 'Edited a view',
    visibility_changed: 'Changed who can see it',
    shared: 'Shared',
    unshared: 'Unshared',
    favourited: 'Favourited',
    unfavourited: 'Unfavourited',
    deleted: 'Deleted',
    restored: 'Restored',
    data_changed: 'Data refreshed',
    publish_requested: 'Asked to publish',
    publish_denied: 'Publish refused',
    admin_viewed: 'Opened by an admin',
}

/**
 * Title-case an unknown key so an enum we have not named yet still reads as
 * words rather than as `snake_case`. The fallback, never the plan.
 */
export function humaniseKey(key: string): string {
    const spaced = key.replace(/[_-]/g, ' ').trim()
    return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function lookup(map: Record<string, string>, key: string): string {
    return map[key] ?? humaniseKey(key)
}

export const viewTypeLabel = (key: string) => lookup(VIEW_TYPE_LABELS, key)
export const visibilityLabel = (key: string) => lookup(VISIBILITY_LABELS, key)
export const signupSourceLabel = (key: string) => lookup(SIGNUP_SOURCE_LABELS, key)
export const viewActionLabel = (key: string) => lookup(VIEW_ACTION_LABELS, key)
