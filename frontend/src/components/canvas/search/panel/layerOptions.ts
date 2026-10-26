/**
 * Layer options surfaced in the filter palette + LayerEditor picker.
 *
 *  - ``value``  is what the filter stores: the layer's name, which the
 *               search reads back as that layer (an id works too), so
 *               Code mode, the sentence and the chips read as people do.
 *               A name two layers share is stored by id, so a pick never
 *               names two.
 *  - ``label``  is the layer's name.
 */
import { useMemo } from 'react'

import { useActiveView } from '@/store/schema'


export interface LayerOption {
    value: string
    label: string
}


/**
 * The layers a layer filter can name: the view's own, in board order — the
 * search finds what its canvas places in each. A view without layers offers
 * the ``layerAssignment`` stamps entities carry, which is all such a filter
 * matches there.
 */
export function layerOptions(
    viewLayers: ReadonlyArray<{ id?: string; name?: string; order?: number }>,
    getValueSamples: (key: string) => ReadonlyArray<unknown>,
): LayerOption[] {
    const order = (o: unknown) => (typeof o === 'number' && Number.isFinite(o) ? o : 0)
    const layers = viewLayers
        .map((layer, position) => ({ layer, position }))
        .filter(({ layer }) => !!layer.id)
        .sort((a, b) => order(a.layer.order) - order(b.layer.order) || a.position - b.position)
        .map(({ layer }) => ({ id: layer.id as string, name: layer.name?.trim() || (layer.id as string) }))
    if (layers.length > 0) {
        const named = new Map<string, number>()
        for (const l of layers) named.set(l.name.toLowerCase(), (named.get(l.name.toLowerCase()) ?? 0) + 1)
        return layers.map((l) => (named.get(l.name.toLowerCase())! > 1
            ? { value: l.id, label: `${l.name} (${l.id})` }
            : { value: l.name, label: l.name }))
    }
    const stamps = new Set<string>()
    for (const v of getValueSamples('layerAssignment')) {
        if (typeof v === 'string' && v) stamps.add(v)
    }
    return Array.from(stamps).sort().map((value) => ({ value, label: value }))
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


/** ``layerOptions`` for the active view. */
export function useViewLayerOptions(
    getValueSamples: (key: string) => unknown[],
): LayerOption[] {
    const activeView = useActiveView()
    return useMemo<LayerOption[]>(
        () => layerOptions(activeView?.layout?.referenceLayout?.layers ?? [], getValueSamples),
        [activeView, getValueSamples],
    )
}
