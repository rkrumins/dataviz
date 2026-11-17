/**
 * How a setting's value reads, and what its trail says about it.
 *
 * `formatValue` is the one place a value becomes words, by kind and in its unit ("30 days",
 * "Forever", "50%", "15 seconds", "Keep serving, update in place"), so the row, the trail, the
 * review and the history all say the same thing.
 */
import { identifierLabel } from '@/features/import-export/identifier'
import {
    formatBytes, formatBytesOrUnlimited, formatCount, formatCountOrUnlimited, formatDays, formatDaysOrForever,
    formatDuration, formatMs, formatPercent, formatRatio, formatRefusalBudget, type RatioStyle,
} from '@/lib/units'
import type { Limits, ResolvedSetting, Scope, Setting, SettingValue, TrailScope, TrailStep, WhyFix } from './types'

export const SCOPE_LABEL: Record<TrailScope, string> = {
    default: 'Default', platform: 'Platform', workspace: 'Workspace', graph: 'Graph',
}

/** "this graph", "this workspace", "the platform": where a change made here applies. */
export const SCOPE_HERE: Record<Scope, string> = {
    platform: 'the platform', workspace: 'this workspace', graph: 'this graph',
}

/** The order levels are consulted in, most general first. */
export const TRAIL_ORDER: TrailScope[] = ['default', 'platform', 'workspace', 'graph']

/** The anchor a setting's row carries, and its guide section: `reads.mode` → `reads-mode`. */
export function settingAnchor(key: string): string {
    return key.replaceAll('.', '-').toLowerCase()
}

/**
 * How a ratio reads: always in percent, a multiplier too ("pauses 25% of the write's time", "250%"),
 * as the server's own sentences say it. Kept per setting for the controls that ask.
 */
export function ratioStyle(_s: Setting): RatioStyle {
    return 'share'
}

export function choiceTitle(s: Setting, id: SettingValue): string {
    return s.choices.find((c) => c.id === id)?.title ?? String(id)
}

/** A value as people read it, with its unit. `null` reads as "Not set". */
export function formatValue(s: Setting, v: SettingValue | null | undefined): string {
    if (v === null || v === undefined) return 'Not set'
    const n = Number(v)
    switch (s.kind) {
        case 'bool': return v ? 'On' : 'Off'
        case 'choice': return choiceTitle(s, v)
        case 'count': return formatCount(n, s.unit ?? undefined)
        case 'ratio': return formatRatio(n, ratioStyle(s))
        case 'percent': return formatPercent(n)
        case 'ms': return formatMs(n)
        case 'seconds': return formatDuration(n)
        case 'bytes': return formatBytes(n)
        case 'days': return formatDays(n)
        case 'days_or_forever': return formatDaysOrForever(v === 'forever' ? 'forever' : n)
        case 'count_or_unlimited': return formatCountOrUnlimited(v === 'unlimited' ? 'unlimited' : n, s.unit ?? undefined)
        case 'bytes_or_unlimited': return formatBytesOrUnlimited(v === 'unlimited' ? 'unlimited' : n)
        case 'identifier': return identifierLabel(String(v))
        case 'refusal_budget': return formatRefusalBudget(String(v))
        default: return String(v)
    }
}

export function stepAt(r: ResolvedSetting, scope: TrailScope): TrailStep | undefined {
    return r.trail.find((t) => t.scope === scope)
}

/** The value chosen at `scope` itself (null: it inherits). */
export function ownValue(r: ResolvedSetting, scope: Scope): SettingValue | null {
    return stepAt(r, scope)?.value ?? null
}

/** What clearing `scope`'s own value would leave in force: the nearest level above it with a value. */
export function inheritedAt(r: ResolvedSetting, scope: Scope): { scope: TrailScope; value: SettingValue } {
    const above = TRAIL_ORDER.slice(0, TRAIL_ORDER.indexOf(scope)).reverse()
    for (const level of above) {
        const v = stepAt(r, level)?.value
        if (v !== null && v !== undefined) return { scope: level, value: v }
    }
    return { scope: 'default', value: r.trail[0]?.value ?? r.effective }
}

