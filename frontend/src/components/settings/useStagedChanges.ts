/**
 * Staged changes: what someone has changed on a settings page and not yet saved.
 *
 * One save model everywhere: an edit STAGES a value (nothing is sent), Review shows the diff, and
 * Save sends one PATCH with every staged value and, for each, the `expectedVersion` the person
 * was looking at when they decided, so a value someone else changed meanwhile is refused (409)
 * rather than silently overwritten. After a save the batch can be undone.
 *
 * A staged value is what to choose AT THIS SCOPE; `null` means "choose nothing here, inherit".
 * Staging the value the scope already has drops the change, so changing something and changing
 * it back leaves the page clean.
 *
 * On the platform, a setting's LIMITS (what workspaces and graphs may choose) stage beside its
 * value, the same way; `null` goes back to the setting's default limits. A key with both staged is
 * one item of the PATCH, carrying `value` and `limits`; a field left out stays as it is.
 */
import { useMemo, useState } from 'react'
import { inheritedAt, ownValue, sameLimits, sameValue, stepAt } from './format'
import type { Limits, ResolvedValues, Scope, SettingValue, Values } from './types'

export interface StagedChange {
    key: string
    /** The value chosen at this scope now; null: it inherits. */
    ownBefore: SettingValue | null
    /** The value to choose at this scope; null: inherit. */
    ownAfter: SettingValue | null
    /** In force now. */
    before: SettingValue
    /** In force once saved, as far as the page can tell; the server's preview has the last word. */
    after: SettingValue
    expectedVersion: number
}

/** A change to what lower levels may choose (the platform only). */
export interface StagedLimitChange {
    key: string
    /** The limits saved now; null: the setting's defaults. */
    ownBefore: Limits | null
    /** The limits to save; null: back to the setting's defaults. */
    ownAfter: Limits | null
    /** In force now: the saved ones, or the defaults. */
    before: Limits | null
    expectedVersion: number
}

/** One item of the PATCH body: a field left out stays as it is. */
export interface PatchItem {
    key: string
    value?: SettingValue | null
    limits?: Limits | null
    expectedVersion: number
}

interface Entry {
    value: SettingValue | null
    version: number
}

interface LimitEntry {
    limits: Limits | null
    version: number
}

export interface StagedChanges {
    stage: (key: string, value: SettingValue | null) => void
    unstage: (key: string) => void
    /** Drops every staged change. */
    reset: () => void
    isStaged: (key: string) => boolean
    /** The value a control shows: the staged one, else the scope's own (null: inherits). */
    valueAt: (key: string) => SettingValue | null
    changes: StagedChange[]
    /** Stage the limits lower levels may choose within (the platform only); null: the defaults. */
    stageLimits: (key: string, limits: Limits | null) => void
    unstageLimits: (key: string) => void
    /** The limits staged for a key; undefined when none are. */
    stagedLimits: (key: string) => Limits | null | undefined
    limitChanges: StagedLimitChange[]
    /** Values and limits staged, each counted once: what the review lists. */
    dirtyCount: number
    expectedVersion: (key: string) => number | undefined
    payload: () => PatchItem[]
    /** The values in force now, and with the staged changes applied (the compass's ghost). */
    current: Values
    next: Values
    /** Call once the PATCH landed: clears the staging and keeps the batch for undo. */
    markSaved: () => void
    lastSaved: StagedChange[] | null
    lastSavedLimits: StagedLimitChange[] | null
    /** The PATCH that puts back what the last save changed, at the versions in force now. */
    undoPayload: () => PatchItem[]
    clearUndo: () => void
    /** After a conflict: keep the staged values, take the server's current versions (those of
     *  `fresh`, the values just read again, when given). */
    rebase: (fresh?: ResolvedValues) => void
}

/** The changes `entries` make to `values` at `scope`, in the order they were staged. */
export function diffStaged(entries: Record<string, Entry>, values: ResolvedValues, scope: Scope): StagedChange[] {
    return Object.entries(entries).flatMap(([key, e]) => {
        const r = values[key]
        if (!r) return []
        return [{
            key,
            ownBefore: ownValue(r, scope),
            ownAfter: e.value,
            before: r.effective,
            after: e.value === null ? inheritedAt(r, scope).value : e.value,
            expectedVersion: e.version,
        }]
    })
}

/** The limits a setting's lower levels are held to now: the saved ones, or the defaults. */
const limitsInForce = (values: ResolvedValues, key: string): Limits | null =>
    (values[key] ? stepAt(values[key], 'platform')?.limits ?? null : null)

/** Whether staging `limits` would change nothing: the saved ones again, or the defaults while they apply. */
const sameAsSaved = (values: ResolvedValues, key: string, limits: Limits | null): boolean =>
    limits === null ? (values[key]?.limits ?? null) === null : sameLimits(limits, limitsInForce(values, key))

