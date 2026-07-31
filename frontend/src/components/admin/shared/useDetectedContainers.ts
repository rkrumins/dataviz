/**
 * useDetectedContainers — does this graph nest its properties, and under which
 * key? Answered BEFORE the data source exists.
 *
 * The Mapping tab reads the profiled report, but that report is keyed by data
 * source, so the onboarding wizards — the moment a user is best placed to fix
 * this — have nothing to go on. They do have the same schema probe
 * `NodeIdentityField` uses: `discoverSchema` returns per-label sample rows.
 *
 * Detection is by SHAPE, not by name: a key is a container when its sampled
 * value is a plain object, or a string that parses to one (FalkorDB has no
 * map type, so a foreign writer usually lands JSON in a string). Matching on
 * the name "properties" would both miss `attributes` and false-positive on a
 * scalar that happens to be called `metadata`.
 */
import { useQuery } from '@tanstack/react-query'

import { providerService } from '@/services/providerService'

export interface DetectedContainers {
    /** Container keys seen in samples, most frequent first. */
    containerKeys: string[]
    /** Labels carrying at least one of them. */
    nestedLabels: string[]
    loading: boolean
}

const EMPTY: DetectedContainers = { containerKeys: [], nestedLabels: [], loading: false }

function isNestedValue(v: unknown): boolean {
    if (v && typeof v === 'object' && !Array.isArray(v)) return true
    if (typeof v !== 'string') return false
    const s = v.trim()
    if (!s.startsWith('{')) return false
    try {
        const parsed = JSON.parse(s)
        return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    } catch {
        return false
    }
}

export function useDetectedContainers(
    providerId: string | undefined,
    graphName: string | undefined,
    enabled: boolean,
): DetectedContainers {
    const { data, isLoading } = useQuery({
        // Shared key: several sources in one wizard hitting the same graph
        // resolve to one probe rather than one each.
        queryKey: ['discover-schema', providerId, graphName ?? ''],
        queryFn: () => providerService.discoverSchema(providerId!, graphName),
        enabled: Boolean(enabled && providerId),
        staleTime: 5 * 60_000,
        retry: false,
    })

    if (!data) return isLoading ? { ...EMPTY, loading: true } : EMPTY

    const hits = new Map<string, number>()
    const nestedLabels: string[] = []
    for (const [label, detail] of Object.entries(data.labelDetails || {})) {
        let labelNests = false
        for (const sample of detail.samples || []) {
            for (const [key, value] of Object.entries(sample || {})) {
                if (!isNestedValue(value)) continue
                hits.set(key, (hits.get(key) ?? 0) + 1)
                labelNests = true
            }
        }
        if (labelNests) nestedLabels.push(label)
    }

    return {
        containerKeys: [...hits.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k),
        nestedLabels,
        loading: false,
    }
}
