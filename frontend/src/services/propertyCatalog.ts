/**
 * propertyCatalog — every property a view's entities carry, exactly.
 *
 * The server reads every entity in the view's scope (``POST
 * /search/catalog``), a slice of the scan per request. This follows it to
 * the end, reporting each answer as it lands, so the Properties tab shows
 * what has been read so far and how far through the view it is. Once
 * complete, the server keeps the catalog and answers at once — until the
 * data changes, and for a while after (marked ``stale``, with ``asOf``).
 */
import type { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { SearchCatalogResult } from '@/types/search'


/** How long each request lets the server read before answering. */
const WAIT_MS = 800

/** A backstop, not a budget: at about a second a request, a quarter hour. */
const MAX_REQUESTS = 900


/**
 * Follow the catalog of ``viewId`` to completion, calling ``onUpdate`` with
 * every answer. ``refresh`` reads the view again rather than taking the
 * catalog the server has at hand. ``valuesFor`` lists every value the
 * catalog keeps for that one key (up to 1,000), not only the 20 most held.
 * Rejects when aborted or a request fails.
 */
export async function followCatalog(
    provider: RemoteGraphProvider,
    viewId: string,
    opts: {
        signal?: AbortSignal
        refresh?: boolean
        valuesFor?: string
        onUpdate?: (catalog: SearchCatalogResult) => void
    } = {},
): Promise<SearchCatalogResult> {
    let sessionId: string | undefined
    for (let request = 0; request < MAX_REQUESTS; request++) {
        const answer = await provider.searchCatalog({
            scope: { viewId, scopeMode: 'view' },
            waitMs: WAIT_MS,
            ...(sessionId ? { sessionId } : {}),
            ...(opts.refresh && request === 0 ? { refresh: true } : {}),
            ...(opts.valuesFor ? { valuesFor: opts.valuesFor } : {}),
        }, { signal: opts.signal })
        opts.onUpdate?.(answer)
        if (answer.status === 'complete') return answer
        sessionId = answer.sessionId
    }
    throw new Error(`still reading the view after ${MAX_REQUESTS} requests`)
}
