/**
 * The Graph canvas's lines a Connections search's matches are drawn on. A
 * match drawn as itself is found by its id, or by its ends and type; one
 * whose ends fold into visible containers, on the line between those for its
 * type (`proj:`), else on the roll-up between them (`agg:`). Containment is
 * drawn as nesting, so a containment match lights its ends only.
 */
import { normalizeEdgeType } from '@/store/schema'
import type { MatchedEdge } from '@/store/searchStore'


export interface DrawnGraphLine {
    id: string
    source: string
    target: string
    _isContainment: boolean
    data?: { edgeType?: string; relationship?: string; isAggregated?: boolean }
}

export function searchLineIds(
    matches: readonly MatchedEdge[],
    lines: readonly DrawnGraphLine[],
    /** The node a node is drawn as: itself, or the visible container it folds into. */
    visibleOf: (id: string) => string | null,
    isContainmentEdge: (edgeType: string) => boolean,
): Set<string> {
    const ids = new Set<string>()
    const byEndsAndType = new Map<string, string>()
    const rollups = new Map<string, string>()
    for (const line of lines) {
        if (line._isContainment) continue
        if (line.data?.isAggregated) {
            rollups.set(`${line.source}->${line.target}`, line.id)
            continue
        }
        ids.add(line.id)
        byEndsAndType.set(`${line.source}->${line.target}:${normalizeEdgeType(line)}`, line.id)
    }
    const lit = new Set<string>()
    for (const m of matches) {
        if (isContainmentEdge(m.edgeType)) continue
        if (ids.has(m.id)) {
            lit.add(m.id)
            continue
        }
        const source = visibleOf(m.source)
        const target = visibleOf(m.target)
        if (!source || !target || source === target) continue
        const line = byEndsAndType.get(`${source}->${target}:${m.edgeType.toUpperCase()}`)
            ?? rollups.get(`${source}->${target}`)
        if (line) lit.add(line)
    }
    return lit
}