/** The platform's limits, when they bind a lower scope. */
export function limitsFor(r: ResolvedSetting, scope: Scope) {
    if (scope === 'platform') return null
    return stepAt(r, 'platform')?.limits ?? null
}

/** Whether the platform locked the value for lower scopes. */
export function lockedFor(r: ResolvedSetting, scope: Scope): boolean {
    return scope !== 'platform' && Boolean(stepAt(r, 'platform')?.locked)
}

/** The numeric bounds a value may take at `scope`: the setting's range, narrowed by the platform's limits. */
export function boundsAt(s: Setting, r: ResolvedSetting | undefined, scope: Scope): { min?: number; max?: number } {
    let min = s.range?.[0]
    let max = s.range?.[1]
    const range = r ? limitsFor(r, scope)?.range : null
    if (range) {
        min = min === undefined ? range[0] : Math.max(min, range[0])
        max = max === undefined ? range[1] : Math.min(max, range[1])
    }
    return { min, max }
}

/** The choices the viewer may pick at this scope (null: any, or not a choice). */
export function allowedChoices(r: ResolvedSetting | undefined): SettingValue[] | null {
    return Array.isArray(r?.allowed) ? r.allowed : null
}

/** Words for who may change a value: "a system admin". */
export const EDITOR_LABEL = { system_admin: 'a system admin', workspace_admin: 'a workspace admin' } as const

/** Two values are the same choice. */
export function sameValue(a: SettingValue | null | undefined, b: SettingValue | null | undefined): boolean {
    return a === b || (a != null && b != null && String(a) === String(b) && typeof a === typeof b)
}

/** Limits that bound anything: some allowed choices, or a range. */
export const hasLimits = (l?: Limits | null): l is Limits => Boolean(l && (l.allowed?.length || l.range))

/** Two sets of limits allow the same (the order of allowed choices doesn't matter). */
export function sameLimits(a: Limits | null | undefined, b: Limits | null | undefined): boolean {
    const norm = (l: Limits | null | undefined) => JSON.stringify([
        l?.allowed ? l.allowed.map(String).sort() : null, l?.range ?? null, Boolean(l?.lock),
    ])
    return norm(a) === norm(b)
}

/** What limits allow, in words: "Allowed: Standard, Coldline. From 1 day to 90 days". */
export function limitsWords(s: Setting, limits: Limits): string {
    const parts: string[] = []
    if (limits.allowed?.length) parts.push(`Allowed: ${limits.allowed.map((v) => formatValue(s, v)).join(', ')}`)
    if (limits.range) parts.push(`From ${formatValue(s, limits.range[0])} to ${formatValue(s, limits.range[1])}`)
    return parts.join('. ')
}

/** The switches' names as the app shows them, for a fix that turns one on. Pages pass the live names. */
export const FEATURE_NAMES: Record<string, string> = {
    candidateKeysEnabled: 'New-version builds',
    residencyEnabled: 'Graph residency',
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

/** A fix in words, for its button: "Turn on New-version builds", "Use “Keep serving, update in place”". */
export function describeFix(fix: WhyFix, { settings, featureNames = FEATURE_NAMES }: {
    settings?: Record<string, Setting>
    featureNames?: Record<string, string>
} = {}): string {
    if (fix.feature) {
        const name = featureNames[fix.feature] ?? lowerFirst(fix.feature.replace(/Enabled$/, '').replace(/([a-z])([A-Z])/g, '$1 $2'))
        return `${fix.to === false ? 'Turn off' : 'Turn on'} ${name}`
    }
    const s = fix.setting ? settings?.[fix.setting] : undefined
    if (!s) return `Set ${fix.setting ?? 'it'} to ${String(fix.to)}`
    if (s.kind === 'bool') return `${fix.to ? 'Turn on' : 'Turn off'} ${lowerFirst(s.label)}`
    if (s.kind === 'choice') return `Use “${choiceTitle(s, fix.to)}”`
    return `Set ${lowerFirst(s.label)} to ${formatValue(s, fix.to)}`
}
