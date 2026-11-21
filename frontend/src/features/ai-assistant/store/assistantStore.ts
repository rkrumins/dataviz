/**
 * Assistant store — the AI assistant's right rail: whether it is open, which persona it speaks
 * as, the conversation on screen, what a launcher handed it, and how wide the person made it.
 *
 * Non-persisted (session-only), like the Help drawer's store: none of this should survive a
 * reload. Components subscribe with selectors; launchers anywhere in the app (the top bar, ⌘J,
 * the command palettes, the entity drawer) call `useAssistantStore.getState().openAssistant(…)`.
 *
 * The conversation on screen lives here too, so it outlasts the rail being folded away and is
 * replaced in ONE update when a stream names its conversation (`chatController`).
 */
import { create } from 'zustand'
import type { AssistantPage, AssistantPersona } from '../api/types'
import type { AssistantTurn, Turn } from '../lib/transcript'

export type { AssistantPersona }

/** What a launcher hands the panel beyond the page it is on. */
export interface PendingContext {
    /** The entity it was opened about — the drawer's, a right-click's. */
    focusUrn?: string
    focusName?: string
    /** A question to ask as soon as it opens. Taken once (`consumePrompt`). */
    prompt?: string
}

/** A page's own account of itself (`useAssistantPage`): what it is, for the question and the card. */
export interface RegisteredPage extends AssistantPage {
    /** The route it registered on — read only while the person is still there. */
    path: string
    workspaceId?: string
    dataSourceId?: string
    /** The persona the rail opens on here, while no conversation is in progress. */
    persona?: AssistantPersona
}

export interface OpenAssistantOptions {
    persona?: AssistantPersona
    context?: PendingContext
}

interface AssistantState {
    open: boolean
    persona: AssistantPersona
    /** The conversation on screen; null for a new one, until its first answer names it. */
    conversationId: string | null
    turns: Turn[]
    /** A conversation picked from the history is being read. */
    loadingConversation: boolean
    pendingContext: PendingContext | null
    /** The page whose context the person removed from the question (its key), if any. */
    detachedFrom: string | null
    /** The person's own width, once they drag the edge; null for the default. */
    railWidth: number | null
    /** The page the person is on, as it registered itself; null where none did. */
    page: RegisteredPage | null
    /** An answer finished while the rail was closed — the launcher's dot. */
    unread: boolean
    /** The "What I know" card is open, over the context chip. */
    contextOpen: boolean

    openAssistant: (opts?: OpenAssistantOptions) => void
    closeAssistant: () => void
    toggleAssistant: () => void
    setPersona: (persona: AssistantPersona) => void
    /** Start over: a new conversation, nothing on screen. */
    newChat: () => void
    /** Put a conversation (or none) on screen. */
    showConversation: (id: string | null, turns: Turn[], loading?: boolean) => void
    setConversationId: (id: string) => void
    appendTurns: (...turns: Turn[]) => void
    updateTurn: (id: string, update: (turn: AssistantTurn) => AssistantTurn) => void
    /** Take the question a launcher asked for, once. */
    consumePrompt: () => string | null
    /** Leave this page out of the question; another page brings its own back. */
    detachContext: (pageKey: string) => void
    attachContext: () => void
    setRailWidth: (width: number | null) => void
    setPage: (page: RegisteredPage) => void
    /** Withdraw `page` — only if it is still the one registered. */
    clearPage: (page: RegisteredPage) => void
    setUnread: (unread: boolean) => void
    setContextOpen: (open: boolean) => void
}

export const useAssistantStore = create<AssistantState>()((set, get) => ({
    open: false,
    persona: 'data',
    conversationId: null,
    turns: [],
    loadingConversation: false,
    pendingContext: null,
    detachedFrom: null,
    railWidth: null,
    page: null,
    unread: false,
    contextOpen: false,

    openAssistant: (opts) => set((s) => ({
        open: true,
        unread: false,
        persona: opts?.persona ?? s.persona,
        // A launcher's context replaces the last one — and brings the page back into the question.
        ...(opts?.context ? { pendingContext: opts.context, detachedFrom: null } : {}),
    })),
    closeAssistant: () => set({ open: false, contextOpen: false }),
    toggleAssistant: () => set((s) => (s.open ? { open: false, contextOpen: false } : { open: true, unread: false })),
    setPersona: (persona) => set({ persona }),
    newChat: () => set({ conversationId: null, turns: [], loadingConversation: false, pendingContext: null }),
    showConversation: (id, turns, loading = false) => set({ conversationId: id, turns, loadingConversation: loading }),
    setConversationId: (id) => set({ conversationId: id }),
    appendTurns: (...turns) => set((s) => ({ turns: [...s.turns, ...turns] })),
    updateTurn: (id, update) => set((s) => ({
        turns: s.turns.map((t) => (t.role === 'assistant' && t.id === id ? update(t) : t)),
    })),
    consumePrompt: () => {
        const prompt = get().pendingContext?.prompt ?? null
        if (prompt !== null) set((s) => ({ pendingContext: s.pendingContext ? { ...s.pendingContext, prompt: undefined } : null }))
        return prompt
    },
    detachContext: (pageKey) => set({ detachedFrom: pageKey, pendingContext: null }),
    attachContext: () => set({ detachedFrom: null }),
    setRailWidth: (railWidth) => set({ railWidth }),
    setPage: (page) => set({ page }),
    clearPage: (page) => set((s) => (s.page === page ? { page: null } : {})),
    setUnread: (unread) => set({ unread }),
    setContextOpen: (contextOpen) => set({ contextOpen }),
}))
