/**
 * errorPaths — where in the query a server message points, in the panel's
 * words. The server names a position by its JSON path
 * (``$.children[1].where``); people read "filter 2 › its condition".
 */

const SEGMENT = /\.([A-Za-z]+)(?:\[(\d+)\])?/g
/** A path standing as a word of its own: ``$``, then any segments. */
const PATH = /(^|[\s(])\$((?:\.[A-Za-z]+(?:\[\d+\])?)*)(?=[\s:,.;)]|$)/g

const WORDS: Record<string, string> = {
    where: 'its condition',
    sourceWhere: 'where it starts',
    targetWhere: 'where it ends',
    edge: 'its edge filter',
    edgePredicate: 'its edge filter',
}


/** One path, read as a position: "filter 2 › its condition". */
export function describeQueryPath(path: string): string {
    const parts: string[] = []
    for (const [, name, index] of path.matchAll(SEGMENT)) {
        const n = index === undefined ? null : Number(index) + 1
        if (name === 'predicate') continue
        if (name === 'children') parts.push(`${parts.length ? 'condition' : 'filter'} ${n}`)
        else if (name === 'items') parts.push(`rule ${n}`)
        else if (name === 'refs') parts.push(`name ${n}`)
        else if (name === 'sourceRefs') parts.push('where it starts', `name ${n}`)
        else if (name === 'targetRefs') parts.push('where it ends', `name ${n}`)
        else parts.push(WORDS[name] ?? (n === null ? name : `${name} ${n}`))
    }
    return parts.length ? parts.join(' › ') : 'the query'
}


/** ``message`` with each query path in it read as a position. */
export function humanizeQueryPaths(message: string): string {
    return message.replace(PATH, (_, lead: string, path: string) => lead + describeQueryPath(path))
}


/** A failed request reads ``API Error <status>: <body>`` (``toApiStatusError``). */
const API_ERROR = /^API Error (\d{3}): ([\s\S]*)$/

/** When the body says nothing a person can use. */
const STATUS_WORDS: Record<number, string> = {
    401: 'Your session has ended. Sign in again.',
    403: "You don't have access to do that.",
    404: "That couldn't be found.",
    408: 'The request took too long.',
    429: 'Too many requests. Try again in a moment.',
}

/** A FastAPI validation entry: where (``["body", "predicate", "children", 0]``)
 *  and what. */
interface FieldError { loc?: unknown[]; msg?: unknown }

function fieldErrorText(e: FieldError): string {
    const msg = typeof e.msg === 'string' ? e.msg : 'is not valid'
    const loc = (e.loc ?? []).filter((part, i) => !(i === 0 && (part === 'body' || part === 'query')))
    if (loc.length === 0) return msg
    // Back into the server's own path notation, which reads as a position.
    const path = '$' + loc.map((part) => typeof part === 'number' ? `[${part}]` : `.${String(part)}`).join('')
    return `${describeQueryPath(path)}: ${msg}`
}

/** What the response body says, or null when it says nothing readable. */
function bodyText(body: string): string | null {
    let parsed: unknown
    try {
        parsed = JSON.parse(body)
    } catch {
        // Plain text is the message; an HTML error page is not.
        const text = body.trim()
        return text && !text.startsWith('<') ? text : null
    }
    const detail = (parsed as { detail?: unknown } | null)?.detail ?? parsed
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail)) {
        const parts = detail.filter((e) => e && typeof e === 'object').map((e) => fieldErrorText(e as FieldError))
        return parts.length ? parts.join('; ') : null
    }
    if (detail && typeof detail === 'object') {
        const message = (detail as { message?: unknown }).message
        if (typeof message === 'string' && message) return message
    }
    return null
}

/** A search error as a person should read it: the server's own words
 *  without the ``API Error 400: {"detail": …}`` wrapping, and every query
 *  path in them named as a position in the query. */
export function readableSearchError(message: string): string {
    const match = API_ERROR.exec(message)
    if (!match) return humanizeQueryPaths(message)
    const status = Number(match[1])
    const text = bodyText(match[2])
        ?? STATUS_WORDS[status]
        ?? (status >= 500 ? "The server couldn't answer right now. Try again." : `The request failed (${status}).`)
    return humanizeQueryPaths(text)
}
