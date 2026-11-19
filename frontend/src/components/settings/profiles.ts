/**
 * Applying a profile: which of its values a person may stage at the level they are editing, and why
 * each of the others is left out. Pure, so the picker and its tests read the same answer.
 *
 * A value is staged only where the resolver says this person may set it (`editable`, `editor`),
 * the platform hasn't locked it, and the platform allows it here (`allowed`, and its limits on the
 * trail for a workspace admin). A value that already applies here, chosen here or inherited, is
 * left alone, so applying a profile never stages a change that changes nothing. Nothing is saved:
 * the page stages what this returns, and the person reviews it.
 */
import { lockedFor, limitsFor, SCOPE_HERE, sameValue } from './format'
import type { Editor, Profile, ResolvedSetting, ResolvedValues, Scope, SettingValue } from './types'

export type SkipReason =
    /** The setting isn't set at this level. */
    | 'not_here'
    /** The value already applies here: chosen here, or inherited. */
    | 'already'
    /** A fork follows the graph it was forked from. */
    | 'follows_root'
    /** The platform locked it for every level below. */
    | 'locked'
    /** Only a system admin may set it here. */
    | 'system_admin_only'
    /** This person may not change it here. */
    | 'no_permission'
    /** Outside what the platform allows at this level. */
    | 'not_allowed'

export interface ProfilePlan {
    /** What to stage, one key at a time, in the profile's order. */
    stage: Array<{ key: string; value: SettingValue }>
    skipped: Array<{ key: string; reason: SkipReason }>
}

/** A value as a limit compares it: the words are as large as it goes. */
function asNumber(v: SettingValue): number | null {
    if (v === 'unlimited' || v === 'forever' || v === 'everyone') return Infinity
    return typeof v === 'number' ? v : null
}

function skipReason(value: SettingValue, scope: Scope, editor: Editor | null, r: ResolvedSetting | undefined): SkipReason | null {
    if (!r || r.editor === null) return 'not_here'
    if (sameValue(r.declared, value)) return 'already'
    if (r.why.some((w) => w.code === 'follows_root')) return 'follows_root'
    if (lockedFor(r, scope) || r.why.some((w) => w.code === 'locked_by_platform')) return 'locked'
    const mayHere = editor === 'system_admin' || (editor === 'workspace_admin' && r.editor === 'workspace_admin')
    if (!r.editable || !mayHere) return r.editor === 'system_admin' && editor !== 'system_admin' ? 'system_admin_only' : 'no_permission'
    // `allowed` is what this editor may choose here, as the server resolved it: the choices, or the
    // lowest and highest number.
    const n = asNumber(value)
    if (Array.isArray(r.allowed) && !r.allowed.some((a) => sameValue(a, value))) return 'not_allowed'
    if (r.allowed && !Array.isArray(r.allowed) && n !== null && (n < r.allowed.min || n > r.allowed.max)) {
        return 'not_allowed'
    }
    // A system admin's value outside the limits stays in force as an exception; a workspace
    // admin's would be refused. The platform's limits as stored: `{allowed, range, lock}`.
    const limits = editor === 'system_admin' ? null : limitsFor(r, scope)
    if (limits?.allowed && !limits.allowed.some((a) => sameValue(a, value))) return 'not_allowed'
    if (limits?.range && n !== null && (n < limits.range[0] || n > limits.range[1])) return 'not_allowed'
    return null
}

/**
 * What applying `profile` at `scope` would stage, for `editor` (the viewer's role; null: none),
 * against the values resolved there, and why each value it leaves out is left out.
 */
export function applyProfile(profile: Profile, scope: Scope, editor: Editor | null, resolved: ResolvedValues): ProfilePlan {
    const plan: ProfilePlan = { stage: [], skipped: [] }
    const here = profile.scopes.includes(scope)
    for (const [key, value] of Object.entries(profile.values)) {
        const reason = here ? skipReason(value, scope, editor, resolved[key]) : 'not_here'
        if (reason) plan.skipped.push({ key, reason })
        else plan.stage.push({ key, value })
    }
    return plan
}

/** Why a value was left out, in words: "Only a system admin can set it here". */
export function skipWords(reason: SkipReason, scope: Scope): string {
    switch (reason) {
        case 'not_here': return `Can’t be set for ${SCOPE_HERE[scope]}`
        case 'already': return `Already like this for ${SCOPE_HERE[scope]}`
        case 'follows_root': return 'This fork follows the graph it was forked from'
        case 'locked': return 'Locked by the platform'
        case 'system_admin_only': return 'Only a system admin can set it here'
        case 'no_permission': return 'You can’t change it here'
        case 'not_allowed': return 'Outside what the platform allows here'
    }
}
