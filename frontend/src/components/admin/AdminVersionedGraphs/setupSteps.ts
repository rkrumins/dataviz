/**
 * The guided setup's steps: what each asks, and how much more of its categories a level has.
 * Pure, so the wizard and its tests read the same answer.
 *
 *   goal     what matters most: a profile, offered by its goal
 *   reads    while data loads: the read mode and how far behind a fast view may be
 *   memory   whether graphs stay in memory (its switch is shown, never turned)
 *   drafts   who approves and merges, how long closed drafts keep their changes, the replace guard
 *   review   every change staged at this level, saved with one PATCH
 *
 * The same keys at the platform and a workspace; who may change each is the resolver's answer
 * (`editable`, `editor`), so a value someone can't change here is shown read-only, never hidden.
 */
import type { Category, Scope, Setting } from '@/components/settings'

export type SetupStepId = 'goal' | 'reads' | 'memory' | 'drafts' | 'review'

export interface SetupStep {
    id: SetupStepId
    /** Its name in the stepper. */
    label: string
    /** The settings it asks, in order. */
    keys: string[]
}

export const SETUP_STEPS: readonly SetupStep[] = [
    { id: 'goal', label: 'What matters most', keys: [] },
    { id: 'reads', label: 'While data loads', keys: ['reads.mode', 'reads.maxVersionsBehind'] },
    { id: 'memory', label: 'Memory', keys: ['residency.class'] },
    { id: 'drafts', label: 'Drafts & imports', keys: ['drafts.selfApproval', 'drafts.selfMerge', 'drafts.keepClosedDays', 'imports.replaceGuard'] },
    { id: 'review', label: 'Review', keys: [] },
]

/** The settings a step asks at `scope`, in its order: those the level has. */
export function stepSettings(step: SetupStep, settings: Record<string, Setting>, scope: Scope): Setting[] {
    return step.keys.flatMap((key) => (settings[key]?.scopes[scope] ? [settings[key]] : []))
}

/**
 * The rest of each category a step asks from, at `scope`: "5 more in Drafts & history". Counted
 * over the settings the level has, less those the step asks; a category with none left is left out.
 */
export function moreInCategories(step: SetupStep, settings: Setting[], categories: Category[], scope: Scope): Array<{ category: Category; more: number }> {
    const asked = new Set(step.keys)
    const ids = [...new Set(settings.filter((s) => asked.has(s.key)).map((s) => s.category))]
    return ids.flatMap((id) => {
        const category = categories.find((c) => c.id === id)
        const more = settings.filter((s) => s.category === id && s.scopes[scope] && !asked.has(s.key)).length
        return category && more > 0 ? [{ category, more }] : []
    })
}
