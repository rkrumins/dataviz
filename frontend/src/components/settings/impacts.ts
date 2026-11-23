/**
 * What a choice, or a change, does to each dimension, in the registry's own words: the data the
 * impact chips draw.
 */
import { VERDICT_SCORE } from './compass'
import type { Choice, Dimension, Setting, SettingValue, Verdict, Weight } from './types'

export interface Impact {
    dimension: Dimension
    /** Absent when the registry says what changes but not whether it is better. */
    verdict?: Verdict
    text: string
    weight?: Weight
}

const DIMENSION_ORDER: Dimension[] = ['consistency', 'availability', 'read_speed', 'update_speed', 'memory', 'database_load', 'cost']
const byDimension = (a: Impact, b: Impact) => DIMENSION_ORDER.indexOf(a.dimension) - DIMENSION_ORDER.indexOf(b.dimension)

/** A choice's verdict on each dimension it names. */
export function choiceImpacts(choice: Choice, setting?: Setting): Impact[] {
    return (Object.entries(choice.effects) as Array<[Dimension, [Verdict, string]]>)
        .map(([dimension, [verdict, text]]) => ({
            dimension, verdict, text,
            weight: setting?.guidance.effects.find((e) => e.dimension === dimension)?.weight,
        }))
        .sort(byDimension)
}

const OPPOSITE: Record<Verdict, Verdict> = { better: 'worse', same: 'same', worse: 'better' }

/**
 * What changing `from` to `to` does. For a choice: the dimensions whose verdict changes, and which
 * way. For a number or a switch: each effect's words for the direction moved, and its verdict
 * (`upVerdict` when raised, the opposite when lowered).
 */
export function changeImpacts(s: Setting, from: SettingValue, to: SettingValue): Impact[] {
    if (from === to) return []
    if (s.kind === 'choice') {
        const a = s.choices.find((c) => c.id === from)
        const b = s.choices.find((c) => c.id === to)
        if (!b) return []
        return (Object.entries(b.effects) as Array<[Dimension, [Verdict, string]]>).flatMap(([dimension, [verdict, text]]) => {
            const was = a?.effects[dimension]?.[0] ?? 'same'
            const delta = VERDICT_SCORE[verdict] - VERDICT_SCORE[was]
            if (delta === 0) return []
            return [{ dimension, verdict: (delta > 0 ? 'better' : 'worse') as Verdict, text }]
        }).sort(byDimension)
    }
    const up = rises(from, to)
    if (up === null) return []
    return s.guidance.effects.map((e) => ({
        dimension: e.dimension,
        verdict: up ? e.upVerdict : OPPOSITE[e.upVerdict],
        text: up ? e.up : e.down,
        weight: e.weight,
    })).sort(byDimension)
}

/** Whether a change raises the value (true), lowers it (false), or can't say (null). */
function rises(from: SettingValue, to: SettingValue): boolean | null {
    const big = (v: SettingValue) => (v === 'unlimited' || v === 'forever' || v === 'everyone' ? Infinity : typeof v === 'boolean' ? Number(v) : Number(v))
    const a = big(from)
    const b = big(to)
    if (Number.isNaN(a) || Number.isNaN(b) || a === b) return null
    return b > a
}
