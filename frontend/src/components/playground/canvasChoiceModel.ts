/**
 * The choice `CanvasChoice` shows: which canvases a new Playground graph opens with — its
 * Context View always, and a Graph view and a Hierarchy view if wanted — what keeps each from
 * being chosen (a layout an administrator withdrew; a Hierarchy of a data model that nests
 * nothing), and what the graph was made with, said back afterwards.
 */
import { useState } from 'react'
import { useFeatureList } from '@/store/features'
import type { PlaygroundView, StartedViewIds } from '@/services/playgroundService'

/** What a Hierarchy view of the graph would show ("Dashboards and their metrics"), or why the
 *  graph can't have one. */
export type HierarchyOption = { shows: string } | { why: string }

const OPTIONAL: PlaygroundView[] = ['graph', 'hierarchy']
const WITHDRAWN: Record<PlaygroundView, string> = {
    graph: 'An administrator has turned Graph views off.',
    hierarchy: 'An administrator has turned Hierarchy views off.',
}

/** The canvases chosen beside the Context View, what keeps each from being chosen now (null: it
 *  can be), and `views`: the ones to make — those chosen that can be, so the server is never
 *  asked for one it would refuse the graph for. */
export function useCanvasChoice(hierarchy: HierarchyOption) {
    const [chosen, setChosen] = useState<PlaygroundView[]>([])
    // Unread or empty: the server's defaults, every layout.
    const allowed = useFeatureList('allowedViewModes')
    const withdrawn = (v: PlaygroundView) => !!allowed && !allowed.includes(v)
    const blocked: Record<PlaygroundView, string | null> = {
        graph: withdrawn('graph') ? WITHDRAWN.graph : null,
        hierarchy: withdrawn('hierarchy') ? WITHDRAWN.hierarchy : 'why' in hierarchy ? hierarchy.why : null,
    }
    const toggle = (v: PlaygroundView) => {
        if (blocked[v]) return
        setChosen(c => (c.includes(v) ? c.filter(x => x !== v) : OPTIONAL.filter(x => x === v || c.includes(x))))
    }
    return { chosen, toggle, blocked, hierarchy, views: chosen.filter(v => !blocked[v]) }
}

export type CanvasChoiceState = ReturnType<typeof useCanvasChoice>

/** Its Hierarchy view: of a containment in `layer` both of whose ends are among `used` (every type
 *  of the layer when none is named), as the server makes one — the first such relationship, its
 *  container and contained types the first of each, by id. */
export function hierarchyOfLayer(
    entities: readonly { id: string; pluralName: string }[],
    relationships: readonly { id: string; isContainment?: boolean; sourceTypes: string[]; targetTypes: string[] }[],
    containmentIds: readonly string[],
    used?: readonly string[],
): HierarchyOption {
    const known = new Set(used?.length ? used : entities.map(e => e.id))
    const contains = new Set(containmentIds.map(id => id.toUpperCase()))
    for (const rel of relationships) {
        if (!rel.isContainment && !contains.has(rel.id.toUpperCase())) continue
        const [from] = rel.sourceTypes.filter(t => known.has(t)).sort()
        const [to] = rel.targetTypes.filter(t => known.has(t)).sort()
        const container = entities.find(e => e.id === from)
        const held = entities.find(e => e.id === to)
        if (container && held) return { shows: `${container.pluralName} and their ${held.pluralName.toLowerCase()}` }
    }
    return { why: 'Its data model has nothing that holds anything else. A hierarchy nests one kind of thing inside another, such as a dashboard and its metrics.' }
}

/** What a graph was made with, in a sentence: the Context View it opens in, the views beside it,
 *  and a Hierarchy asked for that it couldn't have. */
export function madeWith(viewIds?: StartedViewIds | null): string {
    const beside = [viewIds?.graph && 'a Graph view', viewIds?.hierarchy && 'a Hierarchy view'].filter(Boolean)
    const opens = `It opens in its Context View${beside.length ? `, with ${beside.join(' and ')} beside it` : ''}.`
    return viewIds?.hierarchy === null
        ? `${opens} It has no Hierarchy view: its data model has nothing that holds anything else.`
        : opens
}
