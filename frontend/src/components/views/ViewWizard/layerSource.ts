/**
 * layerSource — what fills a layer, as the Layout step's Source control offers it, and what
 * switching it changes. Pure: the step renders the choice; this decides what it writes.
 *
 *   • BY TYPE     — its types (or rules) pick out what lands in it.
 *   • HAND-PICKED — only what is placed in it, on the Assignments step or on the canvas.
 *   • MAPPED      — the column IS one top-level entity: its `anchorUrn` and that entity's
 *                   inheriting placement, written together by `mapLayerToEntity`.
 *
 * The kinds are the canvas's own (`columnKind`), so a column reads the same in both places.
 * Mapping drops a layer's types and rules: a type rule would keep pulling every entity of that
 * type into the one entity's column.
 */
import type { LayerAssignmentEntry, ViewLayerConfig } from '@/types/schema'
import { columnKind, type ColumnKind } from '@/components/canvas/context-view/columnKind'
import { mapLayerToEntity, unmapLayer } from '@/components/canvas/context-view/layerMutations'

export type LayerSource = ColumnKind

/** The part of the wizard's form that says what fills its layers. */
export interface LayerFillState {
    layers: ViewLayerConfig[]
    assignments: Record<string, LayerAssignmentEntry>
}

export function layerSourceOf(layer: ViewLayerConfig): LayerSource {
    return columnKind(layer, { resolved: true })
}

/** Its types and rules gone. */
const unfilled = (layer: ViewLayerConfig): ViewLayerConfig => {
    const next = { ...layer, entityTypes: [] }
    delete next.rules
    return next
}

/** The layer mapped to nothing: the entity it was mapped to stays in it, as a row (`unmapLayer`).
 *  `shownName`: the name its entity showed. */
function unmapped(fill: LayerFillState, layerId: string, shownName?: string): LayerFillState {
    const layout = unmapLayer({ layers: fill.layers, assignments: fill.assignments }, layerId, { name: shownName })
    return { layers: layout.layers, assignments: layout.assignments }
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

/** Mapped to a top-level entity there is (`name`: as the reader sees it). */
export function toEntity(fill: LayerFillState, layerId: string, urn: string, name: string): LayerFillState {
    const layout = mapLayerToEntity({ layers: unfill(fill.layers, layerId), assignments: fill.assignments }, layerId, urn, { name })
    return { layers: layout.layers, assignments: layout.assignments }
}
