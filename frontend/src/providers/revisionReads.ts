/**
 * What a past revision of Published reads (`?asOfSeq=`), and the refusal of everything else.
 *
 * The server answers a revision only on the routes its revision gate lists, and refuses every
 * other one (501 `revision_unsupported`, 409 for a write): they would answer from the graph as it
 * is now. The client refuses the same routes before sending them, so a canvas at a revision sends
 * no request that fails. `backend/tests/fixtures/revision_reads.txt` is the list; a test on each
 * side holds its own to it (`test_revision_gate.py`, `revisionReads.test.ts`).
 *
 * Search at a revision is a name search: the header's quick query on names, sent to
 * `/search/names` (exact as the graph was) and answered as a finished, hits-only page.
 */
import type { ApiStatusError } from '@/services/graphRequestFailure'
import type { SearchHit, SearchQuery, SearchResultPage } from '@/types/search'

/** The graph routes a revision reads, relative to `/graph`, a path parameter as `{urn}`. */
export const REVISION_READS: ReadonlyArray<string> = [
    'GET /edges',
    'GET /map/{urn}',
    'GET /nodes',
    'GET /nodes/top-level',
    'GET /nodes/{urn}',
    'GET /nodes/{urn}/ancestors',
    'GET /nodes/{urn}/children',
    'GET /nodes/{urn}/children-with-edges',
    'POST /assignments/compute',
    'POST /canvas/bootstrap',
    'POST /canvas/expand',
    'POST /edges/aggregated',
    'POST /edges/beneath',
    'POST /edges/between',
    'POST /edges/query',
    'POST /nodes/ancestor-chains',
    'POST /nodes/degree',
    'POST /nodes/page',
    'POST /nodes/query',
    'POST /search/names',
    'POST /trace/closure',
]

const escape = (text: string) => text.replace(/[.*+?^$()|[\]\\]/g, '\\$&')

const MATCHERS = REVISION_READS.map((entry) => {
    const [method, path] = entry.split(' ')
    return { method, re: new RegExp(`^${path.split('{urn}').map(escape).join('[^/]+')}$`) }
})

/** Whether a revision answers this read (`path` relative to `/graph`, a query string allowed). */
export function readsAtRevision(method: string, path: string): boolean {
    const m = method.toUpperCase()
    const p = path.split('?')[0]
    return MATCHERS.some((x) => x.method === m && x.re.test(p))
}

/** The server's refusal of a read a revision can't answer, made here instead of sent. */
export function revisionRefusal(path: string): ApiStatusError {
    return Object.assign(
        new Error(`API Error 501: ${path.split('?')[0]} reads the graph as it is now, not as it was at this revision`),
        { status: 501, code: 'revision_unsupported' },
    )
}

/** A page of `/search/names`. */
export interface NameSearchPage {
    hits: SearchHit[]
    hasMore: boolean
    nextOffset: number
}

/** What `/search/names` takes. */
export interface NameSearchRequest {
    q: string
    match: 'substring' | 'prefix' | 'suffix' | 'exact'
    entityTypes?: string[]
    limit: number
    offset: number
}

/** The most a page of a name search holds (the server's own bound). */
export const NAME_SEARCH_PAGE = 50
const CURSOR = 'names:'
const MATCHES = new Set(['substring', 'prefix', 'suffix', 'exact'])

/**
 * The name search a search query is: one text leaf on names — the header's quick query in names
 * mode — matched by substring, prefix, suffix or exact, ignoring case. Null for anything else: a
 * condition on anything but a name, or inside a container, can't be answered as it was.
 */
export function nameSearchOf(query: SearchQuery): NameSearchRequest | null {
    const leaf = query.predicate as {
        kind?: string; target?: string; value?: string; match?: string; caseSensitive?: boolean
    }
    if (leaf?.kind !== 'text' || leaf.target !== 'name' || !leaf.value?.trim()) return null
    const match = leaf.match ?? 'substring'
    if (!MATCHES.has(match) || leaf.caseSensitive) return null
    const cursor = query.options?.cursor
    const offset = cursor?.startsWith(CURSOR) ? Number(cursor.slice(CURSOR.length)) || 0 : 0
    return {
        q: leaf.value.trim(),
        match: match as NameSearchRequest['match'],
        limit: Math.min(NAME_SEARCH_PAGE, query.options?.pageSize ?? NAME_SEARCH_PAGE),
        offset,
    }
}

/** A name search's page, read from ``offset``, as a search page: hits only, finished, and its next
 *  page by cursor. The total is known once the last page is read. */
export function toSearchResultPage(page: NameSearchPage, offset: number, elapsedMs: number): SearchResultPage {
    return {
        hits: page.hits,
        cursor: page.hasMore ? `${CURSOR}${page.nextOffset}` : null,
        truncated: page.hasMore,
        candidateCount: page.hits.length,
        totalCount: page.hasMore ? null : offset + page.hits.length,
        deadlineExceeded: false,
        elapsedMs,
        cacheHit: false,
        status: 'complete',
    } as SearchResultPage
}
