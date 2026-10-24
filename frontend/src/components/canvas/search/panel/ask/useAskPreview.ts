/**
 * useAskPreview — what a question reads as, while it is typed: the query,
 * the entities its names point at (looked up in the view, a moment after
 * typing stops) and roughly how many it matches.
 */
import { useEffect, useMemo, useState } from 'react'

import { useGraphProviderIfAvailable } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { Predicate, SearchRefResolution } from '@/types/search'

import { requestPredicate } from '../../searchRequest'
import { countId } from '../counts/clauseItems'
import { whyUncountable } from '../counts/countable'
import { useCounts, type CountsStatus, type CountState } from '../counts/useCounts'
import { appendCondition } from '../predicateComposition'

import type { AskVocabulary } from './askVocabulary'
import { interpretQuestion, type AskName, type AskPicks, type Interpretation } from './interpretQuestion'


/** An entity a name was found to name, with its containers. */
export type NameMatch = NonNullable<SearchRefResolution['matches']>[number]

/** How a name the question points at was found in the view. */
export type NameLookup =
    | { status: 'looking' }
    | { status: 'found'; matches: NameMatch[] }
    | { status: 'several'; count: number; matches: NameMatch[] }
    | { status: 'none' }
    /** Not looked up: no server to ask, or it wouldn't say. */
    | { status: 'unknown' }

export interface AskPreview {
    interpretation: Interpretation
    /** The query the question leaves: itself, or added to the draft. */
    result: Predicate | null
    lookups: ReadonlyMap<string, NameLookup>
    count: CountState | null
    countStatus: CountsStatus
}

const LOOKUP_DELAY_MS = 300


function useNameLookups(viewId: string | null, names: AskName[]): ReadonlyMap<string, NameLookup> {
    const provider = useGraphProviderIfAvailable()
    const remote = provider instanceof RemoteGraphProvider ? provider : null
    const key = JSON.stringify(names.map((n) => n.ref))
    const [found, setFound] = useState<{ key: string; lookups: Map<string, NameLookup> } | null>(null)

    useEffect(() => {
        if (!remote || !viewId || names.length === 0) return
        const controller = new AbortController()
        const t = setTimeout(() => {
            remote.resolveSearchRefs({ scope: { viewId }, refs: names.map((n) => n.ref) }, { signal: controller.signal })
                .then(({ results }) => {
                    const lookups = new Map<string, NameLookup>()
                    names.forEach((n, i) => {
                        const r = results[i]
                        const matches = r?.matches ?? []
                        lookups.set(n.text, !r || r.error ? { status: 'unknown' }
                            : r.count === 0 ? { status: 'none' }
                                : r.count === 1 ? { status: 'found', matches }
                                    : { status: 'several', count: r.count, matches })
                    })
                    setFound({ key, lookups })
                })
                .catch(() => {
                    if (!controller.signal.aborted) {
                        setFound({ key, lookups: new Map(names.map((n) => [n.text, { status: 'unknown' }])) })
                    }
                })
        }, LOOKUP_DELAY_MS)
        return () => { clearTimeout(t); controller.abort() }
        // ``key`` stands for ``names``: the same refs, the same lookup.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [remote, viewId, key])

    return useMemo(() => {
        if (found?.key === key) return found.lookups
        const status: NameLookup = remote && viewId ? { status: 'looking' } : { status: 'unknown' }
        return new Map(names.map((n) => [n.text, status]))
    }, [found, key, names, remote, viewId])
}


export function useAskPreview(viewId: string | null, question: string, vocabulary: AskVocabulary,
    picks: AskPicks, draft: Predicate | null): AskPreview {
    const interpretation = useMemo(() => interpretQuestion(question, vocabulary, picks),
        [question, vocabulary, picks])
    const result = useMemo(() => {
        const p = interpretation.predicate
        if (!p) return null
        return interpretation.mode === 'add' ? appendCondition(draft, p) : p
    }, [interpretation, draft])
    const lookups = useNameLookups(viewId, interpretation.names)

    const items = useMemo(() => (result && !whyUncountable(result)
        ? [{ id: countId(result), predicate: requestPredicate(result) }] : []), [result])
    const { counts, status } = useCounts(viewId, items, { rough: true, debounceMs: 400 })
    const count = items.length ? counts.get(items[0].id) ?? null : null

    return { interpretation, result, lookups, count, countStatus: status }
}
