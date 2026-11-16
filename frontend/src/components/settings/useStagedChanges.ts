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
 */
import { useMemo, useState } from 'react'
import { inheritedAt, ownValue, sameValue } from './format'
import type { ResolvedValues, Scope, SettingValue, Values } from './types'

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

/** One item of the PATCH body. */
export interface PatchItem {
    key: string
    value: SettingValue | null
    expectedVersion: number
}

interface Entry {
    value: SettingValue | null
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
    dirtyCount: number
    expectedVersion: (key: string) => number | undefined
    payload: () => PatchItem[]
    /** The values in force now, and with the staged changes applied (the compass's ghost). */
    current: Values
    next: Values
    /** Call once the PATCH landed: clears the staging and keeps the batch for undo. */
    markSaved: () => void
    lastSaved: StagedChange[] | null
    /** The PATCH that puts back what the last save changed, at the versions in force now. */
    undoPayload: () => PatchItem[]
    clearUndo: () => void
    /** After a conflict: keep the staged values, take the server's current versions. */
    rebase: () => void
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

export function useStagedChanges(values: ResolvedValues, scope: Scope): StagedChanges {
    const [entries, setEntries] = useState<Record<string, Entry>>({})
    const [lastSaved, setLastSaved] = useState<StagedChange[] | null>(null)

    const changes = useMemo(() => diffStaged(entries, values, scope), [entries, values, scope])
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

    return {
        stage,
        unstage: (key) => setEntries(({ [key]: _gone, ...rest }) => rest),
        reset: () => setEntries({}),
        isStaged: (key) => key in entries,
        valueAt: (key) => (key in entries ? entries[key].value : values[key] ? ownValue(values[key], scope) : null),
        changes,
        dirtyCount: changes.length,
        expectedVersion: (key) => entries[key]?.version,
        payload: () => changes.map((c) => ({ key: c.key, value: c.ownAfter, expectedVersion: c.expectedVersion })),
        current,
        next,
        markSaved: () => {
            setLastSaved(changes)
            setEntries({})
        },
        lastSaved,
        undoPayload: () => (lastSaved ?? []).map((c) => ({
            key: c.key,
            value: c.ownBefore,
            expectedVersion: values[c.key]?.version ?? c.expectedVersion,
        })),
        clearUndo: () => setLastSaved(null),
        rebase: () => setEntries((prev) => Object.fromEntries(Object.entries(prev).flatMap(([key, e]) => {
            const r = values[key]
            if (!r || sameValue(e.value, ownValue(r, scope))) return []
            return [[key, { value: e.value, version: r.version }]]
        }))),
    }
}
