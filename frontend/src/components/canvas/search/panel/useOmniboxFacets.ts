/**
 * useOmniboxFacets — everything `SearchOmnibox` needs to suggest filters,
 * in one call.
 *
 * Extracted from QueryCard so the Context View header's find panel can
 * offer the same clickable filters the Advanced builder does. The point
 * is not code reuse for its own sake: a business user who clicks
 * "Tagged #PII" in the header must get the same filter an analyst would
 * have typed, ranked the same way, drawn from the same sampled facets.
 * Two suggestion lists would be two different products.
 *
 * Discovery is stale-while-revalidate and keyed by view, so mounting this
 * in a second place costs no extra round-trip.
 */
import { useMemo } from 'react'

import { useActiveView, useSchemaStore } from '@/store/schema'

import { useDiscovery } from '../builder/useDiscovery'
import type { LayerOption } from './layerOptions'
import type { ValueSample } from './omnibox/suggestFilters'


export interface OmniboxFacets {
    entityTypes: string[]
    tagValues: ReadonlyArray<string>
    propertyKeys: ReadonlyArray<string>
    valueSamples: ValueSample[]
    layers: LayerOption[]
    isLoading: boolean
    error: Error | null
    /** Raw sampler, for callers that need a specific key's values. */
    getValueSamples: (key: string) => unknown[]
    allKeys: ReadonlyArray<string>
}


export function useOmniboxFacets(viewId: string | null): OmniboxFacets {
    const discovery = useDiscovery(viewId)
    const entityTypes = useEntityTypeNames()
    const layers = useViewLayerOptions(discovery.getValueSamples)

    const valueSamples = useMemo<ValueSample[]>(() => {
        const out: ValueSample[] = []
        for (const key of discovery.allKeys) {
            for (const raw of discovery.getValueSamples(key)) {
                if (typeof raw !== 'string' && typeof raw !== 'number') continue
                const value = String(raw)
                if (!value) continue
                out.push({ key, value, lc: value.toLowerCase() })
            }
        }
        return out
    }, [discovery])

    return {
        entityTypes,
        tagValues: discovery.tagValues,
        propertyKeys: discovery.allKeys,
        valueSamples,
        layers,
        isLoading: discovery.isInitialLoading,
        error: discovery.error,
        getValueSamples: discovery.getValueSamples,
        allKeys: discovery.allKeys,
    }
}


export function useEntityTypeNames(): string[] {
    const schema = useSchemaStore((s) => s.schema)
    if (!schema?.entityTypes) return []
    return schema.entityTypes.map((t) => t.id)
}


/**
 * Resolve layer options for the active view.
 *
 * Strategy:
 *   1. Sample DB-stored ``layer`` / ``layerAssignment`` property values
 *      (these are exactly what the BE will compare against). For each,
 *      enrich the label from the view config when possible.
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
    return useMemo<LayerOption[]>(() => {
        const viewLayers = activeView?.layout?.referenceLayout?.layers ?? []
        const labelOf = new Map<string, string>()
        for (const l of viewLayers) {
            if (l.id) labelOf.set(l.id, l.name || l.id)
            if (l.name) labelOf.set(l.name, l.name)
        }

        const discovered = new Set<string>()
        for (const key of ['layer', 'layerAssignment']) {
            for (const v of getValueSamples(key)) {
                if (typeof v === 'string' && v) discovered.add(v)
            }
        }

        if (discovered.size > 0) {
            return Array.from(discovered)
                .sort()
                .map((value) => ({ value, label: labelOf.get(value) ?? value }))
        }

        return viewLayers
            .filter((l) => !!l.id)
            .map((l) => ({ value: l.id, label: l.name || l.id }))
            .sort((a, b) => a.label.localeCompare(b.label))
    }, [activeView, getValueSamples])
}
