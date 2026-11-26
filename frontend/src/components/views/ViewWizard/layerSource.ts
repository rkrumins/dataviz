/**
 * layerSource — what fills a layer, as the Layout step's Source control offers it, and what
 * switching it changes. Pure: the step renders the choice; this decides what it writes.
 *
 *   • BY TYPE     — its types (or rules) pick out what lands in it.
 *   • HAND-PICKED — only what is placed in it, on the Assignments step or on the canvas.
 *   • MAPPED      — the column IS one top-level entity: its `anchorUrn` and that entity's
 *                   inheriting placement, written together by `mapLayerToEntity`. On a brand-new
 *                   model, an entity still to be made with it (`NewRoot`): made in the new graph's
 *                   draft once the graph and the view exist, and the column mapped to it then.
 *
 * The kinds are the canvas's own (`columnKind`), so a column reads the same in both places.
 * Mapping drops a layer's types and rules: a type rule would keep pulling every entity of that
 * type into the one entity's column. A column nobody named takes its entity's name, as on the
 * canvas — and here, so does one named for the types it filled with ("Domains"): that name
 * described what filled it, not what it is now (`takeName`).
 */
import type { LayerAssignmentEntry, ViewLayerConfig } from '@/types/schema'
import type { GraphChangeOp } from '@/services/versioningApiService'
import type { NormalizedReferenceLayout } from '@/utils/referenceLayout'
import { columnKind, type ColumnKind } from '@/components/canvas/context-view/columnKind'
import { isAutoLayerName, mapLayerToEntity, unmapLayer } from '@/components/canvas/context-view/layerMutations'

export type LayerSource = ColumnKind

