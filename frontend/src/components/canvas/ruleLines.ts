/**
 * The lines the display rules that style relationships paint, and how — the
 * Graph canvas's (`ruleLineLooks`) and the Context View's (`memberRuleLooks`).
 *
 * A rule's matches are relationships, by id. On the Graph canvas each is
 * found on the line that draws it as a Connections search's are
 * (`searchLineIds`): drawn as itself, or folded with the others between two
 * visible containers into one line of its type — which a rule paints when
 * any relationship it stands for matches. A roll-up stands for every
 * relationship between two containers, matched or not, so no rule ever
 * paints one.
 *
 * Where two rules match one line, the first in the view's list gives its
 * colour, dash and width; every matching rule that shows its chip adds it.
 */
import { normalizeEdgeType } from '@/store/schema'
import type { DisplayRuleTag } from '@/store/displayRuleMatchStore'

import { type DrawnGraphLine, searchLineIds } from './searchLines'


/** A rule-painted line's look. */
export interface RuleLineLook {
    color: string
    dash?: 'dashed' | 'dotted'
    width: number
    /** The chips the line carries, in the view's order. */
    chips: DisplayRuleTag[]
}

/** A rule's line width when it names none. */
export const RULE_LINE_WIDTH = 2.5

/** One relationship the canvas holds. */
export interface HeldRelationship {
    id: string
    source: string
    target: string
    data?: { edgeType?: string; relationship?: string }
}

const NO_LOOKS: ReadonlyMap<string, RuleLineLook> = new Map()


export function ruleLineLooks(
    rules: ReadonlyArray<DisplayRuleTag>,
    matchesByRule: ReadonlyMap<string, ReadonlySet<string>>,
    relationships: ReadonlyArray<HeldRelationship>,
    lines: ReadonlyArray<DrawnGraphLine>,
    /** The node a node is drawn as: itself, or the visible container it folds into. */
    visibleOf: (id: string) => string | null,
    isContainmentEdge: (edgeType: string) => boolean,
): ReadonlyMap<string, RuleLineLook> {
    const painting = rules.filter((r) => r.target === 'relationships' && matchesByRule.get(r.id)?.size)
    if (painting.length === 0) return NO_LOOKS
    const byId = new Map(relationships.map((e) => [e.id, e]))
    const drawn = lines.filter((line) => !line.data?.isAggregated)
    const looks = new Map<string, RuleLineLook>()
    for (const rule of painting) {
        const matched = [...matchesByRule.get(rule.id) ?? []].flatMap((id) => {
            const e = byId.get(id)
            return e ? [{ id, source: e.source, target: e.target, edgeType: normalizeEdgeType(e) }] : []
        })
        for (const lineId of searchLineIds(matched, drawn, visibleOf, isContainmentEdge)) {
            paint(looks, lineId, rule)
        }
    }
    return looks
}


/** One line the Context View draws, standing for its members. */
export interface MemberLine {
    id: string
    data?: {
        members?: ReadonlyArray<{ id: string; data?: { isAggregated?: boolean; edgeType?: string } }>
    }
}

/**
 * The Context View's lines the display rules that style relationships paint,
 * and how. Each line there stands for the relationships it draws — its
 * `members`: one, several between two rows, or some lifted to an ancestor row
 * — and a rule paints it when any of those matches. A roll-up member stands
 * for every relationship between two containers, matched or not, so it never
 * paints a line; a line that holds real relationships too is painted for
 * theirs. A Connections search's stand-ins (`search:…`) are none of them.
 */
export function memberRuleLooks(
    rules: ReadonlyArray<DisplayRuleTag>,
    matchesByRule: ReadonlyMap<string, ReadonlySet<string>>,
    lines: ReadonlyArray<MemberLine>,
): ReadonlyMap<string, RuleLineLook> {
    const painting = rules.filter((r) => r.target === 'relationships' && matchesByRule.get(r.id)?.size)
    if (painting.length === 0) return NO_LOOKS
    const looks = new Map<string, RuleLineLook>()
    for (const line of lines) {
        const real = (line.data?.members ?? []).filter((m) => !m.data?.isAggregated
            && m.data?.edgeType?.toUpperCase() !== 'AGGREGATED' && !m.id.startsWith('search:'))
        if (real.length === 0) continue
        for (const rule of painting) {
            const matched = matchesByRule.get(rule.id)
            if (matched && real.some((m) => matched.has(m.id))) paint(looks, line.id, rule)
        }
    }
    return looks
}


/** ``rule`` matches ``lineId``: the first to gives the line its look, each that shows its chip a chip. */
function paint(looks: Map<string, RuleLineLook>, lineId: string, rule: DisplayRuleTag): void {
    let look = looks.get(lineId)
    if (!look) {
        const dash = rule.style?.dash
        look = {
            color: rule.color,
            ...(dash && dash !== 'solid' ? { dash } : {}),
            width: rule.style?.width ?? RULE_LINE_WIDTH,
            chips: [],
        }
        looks.set(lineId, look)
    }
    if (rule.style?.chip !== false) look.chips.push(rule)
}


/** A line's dash pattern, scaled to its width: a dot is as wide as the line. */
export function dashArrayOf(dash: RuleLineLook['dash'], width: number): string | undefined {
    if (dash === 'dashed') return `${width * 3} ${width * 2}`
    if (dash === 'dotted') return `0 ${width * 2}`
    return undefined
}
