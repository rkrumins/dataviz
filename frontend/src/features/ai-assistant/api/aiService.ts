/**
 * AI service — the assistant's calls to `/api/v1/ai/*`.
 *
 * Everything but the chat is plain JSON through `authFetch` (session cookies, CSRF, a readable
 * error carrying `status` and the body's `detail`). The chat is a stream of server-sent events,
 * read by `postEventStream`. Every call is `silent403`: a person without the assistant's
 * permission, or a deployment with it switched off, is told so in the panel, not in the app-wide
 * access dialog.
 */
import { authFetch } from '@/services/apiClient'
import { postEventStream, type SseFrame } from '../lib/sseStream'
import type {
    AiStatus, ChatRequest, Concept, Conversation, ConversationSummary, DraftRequest, DraftResponse,
} from './types'

const API = '/api/v1/ai'

const QUIET = { silent403: true } as const

function json(method: string, body: unknown) {
    return { ...QUIET, method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

/** The service's own code for a refusal or failure (`not_configured`, `missing_permission`…). */
export function aiErrorCode(err: unknown): string | null {
    const detail = (err as { detail?: unknown } | null)?.detail
    if (detail && typeof detail === 'object') {
        const d = detail as { code?: unknown; error?: unknown; type?: unknown }
        for (const v of [d.code, d.error, d.type]) if (typeof v === 'string' && v) return v
    }
    return null
}

export const aiService = {
    getStatus(): Promise<AiStatus> {
        return authFetch<AiStatus>(`${API}/status`, QUIET)
    },

    /** Stream one turn. `onFrame` sees every event in order; resolves once the stream ends. */
    streamChat(req: ChatRequest, opts: { onFrame: (frame: SseFrame) => void; signal?: AbortSignal }): Promise<void> {
        return postEventStream(`${API}/chat/stream`, req, opts)
    },

    listConversations(limit = 30): Promise<{ items: ConversationSummary[] }> {
        return authFetch(`${API}/conversations?limit=${limit}`, QUIET)
    },

    getConversation(id: string): Promise<Conversation> {
        return authFetch<Conversation>(`${API}/conversations/${encodeURIComponent(id)}`, QUIET)
    },

    deleteConversation(id: string): Promise<void> {
        return authFetch<void>(`${API}/conversations/${encodeURIComponent(id)}`, { ...QUIET, method: 'DELETE' })
    },

    sendFeedback(messageId: string, rating: 1 | -1, comment?: string): Promise<void> {
        return authFetch<void>(`${API}/messages/${encodeURIComponent(messageId)}/feedback`,
            json('POST', comment ? { rating, comment } : { rating }))
    },

    draftQuery(req: DraftRequest, signal?: AbortSignal): Promise<DraftResponse> {
        return authFetch<DraftResponse>(`${API}/query/draft`, { ...json('POST', req), signal, timeoutMs: 60_000 })
    },

    listConcepts(dataSourceId?: string): Promise<{ items: Concept[] }> {
        const qs = dataSourceId ? `?dataSourceId=${encodeURIComponent(dataSourceId)}` : ''
        return authFetch(`${API}/concepts${qs}`, QUIET)
    },

    deleteConcept(id: string): Promise<void> {
        return authFetch<void>(`${API}/concepts/${encodeURIComponent(id)}`, { ...QUIET, method: 'DELETE' })
    },
}
