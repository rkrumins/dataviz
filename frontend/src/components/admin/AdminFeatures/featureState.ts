/**
 * What state is a feature actually in? One answer, used by every part of this page.
 *
 * Four states, and the fourth is the one that used to be invisible:
 *
 *   on       working, available to everyone
 *   off      the admin turned it off — users cannot do this
 *   inert    it says ON, but a dependency is OFF, so it does nothing. A switch that reports a
 *            state it is not in is the exact failure this page was rebuilt to stop, and it is not
 *            hypothetical: "Import layers" is ON by default and does nothing at all while
 *            "Edit semantic layers" is off, because importing IS editing.
 *   partial  a list flag with some options withdrawn (view modes) — neither on nor off
 */
import type { FeatureDefinition } from '@/services/featuresService'

export type FeatureState = 'on' | 'off' | 'inert' | 'partial'

/** The stored value, or the shipped default when an admin has never saved. */
export function valueOf(feature: FeatureDefinition, values: Record<string, unknown>): unknown {
    return values[feature.key] ?? feature.default
}

export function isOn(feature: FeatureDefinition, values: Record<string, unknown>): boolean {
    const value = valueOf(feature, values)
    if (feature.type === 'string[]') return Array.isArray(value) && value.length > 0
    return Boolean(value)
}

/** Dependencies of `feature` that are currently OFF — the reason it may be doing nothing. */
export function blockedBy(
    feature: FeatureDefinition,
    all: FeatureDefinition[],
    values: Record<string, unknown>,
): FeatureDefinition[] {
    return (feature.dependsOn ?? [])
        .map(key => all.find(f => f.key === key))
        .filter((dep): dep is FeatureDefinition => Boolean(dep) && !isOn(dep!, values))
}

export function stateOf(
    feature: FeatureDefinition,
    all: FeatureDefinition[],
    values: Record<string, unknown>,
): FeatureState {
    if (!isOn(feature, values)) return 'off'
    if (blockedBy(feature, all, values).length > 0) return 'inert'
    if (feature.type === 'string[]') {
        const selected = valueOf(feature, values) as string[]
        const total = feature.options?.length ?? selected.length
        if (selected.length < total) return 'partial'
    }
    return 'on'
}

/** For a list flag: "3 of 4 layouts". For a switch: null. */
export function selectionLabel(
    feature: FeatureDefinition,
    values: Record<string, unknown>,
): string | null {
    if (feature.type !== 'string[]') return null
    const selected = valueOf(feature, values)
    if (!Array.isArray(selected)) return null
    const total = feature.options?.length ?? selected.length
    return `${selected.length} of ${total}`
}
