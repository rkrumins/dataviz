/**
 * ResultsAskBar — the Ask bar over an answer. With the builder folded
 * away, a new question is still one line away, applied and run at once.
 * It reads the view's words itself: the card that would otherwise hold
 * them isn't mounted.
 */
import { useCallback, useMemo } from 'react'

import { useSchemaStore } from '@/store/schema'
import { useDraftPredicate, useSearchStore } from '@/store/searchStore'
import type { Predicate, SearchQuery } from '@/types/search'

import { useDiscovery } from '../../builder/useDiscovery'
import { SEARCH_OPTIONS } from '../../searchOptions'
import { entityTypesInView, useViewLayerOptions } from '../layerOptions'
import { buildRunnablePredicate } from '../runnablePredicate'

import { AskBar } from './AskBar'
import { useAskVocabulary } from './useAskVocabulary'


export function ResultsAskBar({ viewId, onRun }: {
    viewId: string
    onRun: (predicate: Predicate, options?: SearchQuery['options']) => void
}) {
    const discovery = useDiscovery(viewId)
    const layers = useViewLayerOptions(discovery.getValueSamples)
    const vocabulary = useAskVocabulary(discovery, layers)
    const schemaTypes = useSchemaStore((s) => s.schema?.entityTypes)
    const presentTypes = useMemo(
        () => entityTypesInView(discovery.discovery?.labels, (schemaTypes ?? []).map((t) => t.id)),
        [discovery.discovery, schemaTypes],
    )
    const draft = useDraftPredicate()
    const commitDraft = useSearchStore((s) => s.commitDraft)
    const onAsk = useCallback((result: Predicate) => {
        commitDraft(result)
        const next = buildRunnablePredicate(result)
        if (next) onRun(next.predicate, SEARCH_OPTIONS)
    }, [commitDraft, onRun])

    return <AskBar viewId={viewId} vocabulary={vocabulary} draft={draft} onAsk={onAsk} presentTypes={presentTypes} />
}