/** Value and limit items gathered into one PATCH item per key. */
function merge(values: PatchItem[], limits: PatchItem[]): PatchItem[] {
    const out = new Map(values.map((p) => [p.key, p]))
    for (const l of limits) {
        const v = out.get(l.key)
        out.set(l.key, v ? { ...v, limits: l.limits } : l)
    }
    return [...out.values()]
}

export function useStagedChanges(values: ResolvedValues, scope: Scope): StagedChanges {
    const [entries, setEntries] = useState<Record<string, Entry>>({})
    const [limitEntries, setLimitEntries] = useState<Record<string, LimitEntry>>({})
    const [lastSaved, setLastSaved] = useState<StagedChange[] | null>(null)
    const [lastSavedLimits, setLastSavedLimits] = useState<StagedLimitChange[] | null>(null)

    const changes = useMemo(() => diffStaged(entries, values, scope), [entries, values, scope])
    const limitChanges = useMemo<StagedLimitChange[]>(() => Object.entries(limitEntries).flatMap(([key, e]) => {
        const r = values[key]
        if (!r) return []
        return [{ key, ownBefore: r.limits ?? null, ownAfter: e.limits, before: limitsInForce(values, key), expectedVersion: e.version }]
    }), [limitEntries, values])
    const current = useMemo(
        () => Object.fromEntries(Object.values(values).map((r) => [r.key, r.effective])) as Values,
        [values],
    )
    const next = useMemo(
        () => ({ ...current, ...Object.fromEntries(changes.map((c) => [c.key, c.after])) }) as Values,
        [current, changes],
    )

    const stage = (key: string, value: SettingValue | null) => {
        const r = values[key]
        if (!r) return
        setEntries((prev) => {
            const { [key]: earlier, ...rest } = prev
            if (sameValue(value, ownValue(r, scope))) return rest
            // The version first seen is the one decided on: keep it across re-edits.
            return { ...rest, [key]: { value, version: earlier?.version ?? r.version } }
        })
    }

    const stageLimits = (key: string, limits: Limits | null) => {
        const r = values[key]
        if (!r || scope !== 'platform') return
        setLimitEntries((prev) => {
            const { [key]: earlier, ...rest } = prev
            if (sameAsSaved(values, key, limits)) return rest
            return { ...rest, [key]: { limits, version: earlier?.version ?? entries[key]?.version ?? r.version } }
        })
    }

    return {
        stage,
        unstage: (key) => setEntries(({ [key]: _gone, ...rest }) => rest),
        reset: () => {
            setEntries({})
            setLimitEntries({})
        },
        isStaged: (key) => key in entries,
        valueAt: (key) => (key in entries ? entries[key].value : values[key] ? ownValue(values[key], scope) : null),
        changes,
        stageLimits,
        unstageLimits: (key) => setLimitEntries(({ [key]: _gone, ...rest }) => rest),
        stagedLimits: (key) => (key in limitEntries ? limitEntries[key].limits : undefined),
        limitChanges,
        dirtyCount: changes.length + limitChanges.length,
        expectedVersion: (key) => entries[key]?.version ?? limitEntries[key]?.version,
        payload: () => merge(
            changes.map((c) => ({ key: c.key, value: c.ownAfter, expectedVersion: c.expectedVersion })),
            limitChanges.map((l) => ({ key: l.key, limits: l.ownAfter, expectedVersion: l.expectedVersion })),
        ),
        current,
        next,
        markSaved: () => {
            setLastSaved(changes)
            setLastSavedLimits(limitChanges)
            setEntries({})
            setLimitEntries({})
        },
        lastSaved,
        lastSavedLimits,
        undoPayload: () => merge(
            (lastSaved ?? []).map((c) => ({ key: c.key, value: c.ownBefore, expectedVersion: values[c.key]?.version ?? c.expectedVersion })),
            (lastSavedLimits ?? []).map((l) => ({ key: l.key, limits: l.ownBefore, expectedVersion: values[l.key]?.version ?? l.expectedVersion })),
        ),
        clearUndo: () => {
            setLastSaved(null)
            setLastSavedLimits(null)
        },
        rebase: (fresh = values) => {
            setEntries((prev) => Object.fromEntries(Object.entries(prev).flatMap(([key, e]) => {
                const r = fresh[key]
                if (!r || sameValue(e.value, ownValue(r, scope))) return []
                return [[key, { value: e.value, version: r.version }]]
            })))
            setLimitEntries((prev) => Object.fromEntries(Object.entries(prev).flatMap(([key, e]) => {
                const r = fresh[key]
                if (!r || sameAsSaved(fresh, key, e.limits)) return []
                return [[key, { limits: e.limits, version: r.version }]]
            })))
        },
    }
}
