import { useMemo } from 'react'

import { useSchemaStore } from '@/store/schema'

import type { UseDiscoveryResult } from '../../builder/useDiscovery'
import type { LayerOption } from '../layerOptions'

import { buildAskVocabulary, type AskVocabulary } from './askVocabulary'


/** The view's words for the Ask bar, from discovery and the schema: every
 *  type the ontology names and the view holds, its tags, keys, sampled
 *  values and layers. */
export function useAskVocabulary(
    discovery: Pick<UseDiscoveryResult, 'discovery' | 'tagValues' | 'allKeys' | 'getValueSamples'>,
    layers: readonly LayerOption[],
): AskVocabulary {
    const schemaTypes = useSchemaStore((s) => s.schema?.entityTypes)
    const { discovery: result, tagValues, allKeys, getValueSamples } = discovery
    return useMemo(() => {
        const types = new Map<string, { id: string; name?: string; pluralName?: string }>(
            (schemaTypes ?? []).map((t) => [t.id, { id: t.id, name: t.name, pluralName: t.pluralName }]))
        for (const label of Object.keys(result?.labels ?? {})) if (!types.has(label)) types.set(label, { id: label })
        const valueSamples = allKeys.flatMap((key) => getValueSamples(key)
            .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number')
            .map((v) => ({ key, value: String(v) })))
        return buildAskVocabulary({
            entityTypes: [...types.values()], tagValues, propertyKeys: allKeys, valueSamples,
            layers: layers.map((l) => ({ value: l.value, label: l.label })),
        })
    }, [schemaTypes, result, tagValues, allKeys, getValueSamples, layers])
}
