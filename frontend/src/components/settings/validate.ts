/**
 * What is wrong with a staged value, in words that say how to fix it — the same checks the server
 * makes on save (range, the platform's limits, allowed choices, cross-field rules), so a change
 * that would be refused is caught where it is made.
 */
import { formatValue, sameValue } from './format'
import type { Setting, SettingValue, Values } from './types'

const WHOLE: ReadonlySet<Setting['kind']> = new Set(['count', 'seconds', 'bytes', 'days', 'ms', 'days_or_forever', 'count_or_unlimited', 'bytes_or_unlimited', 'count_or_everyone'])

export interface ValidationContext {
    /** Values with the staged changes applied: what the rules are checked against. */
    values: Values
    /** The value's bounds at this scope (range ∩ the platform's limits). */
    bounds?: { min?: number; max?: number }
    /** For a choice: what may be chosen here (a number's bounds are `bounds`). */
    allowed?: SettingValue[] | { min: number; max: number } | null
    /** Labels for the other settings rules name. */
    settings?: Record<string, Setting>
}

export function validateValue(s: Setting, v: SettingValue | null, ctx: ValidationContext): string | null {
    if (v === null) return null
    if (s.kind === 'choice') {
        const allowed = Array.isArray(ctx.allowed) ? ctx.allowed : null
        if (allowed && !allowed.some((a) => sameValue(a, v))) {
            return `Not allowed here. Choose ${allowed.map((a) => formatValue(s, a)).join(' or ')}.`
        }
        return null
    }
    if (s.kind === 'identifier') {
        const text = String(v)
        if (!text.startsWith('prop.')) return null
        const name = text.slice('prop.'.length).replace(/,urn$/, '')
        if (!name.trim()) return 'Name the property.'
        if (/[\s,]/.test(name)) return 'A property name has no spaces or commas.'
        return null
    }
    if (s.kind === 'refusal_budget') {
        return /^(unlimited|\d+|\d+(\.\d+)?%)$/.test(String(v)) ? null : 'Enter none, a number of rows, a share like 0.5%, or unlimited.'
    }
    if (s.kind === 'bool') return null
    if (v === 'unlimited' || v === 'forever' || v === 'everyone') return null

    const n = Number(v)
    if (typeof v !== 'number' || !Number.isFinite(n)) return 'Enter a number.'
    if (WHOLE.has(s.kind) && !Number.isInteger(n)) return 'Enter a whole number.'
    const { min, max } = ctx.bounds ?? {}
    const say = (x: number) => formatValue(s, x)
    if (min !== undefined && max !== undefined && (n < min || n > max)) return `Enter ${say(min)} to ${say(max)}.`
    if (min !== undefined && n < min) return `Enter at least ${say(min)}.`
    if (max !== undefined && n > max) return `Enter ${say(max)} or less.`

    for (const rule of s.rules) {
        const other = ctx.values[rule.other]
        if (typeof other !== 'number') continue
        const ok = rule.op === '<=' ? n <= other - rule.margin : n >= other + rule.margin
        if (!ok) {
            if (rule.message) return rule.message
            const label = ctx.settings?.[rule.other]?.label ?? rule.other
            return `Must be ${rule.op === '<=' ? 'at most' : 'at least'} ${label}${rule.margin ? ` ${rule.op === '<=' ? '−' : '+'} ${rule.margin}` : ''}.`
        }
    }
    return null
}

/**
 * Errors for every staged value, and for any setting whose rule names a staged one (lowering the
 * start mark can make the stop mark wrong).
 */
export function validateStaged(
    settings: Record<string, Setting>,
    staged: Record<string, SettingValue | null>,
    ctxFor: (key: string) => Omit<ValidationContext, 'settings'>,
): Record<string, string> {
    const stagedKeys = new Set(Object.keys(staged))
    const out: Record<string, string> = {}
    for (const s of Object.values(settings)) {
        const touched = stagedKeys.has(s.key) || s.rules.some((r) => stagedKeys.has(r.other))
        if (!touched) continue
        const ctx = ctxFor(s.key)
        const v = stagedKeys.has(s.key) ? staged[s.key] : ctx.values[s.key] ?? null
        const err = validateValue(s, v, { ...ctx, settings })
        if (err) out[s.key] = err
    }
    return out
}
