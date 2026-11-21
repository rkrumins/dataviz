/**
 * The assistant's reads through react-query: whether it is set up (`status`), the person's
 * conversations, and what it knows about the page (`context`). The chat itself is a stream and
 * is not cached here (see `chatController`).
 *
 * They run on the app's one client (`lib/queryClient`), named explicitly: the AI affordances
 * live on surfaces — the search panel's Ask bar, the Cypher tab — that are also rendered
 * without a provider above them, and asking whether the assistant is set up must not need one.
 */
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/lib/queryClient'
import { useFeature } from '@/store/features'
import type { AssistantPageContext } from '../lib/useAssistantContext'
import { useAssistantStore } from '../store/assistantStore'
import { aiService } from './aiService'
import type { AssistantPersona } from './types'

export const AI_STATUS_KEY = ['ai', 'status'] as const
export const AI_CONVERSATIONS_KEY = ['ai', 'conversations'] as const
export const aiConversationKey = (id: string) => ['ai', 'conversation', id] as const
export const AI_CONCEPTS_KEY = ['ai', 'concepts'] as const
export const AI_CONTEXT_KEY = ['ai', 'context'] as const

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

/** Whether there is a "What I know" card here: the data persona, on a view or a page that said
 *  what it is, with the page left in the question. */
export function briefAvailable(persona: AssistantPersona, page: AssistantPageContext): boolean {
    return persona === 'data' && !!page.context.page && !page.detached
}

/**
 * What the assistant knows about the page. Asked only while the rail is open and a card is
 * available here (`briefAvailable`): the brief reads the catalogue, which a folded rail, or Help,
 * has no use for.
 */
export function useContextBrief(page: AssistantPageContext) {
    const open = useAssistantStore((s) => s.open)
    const persona = useAssistantStore((s) => s.persona)
    const p = page.context.page
    const { workspaceId, dataSourceId, viewId } = page.context
    return useQuery({
        queryKey: [...AI_CONTEXT_KEY, p?.kind ?? null, p?.id ?? null, workspaceId ?? null, dataSourceId ?? null],
        queryFn: () => aiService.getContext({
            viewId, workspaceId, dataSourceId, pageKind: p?.kind, pageId: p?.id, pageTitle: p?.title,
        }),
        enabled: open && briefAvailable(persona, page),
        staleTime: 5 * 60_000,
        retry: false,
    }, queryClient)
}
