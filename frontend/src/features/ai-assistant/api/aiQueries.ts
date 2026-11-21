/**
 * The assistant's reads through react-query: whether it is set up (`status`), and the person's
 * conversations. The chat itself is a stream and is not cached here (see `chatController`).
 *
 * They run on the app's one client (`lib/queryClient`), named explicitly: the AI affordances
 * live on surfaces — the search panel's Ask bar, the Cypher tab — that are also rendered
 * without a provider above them, and asking whether the assistant is set up must not need one.
 */
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/lib/queryClient'
import { useFeature } from '@/store/features'
import { aiService } from './aiService'
import type { AssistantPersona } from './types'

export const AI_STATUS_KEY = ['ai', 'status'] as const
export const AI_CONVERSATIONS_KEY = ['ai', 'conversations'] as const
export const aiConversationKey = (id: string) => ['ai', 'conversation', id] as const
export const AI_CONCEPTS_KEY = ['ai', 'concepts'] as const

/** Whether the assistant is set up. Only asked while the feature is on. */
export function useAiStatus() {
    const on = useFeature('aiAssistantEnabled')
    return useQuery({
        queryKey: AI_STATUS_KEY,
        queryFn: () => aiService.getStatus(),
        enabled: on,
        staleTime: 60_000,
        // A refusal (no permission, switched off) is an answer, not a blip.
        retry: false,
    }, queryClient)
}

/**
 * The AI affordances outside the panel (Ask AI, Draft with AI) are offered only when the feature
 * is on AND an administrator has connected a model — and, given a persona, that persona is on.
 */
export function useAiAvailable(persona?: AssistantPersona): boolean {
    const on = useFeature('aiAssistantEnabled')
    const { data } = useAiStatus()
    return on && !!data?.configured && (!persona || data.personas?.[persona] !== false)
}

export function useConversations(enabled: boolean) {
    return useQuery({
        queryKey: AI_CONVERSATIONS_KEY,
        queryFn: () => aiService.listConversations(30),
        enabled,
        staleTime: 15_000,
        retry: false,
    }, queryClient)
}

/** The readings the person asked the assistant to remember ("PII" means the tag pii), and the
 *  ones an administrator made everyone's — for a data source, or all of them. */
export function useConcepts(dataSourceId: string | undefined, enabled: boolean) {
    return useQuery({
        queryKey: [...AI_CONCEPTS_KEY, dataSourceId ?? null],
        queryFn: () => aiService.listConcepts(dataSourceId),
        enabled,
        staleTime: 15_000,
        retry: false,
    }, queryClient)
}
