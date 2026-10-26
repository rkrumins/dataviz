/**
 * Layer options surfaced in the filter palette + LayerEditor picker.
 *
 *  - ``value``  is the string actually stored on ``n.layerAssignment``
 *               and used in the compiled Cypher equality. Pickers emit
 *               this; templates seed predicates with it.
 *  - ``label``  is the human-readable display name. When the value
 *               matches a known layer in the view's reference-layout
 *               config (by ``id`` or ``name``), the layer's
 *               ``name`` is used. Otherwise the value itself.
 */
import { useMemo } from 'react'

import { useActiveView } from '@/store/schema'


export interface LayerOption {
    value: string
    label: string
}


/**
 * The layers a layer filter can match: the ``layerAssignment`` values
 * entities carry (named from the view's layers), else the view's configured
 * layers. Only ``layerAssignment`` — the filter matches that and nothing
 * else, so a user property that happens to be called ``layer`` would offer
 * layers no entity is in.
 */
export function layerOptions(
    viewLayers: ReadonlyArray<{ id?: string; name?: string }>,
    getValueSamples: (key: string) => ReadonlyArray<unknown>,
): LayerOption[] {
    const labelOf = new Map<string, string>()
    for (const l of viewLayers) {
        if (l.id) labelOf.set(l.id, l.name || l.id)
        if (l.name) labelOf.set(l.name, l.name)
    }
    const discovered = new Set<string>()
    for (const v of getValueSamples('layerAssignment')) {
        if (typeof v === 'string' && v) discovered.add(v)
    }
    if (discovered.size > 0) {
        return Array.from(discovered)
            .sort()
            .map((value) => ({ value, label: labelOf.get(value) ?? value }))
    }
    return viewLayers
        .filter((l): l is { id: string; name?: string } => !!l.id)
        .map((l) => ({ value: l.id, label: l.name || l.id }))
        .sort((a, b) => a.label.localeCompare(b.label))
}


/**
 * The entity types a view's data holds — discovery samples every label —
 * most common first, so every "Everything of type …" returns something.
 * ``fallback`` (the ontology's types) until discovery answers.
 */
export function entityTypesInView(
    labels: Record<string, { sampled?: number }> | null | undefined,
    fallback: string[],
): string[] {
    if (!labels) return fallback
    const present = Object.entries(labels)
        .filter(([, l]) => (l.sampled ?? 0) > 0)
        .sort(([a, x], [b, y]) => (y.sampled ?? 0) - (x.sampled ?? 0) || a.localeCompare(b))
        .map(([type]) => type)
    return present.length > 0 ? present : fallback
}


/**
 * Resolve layer options for the active view.
 *
 * Strategy:
 *   1. Sample DB-stored ``layerAssignment`` values (exactly what the BE
 *      compares against). For each, enrich the label from the view
 *      config when possible.
 *   2. If discovery returns nothing, fall back to the view's reference-
 *      layout config — using ``layer.id`` as value (typical assignment
 *      writer) and ``layer.name`` as label.
 *
 * This handles both common conventions:
 *   - DB stores layer IDs → label is enriched from view config
 *   - DB stores layer names → label IS the value (visibly the same)
 */
export function useViewLayerOptions(
    getValueSamples: (key: string) => unknown[],
): LayerOption[] {
    const activeView = useActiveView()
    return useMemo<LayerOption[]>(
        () => layerOptions(activeView?.layout?.referenceLayout?.layers ?? [], getValueSamples),
        [activeView, getValueSamples],
    )
}
