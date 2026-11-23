/**
 * The trade-off compass's arithmetic: where the settings in force leave each of the seven
 * dimensions (Consistency, Availability, Read speed, Update speed, Memory, Database load, Cost),
 * from the registry's own words.
 *
 * - A CHOICE says, per dimension, whether it is better, the same or worse (`choice.effects`):
 *   +1, 0 or −1, weighted by the setting's effect on that dimension (low 1, medium 2, high 3;
 *   medium when the setting names no weight for it).
 * - A NUMBER moves each dimension it affects by how far the value sits from the recommended one,
 *   as a share of the way to the end of its range (−1 to +1), in the direction its effect's
 *   `upVerdict` says raising it goes (better or worse), times the effect's weight. A word that is a
 *   value ("unlimited", "forever", "everyone") is as far up as it goes.
 * - A SWITCH counts on as up and off as down, against the recommended value.
 *
 * A dimension's score is its weighted sum over the weights that touched it: −1 (every setting
 * worse) to +1 (every setting better), 0 when balanced or untouched.
 */
import type { Dimension, DimensionInfo, Setting, SettingValue, Values, Verdict, Weight } from './types'

export const WEIGHT: Record<Weight, number> = { low: 1, medium: 2, high: 3 }
export const VERDICT_SCORE: Record<Verdict, number> = { better: 1, same: 0, worse: -1 }

export interface CompassDriver {
    key: string
    label: string
    /** Signed and weighted: what this setting adds to the dimension. */
    contribution: number
    /** The registry's words for it. */
    text: string
}

export interface CompassPoint {
    dimension: Dimension
    label: string
    /** −1 to +1. */
    score: number
    /** Whether any setting in force touches this dimension. */
    touched: boolean
    drivers: CompassDriver[]
}

const clamp1 = (n: number) => Math.max(-1, Math.min(1, n))

/** How far `v` sits from `base`, as a share of the way to the end of the range: −1 to +1. */
function displacement(s: Setting, v: SettingValue, base: SettingValue): number {
    if (v === base) return 0
    if (v === 'unlimited' || v === 'forever' || v === 'everyone') return 1
    if (base === 'unlimited' || base === 'forever' || base === 'everyone') return -1
    if (typeof v === 'boolean') return v === base ? 0 : v ? 1 : -1
    const n = Number(v)
    const b = Number(base)
    if (!Number.isFinite(n) || !Number.isFinite(b)) return 0
    if (s.range) {
        const room = n > b ? s.range[1] - b : b - s.range[0]
        return room > 0 ? clamp1((n - b) / room) : 0
    }
    return clamp1((n - b) / Math.max(Math.abs(b), 1))
}

function contributions(s: Setting, v: SettingValue): Array<{ dimension: Dimension; value: number; weight: number; text: string }> {
    const weightOf = (d: Dimension) => WEIGHT[s.guidance.effects.find((e) => e.dimension === d)?.weight ?? 'medium']
    if (s.kind === 'choice') {
        const c = s.choices.find((x) => x.id === v)
        if (!c) return []
        return (Object.entries(c.effects) as Array<[Dimension, [Verdict, string]]>).map(([dimension, [verdict, text]]) => ({
            dimension, value: VERDICT_SCORE[verdict] * weightOf(dimension), weight: weightOf(dimension), text,
        }))
    }
    const d = displacement(s, v, s.guidance.recommended.value)
    return s.guidance.effects.map((e) => ({
        dimension: e.dimension,
        value: d * VERDICT_SCORE[e.upVerdict] * WEIGHT[e.weight],
        weight: WEIGHT[e.weight],
        text: d >= 0 ? e.up : e.down,
    }))
}

/**
 * `inactive`: settings that have no effect now (dormant or not used): they don't move the compass,
 * whatever their value says.
 */
export function compassScores(dimensions: DimensionInfo[], settings: Setting[], values: Values, inactive: ReadonlySet<string> = new Set()): CompassPoint[] {
    const sums = new Map<Dimension, { raw: number; weight: number; drivers: CompassDriver[] }>()
    for (const s of settings) {
        const v = values[s.key]
        if (v === undefined || inactive.has(s.key)) continue
        for (const c of contributions(s, v)) {
            const acc = sums.get(c.dimension) ?? { raw: 0, weight: 0, drivers: [] }
            acc.raw += c.value
            acc.weight += c.weight
            acc.drivers.push({ key: s.key, label: s.label, contribution: c.value, text: c.text })
            sums.set(c.dimension, acc)
        }
    }
    return dimensions.map((d) => {
        const acc = sums.get(d.id)
        return {
            dimension: d.id,
            label: d.label,
            score: acc && acc.weight ? clamp1(acc.raw / acc.weight) : 0,
            touched: Boolean(acc),
            drivers: (acc?.drivers ?? []).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)),
        }
    })
}

/** A score in words: "much better", "a little worse", "balanced". */
export function scoreWords(score: number): string {
    const a = Math.abs(score)
    if (a < 0.1) return 'balanced'
    const how = a >= 0.6 ? 'much ' : a >= 0.3 ? '' : 'a little '
    return `${how}${score > 0 ? 'better' : 'worse'}`
}

/** Whether the staged values move any dimension. */
export function compassMoves(a: CompassPoint[], b: CompassPoint[]): boolean {
    return a.some((p, i) => Math.abs(p.score - (b[i]?.score ?? 0)) > 0.005)
}
