/**
 * useCompiledQuery — the Cypher a draft compiles to (POST /search/explain),
 * asked with exactly the request a run sends (``searchRequest``): the
 * runnable predicate (incomplete rows left out, as a run leaves them),
 * the run's options, the current scope.
 *
 * Asked 400 ms after the draft settles; a newer draft, or leaving, cancels
 * the request in flight, so an old answer never lands over a new one. A
 * data source with no compiled query to show (only FalkorDB compiles one;
 * the server says 501) is ``unsupported`` — said once, not a spinner.
 */
import { useEffect, useMemo, useState } from 'react'

import { useGraphProviderIfAvailable } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { httpStatusOf } from '@/services/graphRequestFailure'
import { useSearchStore } from '@/store/searchStore'
import type { Predicate, SearchExplainResult } from '@/types/search'

import { SEARCH_OPTIONS } from '../../searchOptions'
import { buildSearchRequest } from '../../searchRequest'
import { readableSearchError } from '../errorPaths'
import { buildRunnablePredicate } from '../runnablePredicate'


export type CompiledQuery =
    | { status: 'empty' }
    | { status: 'compiling' }
    | { status: 'ok'; result: SearchExplainResult }
    | { status: 'unsupported' }
    | { status: 'error'; message: string }

const SETTLE_MS = 400


export function useCompiledQuery(draft: Predicate | null, viewId: string): CompiledQuery {
    const provider = useGraphProviderIfAvailable()
    const remote = provider instanceof RemoteGraphProvider ? provider : null
    const scopeMode = useSearchStore((s) => s.scopeMode)
    const runnable = useMemo(() => buildRunnablePredicate(draft), [draft])
    const key = remote && runnable && viewId ? `${viewId} ${scopeMode} ${runnable.hash}` : ''
    const [answer, setAnswer] = useState<{ key: string; value: CompiledQuery } | null>(null)

    useEffect(() => {
        if (!key || !remote || !runnable) return
        const controller = new AbortController()
        const timer = setTimeout(() => {
            remote.searchExplain(buildSearchRequest(runnable.predicate, SEARCH_OPTIONS, viewId),
                                 { signal: controller.signal })
                .then((result) => {
                    if (!controller.signal.aborted) setAnswer({ key, value: { status: 'ok', result } })
                })
                .catch((e: unknown) => {
                    if (controller.signal.aborted) return
                    setAnswer({
                        key,
                        value: httpStatusOf(e) === 501
                            ? { status: 'unsupported' }
                            : { status: 'error', message: readableSearchError(e instanceof Error ? e.message : String(e)) },
                    })
                })
        }, SETTLE_MS)
        return () => {
            clearTimeout(timer)
            controller.abort()
        }
        // ``key`` names everything the request is built from.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key])

    if (!remote) return { status: 'unsupported' }
    if (!runnable) return { status: 'empty' }
    return answer?.key === key ? answer.value : { status: 'compiling' }
}