/** "Finance", "Finance and Marketing", "Finance, Marketing or Sales". */
export function listOf(names: readonly string[], word: 'and' | 'or' = 'and'): string {
    return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} ${word} ${names[names.length - 1]}`
}

/** A top-level entity a brand-new model's column is mapped to, made with the model. */
export interface NewRoot {
    /** One of the ontology's root types. */
    type: string
    /** As typed. */
    name: string
}

/** The part of the wizard's form that says what fills its layers. */
export interface LayerFillState {
    layers: ViewLayerConfig[]
    assignments: Record<string, LayerAssignmentEntry>
    /** By layer id. */
    newRoots?: Record<string, NewRoot>
}

export function layerSourceOf(layer: ViewLayerConfig, newRoot?: NewRoot): LayerSource {
    return newRoot ? 'mapped' : columnKind(layer, { resolved: true })
}

const withoutRoot = (roots: Record<string, NewRoot> | undefined, layerId: string) => {
    if (!roots?.[layerId]) return roots
    const rest = { ...roots }
    delete rest[layerId]
    return rest
}

/** Its types and rules gone. */
const unfilled = (layer: ViewLayerConfig): ViewLayerConfig => {
    const next = { ...layer, entityTypes: [] }
    delete next.rules
    return next
}

/** The layer mapped to nothing: the entity it was mapped to stays in it, as a row (`unmapLayer`),
 *  and no new one is made for it. `shownName`: the name its entity showed. */
function unmapped(fill: LayerFillState, layerId: string, shownName?: string): LayerFillState {
    const layout = unmapLayer({ layers: fill.layers, assignments: fill.assignments }, layerId, { name: shownName })
    return { layers: layout.layers, assignments: layout.assignments, newRoots: withoutRoot(fill.newRoots, layerId) }
}

const unfill = (layers: ViewLayerConfig[], layerId: string) => layers.map(l => (l.id === layerId ? unfilled(l) : l))

/** By type: no longer mapped. Its types are chosen next. */
export function toByType(fill: LayerFillState, layerId: string, shownName?: string): LayerFillState {
    return unmapped(fill, layerId, shownName)
}

/** Hand-picked: no types, no rules, no mapping — only what is placed in it. */
export function toHandPicked(fill: LayerFillState, layerId: string, shownName?: string): LayerFillState {
    const next = unmapped(fill, layerId, shownName)
    return { ...next, layers: unfill(next.layers, layerId) }
}

/** Its types and rules gone — and, `takeName`, its name free to follow the entity it is mapped to. */
const unfillFor = (layers: ViewLayerConfig[], layerId: string, takeName?: boolean) => layers.map(l => {
    if (l.id !== layerId) return l
    return takeName ? { ...unfilled(l), nameFromAnchor: true } : unfilled(l)
})

/** Mapped to a top-level entity there is (`name`: as the reader sees it). */
export function toEntity(
    fill: LayerFillState, layerId: string, urn: string, name: string, opts: { takeName?: boolean } = {},
): LayerFillState {
    const layout = mapLayerToEntity(
        { layers: unfillFor(fill.layers, layerId, opts.takeName), assignments: fill.assignments }, layerId, urn, { name })
    return { layers: layout.layers, assignments: layout.assignments, newRoots: withoutRoot(fill.newRoots, layerId) }
}

/** Mapped to a new top-level entity, made with the model. A column nobody named takes its name,
 *  as `mapLayerToEntity` names one after an entity there is. */
export function toNewRoot(
    fill: LayerFillState, layerId: string, root: NewRoot, opts: { takeName?: boolean } = {},
): LayerFillState {
    const next = unmapped(fill, layerId)
    const name = root.name.trim()
    const layers = unfillFor(next.layers, layerId, opts.takeName).map(l => {
        if (l.id !== layerId) return l
        return name && isAutoLayerName(l) ? { ...l, name, nameFromAnchor: true } : l
    })
    return { ...next, layers, newRoots: { ...next.newRoots, [layerId]: root } }
}

// ── New top-level entities, made with a brand-new model ──────────────────────────────────────────

/** Why a new entity cannot be made as it is: no name, or the name of another column's new entity
 *  of its type. */
export type NewRootProblem = 'unnamed' | 'taken'

const inOrder = (layers: ViewLayerConfig[]) => [...layers].sort((a, b) => a.order - b.order)

/** The layers whose new entity cannot be made as it is. Of two with one name, the later column's
 *  is the one to change. */
export function newRootProblems(layers: ViewLayerConfig[], newRoots: Record<string, NewRoot> | undefined): Record<string, NewRootProblem> {
    const problems: Record<string, NewRootProblem> = {}
    const seen = new Set<string>()
    for (const layer of inOrder(layers)) {
        const root = newRoots?.[layer.id]
        if (!root) continue
        const name = root.name.trim().toLowerCase()
        const key = JSON.stringify([root.type.toLowerCase(), name])
        if (!name) problems[layer.id] = 'unnamed'
        else if (seen.has(key)) problems[layer.id] = 'taken'
        seen.add(key)
    }
    return problems
}

/** What to do about it, said where it is named and on its column's row (`typeName`: its type's name). */
export function newRootProblemText(problem: NewRootProblem, typeName: string, name: string): string {
    return problem === 'unnamed'
        ? `Name the new ${typeName}.`
        : `Another column makes a ${typeName} named “${name.trim()}” — each needs its own name.`
}

export interface RootToMake extends NewRoot {
    layerId: string
    /** What the save knows it by until it answers with its urn: one per column and the same every
     *  time, so a retry under the first attempt's key is the same save. */
    ref: string
}

/** The new entities to make, in column order, their names trimmed. */
export function rootsToMake(layers: ViewLayerConfig[], newRoots: Record<string, NewRoot> | undefined): RootToMake[] {
    return inOrder(layers).flatMap(layer => {
        const root = newRoots?.[layer.id]
        return root ? [{ layerId: layer.id, type: root.type, name: root.name.trim(), ref: `urn:staged:${root.type}:${layer.id}` }] : []
    })
}

/** The one `/graph/changes` batch that makes them, at the top level. */
export function rootCreateOps(roots: readonly RootToMake[]): GraphChangeOp[] {
    return roots.map(r => ({ op: 'create', kind: 'node', ref: r.ref, payload: { entityType: r.type, displayName: r.name } }))
}

/** `layout` with each column mapped to the entity made for it (`assigned`: ref → urn). */
export function mapMadeRoots(
    layout: NormalizedReferenceLayout,
    roots: readonly RootToMake[],
    assigned: Readonly<Record<string, string>>,
): NormalizedReferenceLayout {
    return roots.reduce((at, r) => (assigned[r.ref] ? mapLayerToEntity(at, r.layerId, assigned[r.ref], { name: r.name }) : at), layout)
}
