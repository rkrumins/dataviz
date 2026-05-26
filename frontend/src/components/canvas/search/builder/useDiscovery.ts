/**
 * Stale-while-revalidate cache for /search/discover output, keyed by
 * workspace+view. Drives the property-key autocomplete in the builder
 * editors so the user picks from "what's actually queryable" rather
 * than guessing from the docs.
 *
 * The discover response is cheap to compute (one Cypher per label,
 * sampled at 200 nodes) but not free; we cache it per-mount and
 * invalidate by view change.
 */
import { useEffect, useState, useMemo } from 'react'

import { useGraphProvider } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { SearchDiscoverResult } from '@/types/search'


export interface UseDiscoveryResult {
    /** Latest successful discover response. `null` until the first
     *  load resolves. */
    discovery: SearchDiscoverResult | null
    /** True on the very first load only. Subsequent revalidations
     *  surface as `discovery` updates without flipping this. */
    isInitialLoading: boolean
    /** Last error from the discover call, or null. */
    error: Error | null
    /** Union of all native property keys across every label. Useful
     *  for property-key autocomplete when the editor doesn't yet
     *  know which entity type the user is filtering by. */
    allKeys: string[]
    /** Per-entity-type key list, dropping labels with no keys. */
    keysByEntityType: Record<string, string[]>
    /** Union of all tag values across the sample, ordered by descending
     *  count. Powers the tag picker. */
    tagValues: string[]
    /** Look up known sample values for a property key. Returns ``[]``
     *  when the key is unknown or value sampling is disabled. The
     *  union across all labels is used; callers that need per-label
     *  granularity should drill into ``discovery.labels[label]``. */
    getValueSamples: (propertyKey: string) => unknown[]
    /** List of edge types seen in the sample, sorted alphabetically. */
    edgeTypes: string[]
    /** Property keys per edge type, dropping types with no properties. */
    keysByEdgeType: Record<string, string[]>
    /** Look up known sample values for an edge property key. */
    getEdgeValueSamples: (edgeType: string, propertyKey: string) => unknown[]
}


/**
 * Cache scope: per workspace-mounted RemoteGraphProvider instance.
 * The provider itself is request-scoped to the active workspace, so
 * we don't need to key by workspace ID separately. The viewId arg
 * triggers refetch when the user switches views.
 */
export function useDiscovery(viewId: string | null): UseDiscoveryResult {
    const provider = useGraphProvider()
    const [discovery, setDiscovery] = useState<SearchDiscoverResult | null>(null)
    const [isInitialLoading, setIsInitialLoading] = useState(true)
    const [error, setError] = useState<Error | null>(null)

    useEffect(() => {
        if (!viewId) {
            setDiscovery(null)
            setIsInitialLoading(false)
            return
        }
        if (!(provider instanceof RemoteGraphProvider)) {
            // Discovery requires the live backend; in-memory / stub
            // providers don't expose it.
            setIsInitialLoading(false)
            return
        }
        let cancelled = false
        // Don't reset to null on revalidation — we want SWR (stale data
        // remains visible while the new fetch runs).
        provider
            .discoverSearchableProperties()
            .then((result) => {
                if (cancelled) return
                setDiscovery(result)
                setError(null)
                setIsInitialLoading(false)
            })
            .catch((e: unknown) => {
                if (cancelled) return
                setError(e instanceof Error ? e : new Error(String(e)))
                setIsInitialLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [provider, viewId])

    const allKeys = useMemo(() => {
        if (!discovery) return []
        const set = new Set<string>()
        for (const label of Object.values(discovery.labels)) {
            for (const k of label.keys) set.add(k)
        }
        return Array.from(set).sort()
    }, [discovery])

    const keysByEntityType = useMemo(() => {
        const out: Record<string, string[]> = {}
        if (!discovery) return out
        for (const [label, info] of Object.entries(discovery.labels)) {
            if (info.keys.length > 0) {
                out[label] = [...info.keys].sort()
            }
        }
        return out
    }, [discovery])

    // Tag values are surfaced as { tagName: count }; the FE picker
    // wants them ordered by descending count so the most-common tags
    // appear first in the dropdown.
    const tagValues = useMemo(() => {
        if (!discovery?.tagValues) return []
        return Object.entries(discovery.tagValues)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([name]) => name)
    }, [discovery])

    // Value-sample lookup. We collapse across labels — the same
    // property key on different labels usually carries the same value
    // space (e.g. ``layerAssignment`` is bronze/silver/gold no matter
    // whether the node is a dataset or a container). Deduplicated by
    // ``JSON.stringify`` to avoid object-equality surprises.
    const valueSampleIndex = useMemo(() => {
        const out: Record<string, unknown[]> = {}
        if (!discovery) return out
        const seen: Record<string, Set<string>> = {}
        for (const info of Object.values(discovery.labels)) {
            const samples = info.valueSamplesByKey
            if (!samples) continue
            for (const [k, values] of Object.entries(samples)) {
                if (!Array.isArray(values)) continue
                const dedup = (seen[k] ??= new Set<string>())
                const list = (out[k] ??= [])
                for (const v of values) {
                    const key = typeof v === 'string' ? v : JSON.stringify(v)
                    if (dedup.has(key)) continue
                    dedup.add(key)
                    list.push(v)
                }
            }
        }
        return out
    }, [discovery])

    const getValueSamples = useMemo(() => {
        return (propertyKey: string) => valueSampleIndex[propertyKey] ?? []
    }, [valueSampleIndex])

    const edgeTypes = useMemo(() => {
        if (!discovery?.edges) return []
        return Object.keys(discovery.edges).sort()
    }, [discovery])

    const keysByEdgeType = useMemo(() => {
        const out: Record<string, string[]> = {}
        if (!discovery?.edges) return out
        for (const [edgeType, info] of Object.entries(discovery.edges)) {
            if (info.keys && info.keys.length > 0) {
                out[edgeType] = [...info.keys].sort()
            }
        }
        return out
    }, [discovery])

    const getEdgeValueSamples = useMemo(() => {
        return (edgeType: string, propertyKey: string): unknown[] => {
            const info = discovery?.edges?.[edgeType]
            if (!info?.valueSamplesByKey) return []
            return info.valueSamplesByKey[propertyKey] ?? []
        }
    }, [discovery])

    return {
        discovery,
        isInitialLoading,
        error,
        allKeys,
        keysByEntityType,
        tagValues,
        getValueSamples,
        edgeTypes,
        keysByEdgeType,
        getEdgeValueSamples,
    }
}
