/**
 * What the review says in words: a refused save, the server's warnings to acknowledge, and the
 * values new limits would leave outside them.
 */
import { formatCount } from '@/lib/units'
import { EDITOR_LABEL, type ReviewWarning, type Setting } from '@/components/settings'
import type { Impact, SettingsRequestError } from '@/services/settingsService'

const plural = (n: number, one: string, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`

/** A refused save, in words. */
export function refusalWords(e: SettingsRequestError, settings: Record<string, Setting>): string {
    const label = (key: string) => settings[key]?.label ?? key
    if (e.type === 'settings_conflict') {
        const names = [...new Set(e.conflicts.map((c) => label(c.key)))]
        return `Someone changed ${names.length ? names.join(', ') : 'these settings'} since you opened ${names.length === 1 ? 'it' : 'them'}. Nothing was saved. Reload to see the values now; your changes are kept.`
    }
    if (e.type === 'invalid_settings' && e.errors.length) {
        return `Nothing was saved. ${e.errors.map((p) => `${label(p.key)}: ${p.message}`).join(' ')}`
    }
    if (e.type === 'setting_not_permitted' && e.denied.length) {
        return `Nothing was saved. ${e.denied.map((d) => `You can’t change ${label(d.key)} here${d.editor ? `: only ${EDITOR_LABEL[d.editor]} can` : ''}.`).join(' ')}`
    }
    if (e.type === 'acknowledgement_required') {
        const n = e.warnings.length
        return `Nothing was saved: this change does ${n === 1 ? 'something' : `${formatCount(n)} things`} you need to acknowledge first. Read ${n === 1 ? 'its warning' : 'each warning'} in this review, tick it, and save again.`
    }
    return `Nothing was saved: ${e.message}`
}

/** The server's warnings, and the values new limits leave outside them. */
export function reviewWarnings(impact: Impact | null | undefined): ReviewWarning[] {
    if (!impact) return []
    const out: ReviewWarning[] = impact.warnings.map((w) => ({ id: `${w.code}:${w.key ?? ''}`, text: w.text }))
    const outside = outsideLimitsWarning(impact.outsideLimits)
    if (outside) out.push({ id: 'outside_limits', text: outside })
    return out
}

/**
 * The values left outside new limits, as a warning to acknowledge: they stay in force, marked as
 * exceptions. Split into workspaces and graphs when every one of them is listed.
 */
export function outsideLimitsWarning(outside: Impact['outsideLimits']): string | null {
    const exceptions = outside ? outside.count - outside.locked : 0
    if (!outside || exceptions <= 0) return null
    const listed = outside.samples.filter((v) => v.status === 'exception')
    const whole = listed.length === exceptions
    const count = (scope: string) => new Set(listed.filter((v) => v.scope === scope).map((v) => v.scopeId)).size
    const ws = count('workspace')
    const gs = count('graph')
    const who = whole
        ? [ws && plural(ws, 'workspace'), gs && plural(gs, 'graph')].filter(Boolean).join(' and ')
        : `${plural(exceptions, 'value')} chosen for workspaces and graphs`
    return `${who} ${whole && ws + gs === 1 ? 'is' : 'are'} outside these limits. They keep their values, marked as exceptions.`
}
