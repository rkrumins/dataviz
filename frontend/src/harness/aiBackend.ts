/**
 * The AI harness's in-memory service: it takes the place of `window.fetch` for `/api/v1/ai/*`
 * and answers from a fixture — the status, the conversations, and the chat as a real stream of
 * server-sent events, a frame at a time, so the rail renders exactly as it would against the
 * service. Anything else under `/api` is a 404: the harness has no backend.
 */
import { AI_FIXTURES, DEFAULT_STATUS, type AiFixture, type ScriptFrame } from './aiFixtures'

const enc = new TextEncoder()
const json = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const sseFrame = (f: ScriptFrame) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`

/** A stream of `frames`, `delayMs` apart; with `holdAfter`, left open after that many. */
function eventStream(frames: ScriptFrame[], delayMs: number, holdAfter?: number, signal?: AbortSignal | null): Response {
    let i = 0
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (holdAfter !== undefined && i >= Math.min(holdAfter, frames.length)) return new Promise<void>(() => {})
            if (i >= frames.length) { controller.close(); return }
            await new Promise((r) => setTimeout(r, delayMs))
            if (signal?.aborted) { controller.error(new DOMException('aborted', 'AbortError')); return }
            controller.enqueue(enc.encode(sseFrame(frames[i++])))
            // A keep-alive now and then, as the service sends them.
            if (i % 5 === 0) controller.enqueue(enc.encode(': keep-alive\n\n'))
        },
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

const GENERIC: ScriptFrame[] = [
    { event: 'meta', data: { conversationId: 'conv_h1', messageId: 'msg_h2', persona: 'data', contractVersion: 1 } },
    { event: 'step', data: { id: 'g1', label: 'Reading the question', status: 'done' } },
    { event: 'text', data: { delta: 'This is the harness, so there is no model behind it — ' } },
    { event: 'text', data: { delta: 'every fixture answers one question. Pick another with `?fixture=`.' } },
    { event: 'done', data: { status: 'ok' } },
]

const CONVERSATIONS = [
    { id: 'conv_h1', title: 'What breaks if first_name is dropped?', persona: 'data', updatedAt: new Date(Date.now() - 4 * 60_000).toISOString(), messageCount: 2 },
    { id: 'conv_h2', title: 'PII updated last week', persona: 'data', updatedAt: new Date(Date.now() - 3 * 3600_000).toISOString(), messageCount: 6 },
    { id: 'conv_h3', title: 'How do I share a view?', persona: 'help', updatedAt: new Date(Date.now() - 2 * 86400_000).toISOString(), messageCount: 2 },
]

const CONCEPTS = [
    { id: 'cpt_1', concept: 'PII', label: 'Tag “pii”', scope: 'personal', predicate: { kind: 'tag', op: 'hasAny', values: ['pii'] }, uses: 4, updatedAt: '2026-11-20T10:00:00Z' },
    { id: 'cpt_2', concept: 'owner', label: 'the data_owner property', scope: 'workspace', predicate: { kind: 'property', key: 'data_owner', op: 'exists' }, uses: 12, updatedAt: '2026-11-01T10:00:00Z' },
]

export function installAiBackend(fixture: AiFixture, { frameDelayMs = 40 } = {}): void {
    const realFetch = window.fetch.bind(window)
    let asked = 0
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin)
        const path = url.pathname
        if (!path.startsWith('/api/')) return realFetch(input, init)
        const method = (init?.method ?? 'GET').toUpperCase()

        if (path === '/api/v1/ai/status') return json(fixture.status ?? DEFAULT_STATUS)
        if (path === '/api/v1/ai/chat/stream' && method === 'POST') {
            const body = JSON.parse(String(init?.body ?? '{}')) as { clarification?: unknown }
            asked += 1
            if (body.clarification && fixture.afterClarify) return eventStream(fixture.afterClarify, frameDelayMs, undefined, init?.signal)
            if (asked === 1 && fixture.frames) return eventStream(fixture.frames, frameDelayMs, fixture.holdAfter, init?.signal)
            return eventStream(GENERIC, frameDelayMs, undefined, init?.signal)
        }
        if (path === '/api/v1/ai/conversations') return json({ items: CONVERSATIONS })
        const conv = /^\/api\/v1\/ai\/conversations\/([^/]+)$/.exec(path)
        if (conv && method === 'DELETE') return json(null, 204)
        if (conv) {
            const f = Object.values(AI_FIXTURES).find((x) => x.question) ?? fixture
            return json({ id: conv[1], title: f.question, persona: 'data', messages: [
                { id: 'm1', role: 'user', content: f.question },
                { id: 'm2', role: 'assistant', content: 'From the stored conversation.', blocks: [], steps: [], followups: [], status: 'ok', feedback: null },
            ] })
        }
        if (/^\/api\/v1\/ai\/messages\/[^/]+\/feedback$/.test(path)) return json(null, 204)
        if (path === '/api/v1/ai/concepts') return json({ items: CONCEPTS })
        if (/^\/api\/v1\/ai\/concepts\/[^/]+$/.test(path) && method === 'DELETE') return json(null, 204)
        return json({ detail: 'Not in the harness' }, 404)
    }
}
