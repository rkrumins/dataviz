/**
 * The names relationships of these types carry in the view's discovery sample, each with a value or
 * two it holds — offered as a property is added to one relationship or to several. A name carried
 * by more than one of the types is offered once, from the first that carries it; a relationship's
 * own fields (`EDGE_RESERVED_KEYS`) never are. The sample is asked for only while `enabled`.
 */
import { useMemo } from 'react'
import { useActiveView } from '@/store/schema'
import { useDiscovery } from '@/components/canvas/search/builder/useDiscovery'
import { EDGE_RESERVED_KEYS } from '@/components/canvas/property-manager/op/opModel'
import type { PropertySuggestion } from '../property/composerModel'

export function useEdgePropertySuggestions(edgeTypes: readonly string[], enabled = true): PropertySuggestion[] {
  const viewId = useActiveView()?.id ?? null
  const { keysByEdgeType, getEdgeValueSamples } = useDiscovery(enabled ? viewId : null)
  const typesKey = edgeTypes.join('\u0000')
  return useMemo(() => {
    const out = new Map<string, PropertySuggestion>()
    for (const edgeType of typesKey ? typesKey.split('\u0000') : []) {
      // The sample names a type as the graph stores it: matched case-insensitively.
      const at = Object.keys(keysByEdgeType).find((t) => t.toLowerCase() === edgeType.toLowerCase())
      for (const key of at ? keysByEdgeType[at]! : []) {
        if (EDGE_RESERVED_KEYS.has(key) || out.has(key)) continue
        out.set(key, {
          key,
          count: 0,
          examples: getEdgeValueSamples(at!, key)
            .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
            .map(String).filter((v) => v.length <= 40).slice(0, 2),
        })
      }
    }
    return [...out.values()]
  }, [keysByEdgeType, getEdgeValueSamples, typesKey])
}
