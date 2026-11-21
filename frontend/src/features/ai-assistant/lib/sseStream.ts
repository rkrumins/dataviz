/**
 * Server-sent events over a POST — the one streaming read in the app.
 *
 * `EventSource` cannot be used: it only GETs, and it cannot send the CSRF header a write needs.
 * So the request goes through `fetchWithTimeout` like every other call (session cookies, CSRF,
 * the silent refresh on a 401) and its body is read as it arrives, `res.body.getReader()` through
 * a `TextDecoder`, cut into frames by the parser below.
 *
 * The parser follows the SSE format: a frame is `field: value` lines ended by a blank line;
 * `event:` names it, `data:` lines join with a newline, a line starting with `:` is a comment
 * (a keep-alive) and is skipped. Lines may end `\n`, `\r\n` or `\r`, and a frame — or a line, or
 * a multi-byte character — may arrive split across any number of chunks.
 *
 * Aborting the signal stops the read wherever it is and rejects with an `AbortError`.
 */
import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { extractErrorMessageFromText } from '@/lib/errorMessage'

export interface SseFrame {
    /** The frame's `event:` — `message` when it named none. */
    event: string
    /** Its `data:` lines, joined with `\n`. */
    data: string
    id?: string
}

export interface SseParser {
    /** Feed decoded text; returns every frame it completed. */
    push: (text: string) => SseFrame[]
    /** The stream ended: a last frame its sender didn't close with a blank line still counts. */
    flush: () => SseFrame[]
}

export function createSseParser(): SseParser {
    let buffer = ''
    let event = ''
    let data: string[] = []
    let id: string | undefined

    const dispatch = (out: SseFrame[]) => {
        if (data.length > 0) out.push({ event: event || 'message', data: data.join('\n'), ...(id !== undefined ? { id } : {}) })
        event = ''
        data = []
    }

    const line = (text: string, out: SseFrame[]) => {
        if (text === '') { dispatch(out); return }
        if (text.startsWith(':')) return
        const colon = text.indexOf(':')
        const field = colon === -1 ? text : text.slice(0, colon)
        let value = colon === -1 ? '' : text.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'event') event = value
        else if (field === 'data') data.push(value)
        else if (field === 'id') id = value
        // `retry` and anything else: nothing to do here.
    }

    return {
        push(text) {
            buffer += text
            const out: SseFrame[] = []
            for (;;) {
                const m = /\r\n|\r|\n/.exec(buffer)
                if (!m) break
                // A `\r` that ends the buffer may be the first half of `\r\n`: wait for the next chunk.
                if (m[0] === '\r' && m.index === buffer.length - 1) break
                const text = buffer.slice(0, m.index)
                buffer = buffer.slice(m.index + m[0].length)
                line(text, out)
            }
            return out
        },
        flush() {
            const out: SseFrame[] = []
            if (buffer !== '') {
                line(buffer.replace(/\r$/, ''), out)
                buffer = ''
            }
            dispatch(out)
            return out
        },
    }
}

const abortError = () => new DOMException('The stream was stopped.', 'AbortError')

/** The read was stopped on purpose (the signal), not broken. */
export function isAbortError(e: unknown): boolean {
    return e instanceof DOMException && e.name === 'AbortError'
}

/** Read a response body as server-sent events, calling `onFrame` for each, in order. */
export async function readSseStream(
    body: ReadableStream<Uint8Array>,
    onFrame: (frame: SseFrame) => void,
    signal?: AbortSignal,
): Promise<void> {
    if (signal?.aborted) throw abortError()
    const reader = body.getReader()
    const decoder = new TextDecoder()
    const parser = createSseParser()
    // Cancelling the reader settles a read that is waiting on the network, whatever the stream
    // underneath does with the fetch's own signal.
    const stop = () => { void reader.cancel().catch(() => {}) }
    signal?.addEventListener('abort', stop)
    try {
        for (;;) {
            let chunk: ReadableStreamReadResult<Uint8Array>
            try {
                chunk = await reader.read()
            } catch (e) {
                if (signal?.aborted) throw abortError()
                throw e
            }
            if (signal?.aborted) throw abortError()
            if (chunk.done) break
            for (const frame of parser.push(decoder.decode(chunk.value, { stream: true }))) onFrame(frame)
        }
        for (const frame of parser.push(decoder.decode())) onFrame(frame)
        for (const frame of parser.flush()) onFrame(frame)
    } finally {
        signal?.removeEventListener('abort', stop)
        reader.releaseLock?.()
    }
}

/**
 * POST `body` as JSON and read the answer as server-sent events. A refusal (any non-2xx) throws
 * the same shape `authFetch` does — a readable message, with `status` and the body's `detail` on
 * the error — so a caller can tell a missing permission from a busy server.
 */
export async function postEventStream(
    url: string,
    body: unknown,
    { onFrame, signal, timeoutMs = 60_000 }: {
        onFrame: (frame: SseFrame) => void
        signal?: AbortSignal
        /** How long to wait for the answer to START; the stream itself may run longer. */
        timeoutMs?: number
    },
): Promise<void> {
    let res: Response
    try {
        res = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
            body: JSON.stringify(body),
            signal,
            timeoutMs,
            // A refusal is told in the panel, not in the app-wide access dialog.
            silent403: true,
        })
    } catch (e) {
        // fetchWithTimeout reports any abort as a timeout; a stop asked for is not one.
        if (signal?.aborted) throw abortError()
        throw e
    }
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        let detail: unknown
        try { detail = (JSON.parse(text) as { detail?: unknown }).detail } catch { /* not JSON */ }
        throw Object.assign(new Error(extractErrorMessageFromText(text, res.statusText || `Request failed: ${res.status}`)),
            { status: res.status, detail })
    }
    if (!res.body) throw new Error('The answer arrived without a body to read.')
    await readSseStream(res.body, onFrame, signal)
}
