/**
 * The platform's limits on what workspaces and graphs may choose: which there are for a setting,
 * what is in force, and what is wrong with a staged set.
 *
 *   allowed   the choices lower levels may pick (a choice setting); at least one
 *   range     the lowest and highest value they may set, within the setting's own range
 *   lock      the same value for everyone: lower levels' values are kept but ignored
 */
import { formatValue, hasLimits, stepAt, type Limits, type ResolvedSetting, type Setting } from '@/components/settings'

/** The setting's limits when none are saved: the registry's defaults. */
export const defaultLimitsOf = (s: Setting): Limits => s.defaultLimits ?? {}

/** What the editor shows: the staged limits (null: back to the defaults), else those in force. */
export function limitsShown(s: Setting, r: ResolvedSetting, staged: Limits | null | undefined): Limits {
    if (staged !== undefined) return staged ?? defaultLimitsOf(s)
    return stepAt(r, 'platform')?.limits ?? defaultLimitsOf(s)
}

/** Whether a numeric setting's limits can bound a range here. */
export const rangeable = (s: Setting) => s.limitable.includes('range') && s.range !== null

export function validateLimits(s: Setting, l: Limits): string | null {
    if (s.limitable.includes('allowed') && l.allowed && l.allowed.length === 0) return 'Allow at least one choice.'
    if (l.range) {
        const [min, max] = l.range
        if (min > max) return 'The lowest value must not be above the highest.'
        if (s.range && (min < s.range[0] || max > s.range[1])) {
            return `Keep within ${formatValue(s, s.range[0])} to ${formatValue(s, s.range[1])}.`
        }
    }
    return null
}

/** Whether the platform's limits bind this setting below it. */
export function limitsNoteShown(s: Setting, r: ResolvedSetting): boolean {
    const platform = stepAt(r, 'platform')
    return s.limitable.length > 0 && (hasLimits(platform?.limits) || Boolean(platform?.locked))
}
