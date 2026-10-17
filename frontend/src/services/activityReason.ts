/**
 * The reason a person gives for a change, carried with the request.
 *
 * It rides in a header rather than in each body, so every mutating endpoint
 * takes one without a schema change: the server binds it to the request,
 * every activity record the change writes carries it, and an aggregation run
 * keeps it on the job. Percent-encoded, because a header is Latin-1 and a
 * reason may not be; the server decodes it, strips control characters and
 * keeps at most 500 characters.
 */
export const REASON_HEADER = 'X-Activity-Reason'
export const REASON_MAX_LENGTH = 500

/** What a mutating call can carry besides its body. */
export interface ActivityOpts {
    /** Why the person is doing this, in their words. Never required. */
    reason?: string
}

const READS = new Set(['GET', 'HEAD', 'OPTIONS'])
// A lone surrogate (half of a pasted emoji) would make encodeURIComponent
// throw, failing the change itself over its optional note.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** `init` with the reason attached; unchanged when there is none, or for a read. */
export function withReason(init: RequestInit, reason?: string | null): RequestInit {
    const text = Array.from((reason ?? '').trim().replace(LONE_SURROGATE, '�'))
        .slice(0, REASON_MAX_LENGTH).join('')
    if (!text || READS.has((init.method ?? 'GET').toUpperCase())) return init
    const headers = new Headers(init.headers)
    headers.set(REASON_HEADER, encodeURIComponent(text))
    return { ...init, headers }
}
