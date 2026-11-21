/**
 * The chat, outside React: one turn at a time — the question goes on screen, the answer streams
 * in beneath it, and Stop ends it where it is. Kept out of the rail so folding the rail away
 * neither stops an answer nor loses the conversation.
 *
 * Frames are applied in batches (every frame one network chunk carried, in one store update),
 * so a fast stream re-renders the answer once per chunk, not once per word.
 */
import { queryClient } from '@/lib/queryClient'
import { aiErrorCode, aiService } from '../api/aiService'
import { AI_CONVERSATIONS_KEY, aiConversationKey } from '../api/aiQueries'
import type { AssistantPersona, ChatContext, ClarificationAnswer, Conversation } from '../api/types'
import { useAssistantStore } from '../store/assistantStore'
import { isAbortError, type SseFrame } from './sseStream'
import {
    applyFrame, emptyAssistantTurn, endTurn, localId, markClarified, turnsFromConversation, type AssistantTurn,
} from './transcript'

let inFlight: AbortController | null = null

export function isStreaming(): boolean {
    return inFlight !== null
}

export interface SendInput {
    message: string
    persona: AssistantPersona
    context: ChatContext
    /** Answering a clarification instead of asking anew. */
    clarification?: ClarificationAnswer & { label?: string; turnId?: string }
}

export async function sendMessage(input: SendInput): Promise<void> {
    if (inFlight) return
    const store = useAssistantStore.getState()
    const text = input.message.trim()
    if (!text && !input.clarification) return

    if (input.clarification?.turnId) {
        const { turnId, id, optionId } = input.clarification
        store.updateTurn(turnId, (t) => markClarified(t, id, optionId))
    }
    const answer = emptyAssistantTurn()
    store.appendTurns({ role: 'user', id: localId('q'), text: text || input.clarification?.label || '' }, answer)

    const controller = new AbortController()
    inFlight = controller
    const pending: SseFrame[] = []
    let scheduled = false
    const flush = () => {
        scheduled = false
        if (pending.length === 0) return
        const frames = pending.splice(0)
        for (const f of frames) {
            // A stopped turn (or one left for a new chat) names no conversation any more.
            if (f.event !== 'meta' || controller.signal.aborted) continue
            try {
                const id = (JSON.parse(f.data) as { conversationId?: unknown }).conversationId
                if (typeof id === 'string' && useAssistantStore.getState().conversationId !== id) {
                    useAssistantStore.getState().setConversationId(id)
                }
            } catch { /* a malformed meta names nothing */ }
        }
        useAssistantStore.getState().updateTurn(answer.id, (t) => frames.reduce(applyFrame, t))
    }
    const end = (how: Parameters<typeof endTurn>[1]) => useAssistantStore.getState().updateTurn(answer.id, (t) => endTurn(t, how))

    try {
        const { conversationId } = useAssistantStore.getState()
        await aiService.streamChat({
            ...(conversationId ? { conversationId } : {}),
            message: text,
            persona: input.persona,
            context: input.context,
            ...(input.clarification ? {
                clarification: { id: input.clarification.id, optionId: input.clarification.optionId, remember: input.clarification.remember },
            } : {}),
        }, {
            signal: controller.signal,
            onFrame: (frame) => {
                pending.push(frame)
                if (!scheduled) { scheduled = true; queueMicrotask(flush) }
            },
        })
        flush()
        end({ code: 'interrupted', message: 'The answer stopped before it finished.' })
    } catch (e) {
        flush()
        if (isAbortError(e)) end('stopped')
        else end({ code: aiErrorCode(e) ?? 'request_failed', message: e instanceof Error ? e.message : String(e) })
    } finally {
        if (inFlight === controller) inFlight = null
        void queryClient.invalidateQueries({ queryKey: AI_CONVERSATIONS_KEY })
    }
}

/** Stop the answer streaming now; what it said so far stays. */
export function stopStreaming(): void {
    inFlight?.abort()
}

/** A new conversation: stops any answer, clears the screen. */
export function startNewChat(): void {
    stopStreaming()
    useAssistantStore.getState().newChat()
}

/** Put a stored conversation on screen. */
export async function openConversation(id: string): Promise<void> {
    stopStreaming()
    const store = useAssistantStore.getState()
    store.showConversation(id, [], true)
    try {
        const c = await queryClient.fetchQuery<Conversation>({
            queryKey: aiConversationKey(id),
            queryFn: () => aiService.getConversation(id),
            staleTime: 0,
        })
        if (useAssistantStore.getState().conversationId === id) {
            useAssistantStore.getState().showConversation(id, turnsFromConversation(c))
        }
    } catch (e) {
        if (useAssistantStore.getState().conversationId !== id) return
        const failed: AssistantTurn = {
            ...emptyAssistantTurn(), status: 'error', finished: true,
            error: { code: aiErrorCode(e) ?? 'request_failed', message: e instanceof Error ? e.message : String(e) },
        }
        useAssistantStore.getState().showConversation(id, [failed])
    }
}

export async function deleteConversation(id: string): Promise<void> {
    await aiService.deleteConversation(id)
    if (useAssistantStore.getState().conversationId === id) startNewChat()
    queryClient.removeQueries({ queryKey: aiConversationKey(id) })
    await queryClient.invalidateQueries({ queryKey: AI_CONVERSATIONS_KEY })
}

/** Rate an answer; the rating shows at once, and reverts if the server refused it. */
export async function rateAnswer(turnId: string, messageId: string, rating: 1 | -1, comment?: string): Promise<void> {
    const before = useAssistantStore.getState().turns.find((t) => t.id === turnId)
    const previous = before?.role === 'assistant' ? before.feedback : null
    useAssistantStore.getState().updateTurn(turnId, (t) => ({ ...t, feedback: rating }))
    try {
        await aiService.sendFeedback(messageId, rating, comment)
    } catch (e) {
        useAssistantStore.getState().updateTurn(turnId, (t) => ({ ...t, feedback: previous }))
        throw e
    }
}
