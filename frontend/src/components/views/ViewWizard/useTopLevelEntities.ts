/**
 * The top-level entities of a data source's root types, for the Layout step's
 * "one column per entity" suggestion: how many each type has, and who they are.
 *
 * One page per type from `GET /nodes/top-level` — the call the Assignments
 * step's browser makes (`useEntityBrowser`) — of one more entity than the most
 * columns ever offered, so "more than that" is known without reading them all.
 * Asks only while `enabled`, and only for a handful of types: an ontology that
 * calls everything a root is not one to make entity columns from.
 */
import { useCallback } from 'react'
import { useQueries, type UseQueryResult } from '@tanstack/react-query'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import type { TopLevelNodesResult } from '@/providers/GraphDataProvider'
import type { TopLevelEntity } from './autoLayers'

/** The most entity columns ever offered (LayerStudio's `AUTO_LAYER_MAX`)… */
export const ENTITY_COLUMNS_MAX = 200
/** …and above how many making them asks first (LayerStudio's `AUTO_LAYER_WARN`). */
export const ENTITY_COLUMNS_WARN = 24
/** Root types beyond which no entities are asked for. */
const MAX_TYPES = 12
const NONE: readonly string[] = []

export interface TopLevelOfType {
    /** Up to one past `ENTITY_COLUMNS_MAX`, by name. */
    entities: TopLevelEntity[]
    /** How many the type has, when known. */
    count: number | null
    /** More than `ENTITY_COLUMNS_MAX`. */
    over: boolean
}

export function useTopLevelEntities(dataSourceId: string | undefined, types: readonly string[], enabled: boolean) {
    const provider = useGraphProvider()
    const asked = enabled && types.length <= MAX_TYPES ? types : NONE
    const combine = useCallback((results: UseQueryResult<TopLevelNodesResult>[]) => {
        const byType = new Map<string, TopLevelOfType>()
        asked.forEach((type, i) => {
            const page = results[i]?.data
            if (!page) return
            byType.set(type, {
                entities: page.nodes.map(n => ({ urn: n.urn, name: n.displayName || n.urn, type: n.entityType, childCount: n.childCount })),
                count: page.totalCount ?? (page.hasMore ? null : page.nodes.length),
                over: page.nodes.length > ENTITY_COLUMNS_MAX || (page.totalCount ?? 0) > ENTITY_COLUMNS_MAX,
            })
        })
        return { byType, isLoading: results.some(r => r.isLoading) }
    }, [asked])
    return useQueries({
        queries: asked.map(type => ({
            queryKey: ['wizard', 'top-level-entities', dataSourceId ?? '__default__', type],
            queryFn: () => provider.getTopLevelNodes({
                entityTypes: [type], limit: ENTITY_COLUMNS_MAX + 1, includeChildCount: true,
            }),
            staleTime: 60_000,
            retry: 1,
        })),
        combine,
    })
}
