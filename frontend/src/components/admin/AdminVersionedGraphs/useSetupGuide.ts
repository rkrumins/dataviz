/**
 * useSetupGuide — the guided setup's progress, held by the page beside its editor
 * (`useSettingsEditor`), so it outlives the wizard closing and a tab remounting.
 *
 * The guide stages through the page's editor and keeps nothing staged of its own: what it stages
 * is on the page's save bar and in the tab's count, and is saved by the same PATCH. Before it first
 * sets a key it remembers what was staged for that key, so "Discard them" puts back exactly that,
 * and a new goal unstages only what the last goal staged (a value changed by hand since is kept).
 *
 * It resumes ("Continue setup") while a value it staged is still staged as it left it; otherwise
 * it starts afresh. A reload drops it, with everything staged, as the page always has.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { sameValue, type SettingValue, type StagedChanges } from '@/components/settings'
import { markSetupIntroSeen } from './setupIntro'
import type { SetupStepId } from './setupSteps'

/** What was staged for a key before the guide first set it. */
interface Before {
    staged: boolean
    value: SettingValue | null
}

interface Progress {
    open: boolean
    /** Counts fresh starts: the wizard keys what it holds itself by it. */
    session: number
    step: SetupStepId
    /** The goal picked (a profile's id); null: none yet. */
    goal: string | null
    /** The goal whose values are staged, and the values it staged. */
    applied: { id: string; values: Record<string, SettingValue> } | null
    before: Record<string, Before>
}

const FRESH = { step: 'goal', goal: null, applied: null, before: {} } satisfies Omit<Progress, 'open' | 'session'>

export interface SetupGuide {
    open: boolean
    session: number
    step: SetupStepId
    goal: string | null
    /** The id of the goal whose values are staged. */
    applied: string | null
    /** The keys whose staged value the guide changed and that are still so: "your N choices". */
    changed: string[]
    /** Something it staged is still staged as it left it: "Continue setup" picks it up. */
    resumable: boolean
    /** Opens it where it was left while it is resumable; afresh otherwise. */
    start: () => void
    /** Closes it, keeping what it staged and where it was. */
    keep: () => void
    /** Puts back what was staged for each key it touched, as it was before, and closes it. */
    discard: () => void
    /** After a save: closes it, the next one starting afresh. */
    finish: () => void
    setStep: (step: SetupStepId) => void
    pickGoal: (id: string | null) => void
    /** Stages a goal's plan (null: no goal), after unstaging what the goal before it staged. */
    applyGoal: (id: string | null, plan: Array<{ key: string; value: SettingValue }>) => void
    /** Stages one value, remembering first what was staged for it before the guide. */
    stage: (key: string, value: SettingValue | null) => void
}

export function useSetupGuide(editor: {
    staged: StagedChanges
    stage: (key: string, value: SettingValue | null) => void
    unstage: (key: string) => void
}): SetupGuide {
    const [progress, setProgress] = useState<Progress>({ open: false, session: 0, ...FRESH })
    const { staged } = editor
    const changed = Object.entries(progress.before).filter(([key, was]) => {
        const now = staged.isStaged(key)
        return now !== was.staged || (now && !sameValue(staged.valueAt(key), was.value))
    }).map(([key]) => key)

    // What the callbacks read, kept current, so they stay the same functions across renders.
    const latest = useRef({ editor, progress, resumable: changed.length > 0 })
    useLayoutEffect(() => { latest.current = { editor, progress, resumable: changed.length > 0 } })

    const stage = useCallback((key: string, value: SettingValue | null) => {
        const { editor: e, progress: p } = latest.current
        if (!(key in p.before)) {
            const was: Before = { staged: e.staged.isStaged(key), value: e.staged.valueAt(key) }
            setProgress((prev) => (key in prev.before ? prev : { ...prev, before: { ...prev.before, [key]: was } }))
        }
        e.stage(key, value)
    }, [])

    /** Puts back what was staged for `key` before the guide set it. */
    const restore = useCallback((key: string) => {
        const { editor: e, progress: p } = latest.current
        const was = p.before[key]
        if (!was) return
        if (was.staged) e.stage(key, was.value)
        else e.unstage(key)
    }, [])

    const applyGoal = useCallback((id: string | null, plan: Array<{ key: string; value: SettingValue }>) => {
        const { editor: e, progress: p } = latest.current
        if (p.applied?.id === id || (!p.applied && id === null)) return
        // What the last goal staged goes back, unless it was changed by hand since.
        for (const [key, value] of Object.entries(p.applied?.values ?? {})) {
            if (e.staged.isStaged(key) && sameValue(e.staged.valueAt(key), value)) restore(key)
        }
        for (const item of plan) stage(item.key, item.value)
        setProgress((prev) => ({
            ...prev,
            applied: id === null ? null : { id, values: Object.fromEntries(plan.map((x) => [x.key, x.value])) },
        }))
    }, [restore, stage])

    const start = useCallback(() => {
        markSetupIntroSeen()
        const resume = latest.current.resumable
        setProgress((prev) => (resume ? { ...prev, open: true } : { ...prev, ...FRESH, open: true, session: prev.session + 1 }))
    }, [])

    const discard = useCallback(() => {
        for (const key of Object.keys(latest.current.progress.before)) restore(key)
        setProgress((prev) => ({ ...prev, ...FRESH, open: false }))
    }, [restore])

    const keep = useCallback(() => setProgress((prev) => ({ ...prev, open: false })), [])
    const finish = useCallback(() => setProgress((prev) => ({ ...prev, ...FRESH, open: false })), [])
    const setStep = useCallback((step: SetupStepId) => setProgress((prev) => ({ ...prev, step })), [])
    const pickGoal = useCallback((goal: string | null) => setProgress((prev) => ({ ...prev, goal })), [])

    return {
        open: progress.open,
        session: progress.session,
        step: progress.step,
        goal: progress.goal,
        applied: progress.applied?.id ?? null,
        changed,
        resumable: changed.length > 0,
        start, keep, discard, finish, setStep, pickGoal, applyGoal, stage,
    }
}
