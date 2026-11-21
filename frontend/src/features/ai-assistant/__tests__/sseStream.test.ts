/**
 * The SSE reader: frames are cut out of whatever chunks the network delivers — split mid-frame,
 * mid-line, between `\r` and `\n`, inside a multi-byte character — comments are skipped, and a
 * stop ends the read wherever it is.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSseParser, isAbortError, postEventStream, readSseStream, type SseFrame } from '../lib/sseStream'

const enc = new TextEncoder()

/** A body that hands out `chunks` one read at a time — and, with `hold`, then waits forever. */
function bodyOf(chunks: Array<string | Uint8Array>, { hold = false } = {}): ReadableStream<Uint8Array> {
    let i = 0
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < chunks.length) {
                const c = chunks[i++]
                controller.enqueue(typeof c === 'string' ? enc.encode(c) : c)
            } else if (!hold) {
                controller.close()
            }
            // hold: never enqueue again — the read waits, as on a quiet connection.
            return hold && i >= chunks.length ? new Promise(() => {}) : undefined
        },
    })
}

async function framesOf(chunks: Array<string | Uint8Array>): Promise<SseFrame[]> {
    const out: SseFrame[] = []
    await readSseStream(bodyOf(chunks), (f) => out.push(f))
    return out
}

describe('the frame parser', () => {
    it('reads event and data, a frame per blank line', () => {
        const p = createSseParser()
        expect(p.push('event: meta\ndata: {"a":1}\n\nevent: text\ndata: {"delta":"Hi"}\n\n')).toEqual([
            { event: 'meta', data: '{"a":1}' },
            { event: 'text', data: '{"delta":"Hi"}' },
        ])
    })

    it('joins several data lines with a newline, and names an unnamed frame "message"', () => {
        const p = createSseParser()
        expect(p.push('data: one\ndata: two\n\n')).toEqual([{ event: 'message', data: 'one\ntwo' }])
    })

    it('skips comments — keep-alives — wherever they fall', () => {
        const p = createSseParser()
        expect(p.push(': keep-alive\n\nevent: step\n: still here\ndata: {}\n\n: keep-alive\n\n')).toEqual([
            { event: 'step', data: '{}' },
        ])
    })

    it('takes \\r\\n and lone \\r line ends too', () => {
        const p = createSseParser()
        // The last \r may be half of a \r\n still on its way: the frame ends once that is known.
        expect([...p.push('event: a\r\ndata: 1\r\n\r\nevent: b\rdata: 2\r\r'), ...p.flush()]).toEqual([
            { event: 'a', data: '1' }, { event: 'b', data: '2' },
        ])
    })

    it('keeps the value as written after one optional space', () => {
        const p = createSseParser()
        expect(p.push('data:no-space\n\ndata:  two-spaces\n\n')).toEqual([
            { event: 'message', data: 'no-space' }, { event: 'message', data: ' two-spaces' },
        ])
    })

    it('a frame with no data is nothing', () => {
        const p = createSseParser()
        expect(p.push('event: ping\n\n')).toEqual([])
    })

    it('flushes a last frame its sender did not end with a blank line', () => {
        const p = createSseParser()
        expect(p.push('event: done\ndata: {"status":"ok"}')).toEqual([])
        expect(p.flush()).toEqual([{ event: 'done', data: '{"status":"ok"}' }])
    })
})

describe('reading a stream', () => {
    it('reassembles frames split across chunks at any point', async () => {
        const whole = 'event: meta\ndata: {"conversationId":"c1"}\n\nevent: text\ndata: {"delta":"Hello"}\n\nevent: done\ndata: {"status":"ok"}\n\n'
        const expected = [
            { event: 'meta', data: '{"conversationId":"c1"}' },
            { event: 'text', data: '{"delta":"Hello"}' },
            { event: 'done', data: '{"status":"ok"}' },
        ]
        // Every split point, and one character per chunk.
        for (let at = 1; at < whole.length; at++) {
            expect(await framesOf([whole.slice(0, at), whole.slice(at)])).toEqual(expected)
        }
        expect(await framesOf(whole.split(''))).toEqual(expected)
    })

    it('does not split a \\r\\n that arrives in two chunks into two line ends', async () => {
        expect(await framesOf(['event: a\r', '\ndata: 1\r', '\n\r', '\n'])).toEqual([{ event: 'a', data: '1' }])
    })

    it('decodes a multi-byte character split between chunks', async () => {
        const bytes = enc.encode('data: {"delta":"naïve — ✓"}\n\n')
        const cut = bytes.indexOf(0xc3) + 1 // inside "ï"
        expect(await framesOf([bytes.slice(0, cut), bytes.slice(cut)])).toEqual([
            { event: 'message', data: '{"delta":"naïve — ✓"}' },
        ])
    })

    it('stops when the signal aborts, mid-read, with an AbortError', async () => {
        const controller = new AbortController()
        const seen: SseFrame[] = []
        const reading = readSseStream(bodyOf(['event: text\ndata: {"delta":"a"}\n\n'], { hold: true }),
            (f) => seen.push(f), controller.signal)
        await vi.waitFor(() => expect(seen).toHaveLength(1))
        controller.abort()
        const err = await reading.catch((e) => e)
        expect(isAbortError(err)).toBe(true)
    })

    it('refuses to start on a signal already aborted', async () => {
        const controller = new AbortController()
        controller.abort()
        const err = await readSseStream(bodyOf([]), () => {}, controller.signal).catch((e) => e)
        expect(isAbortError(err)).toBe(true)
    })
})

describe('postEventStream', () => {
    const realFetch = globalThis.fetch
    afterEach(() => { globalThis.fetch = realFetch })

    it('POSTs JSON asking for an event stream, and reads the answer', async () => {
        const fetchMock = vi.fn(async () => new Response(bodyOf(['event: done\ndata: {"status":"ok"}\n\n']), {
            status: 200, headers: { 'Content-Type': 'text/event-stream' },
        }))
        globalThis.fetch = fetchMock as unknown as typeof fetch
        const frames: SseFrame[] = []
        await postEventStream('/api/v1/ai/chat/stream', { message: 'hi' }, { onFrame: (f) => frames.push(f) })
        expect(frames).toEqual([{ event: 'done', data: '{"status":"ok"}' }])
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
        expect(url).toBe('/api/v1/ai/chat/stream')
        expect(init.method).toBe('POST')
        expect(init.body).toBe('{"message":"hi"}')
        expect(new Headers(init.headers).get('Accept')).toBe('text/event-stream')
        expect(init.credentials).toBe('include')
    })

    it('throws a refusal as a readable error carrying its status and detail', async () => {
        globalThis.fetch = vi.fn(async () => new Response(
            JSON.stringify({ detail: { code: 'not_configured', message: 'No AI model is connected.' } }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
        )) as unknown as typeof fetch
        const err = await postEventStream('/api/v1/ai/chat/stream', {}, { onFrame: () => {} }).catch((e) => e)
        expect(err).toBeInstanceOf(Error)
        expect(err.message).toBe('No AI model is connected.')
        expect(err.status).toBe(409)
        expect(err.detail).toEqual({ code: 'not_configured', message: 'No AI model is connected.' })
    })

    it('reports a stop before the answer starts as an abort, not a timeout', async () => {
        const controller = new AbortController()
        const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }))
        globalThis.fetch = fetchMock as unknown as typeof fetch
        const pending = postEventStream('/x', {}, { onFrame: () => {}, signal: controller.signal })
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
        controller.abort()
        expect(isAbortError(await pending.catch((e) => e))).toBe(true)
    })
})
