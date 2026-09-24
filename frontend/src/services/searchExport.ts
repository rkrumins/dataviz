/**
 * searchExport — every match of a search, written to a file on the server.
 *
 * The server reads the matches a slice of the scan per request (``POST
 * /search/exports``), writing them as it goes. This follows the export to
 * the end, reporting each answer as it lands, so the dialog shows how many
 * rows are written and how far through the view it is. The answer that
 * completes it carries a download token: the file downloads from
 * ``RemoteGraphProvider.searchExportDownloadUrl`` for an hour, for whoever
 * ran the export.
 */
import type { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import type { SearchExportRequest, SearchExportResult } from '@/types/search'


/** How long each request lets the server write before answering. */
const WAIT_MS = 2_000

/** A backstop, not a budget: at two seconds a request, two hours. */
const MAX_REQUESTS = 3_600


/**
 * Follow the export of ``request`` (without its session) to completion,
 * calling ``onUpdate`` with every answer. Rejects when aborted or a
 * request fails.
 */
export async function followExport(
    provider: RemoteGraphProvider,
    request: Omit<SearchExportRequest, 'sessionId' | 'waitMs'>,
    opts: {
        signal?: AbortSignal
        onUpdate?: (answer: SearchExportResult) => void
    } = {},
): Promise<SearchExportResult> {
    let sessionId: string | undefined
    for (let n = 0; n < MAX_REQUESTS; n++) {
        const answer = await provider.searchExport({
            ...request,
            waitMs: WAIT_MS,
            ...(sessionId ? { sessionId } : {}),
        }, { signal: opts.signal })
        opts.onUpdate?.(answer)
        if (answer.status === 'complete') return answer
        sessionId = answer.sessionId
    }
    throw new Error(`still exporting after ${MAX_REQUESTS} requests`)
}
