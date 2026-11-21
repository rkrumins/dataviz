/**
 * useAiQueryDraft — a query drafted by the AI service from a question in plain words
 * (`POST /ai/query/draft`), for when the rule-based reading can't place it all, or on demand.
 *
 * A draft belongs to the question it was asked for: once the question changes it no longer
 * shows. A draft that needs a choice first comes back with a clarification; asking again with
 * `choices` answers it. Offered only while the assistant is switched on and set up.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { useAiAvailable } from '@/features/ai-assistant/api/aiQueries'
import { aiErrorCode, aiService } from '@/features/ai-assistant/api/aiService'
import type { DraftResponse } from '@/features/ai-assistant/api/types'
import { errorCopy } from '@/features/ai-assistant/lib/errorCopy'
import { useSchemaStore } from '@/store/schema'
import { useWorkspacesStore } from '@/store/workspaces'
import type { Predicate } from '@/types/search'


export type AiDraftState =
    | { status: 'drafting'; question: string }
    | { status: 'done'; question: string; result: DraftResponse; choices: Record<string, string> }
    | { status: 'error'; question: string; message: string }

export interface AiDraftOptions {
    currentPredicate?: Predicate | null
    /** Answers to the draft's clarifications so far, by clarification id. */
    choices?: Record<string, string>
}


export function useAiQueryDraft(viewId: string | null, mode: 'search' | 'cypher' = 'search') {
    const available = useAiAvailable('data')
    const view = useSchemaStore((s) => (viewId ? s.schema?.views.find((v) => v.id === viewId) : undefined))
    const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
    const activeDataSourceId = useWorkspacesStore((s) => s.activeDataSourceId)
    const workspaceId = view?.workspaceId ?? activeWorkspaceId ?? undefined
    const dataSourceId = view?.dataSourceId ?? activeDataSourceId ?? undefined
    const [state, setState] = useState<AiDraftState | null>(null)
    const inFlight = useRef<AbortController | null>(null)

    // Leaving stops a draft on its way.
    useEffect(() => () => inFlight.current?.abort(), [])

    const draft = useCallback(async (question: string, opts: AiDraftOptions = {}) => {
        const q = question.trim()
        if (!q || !available) return
        inFlight.current?.abort()
        const controller = new AbortController()
        inFlight.current = controller
        setState({ status: 'drafting', question: q })
        try {
            const result = await aiService.draftQuery({
                context: {
                    ...(workspaceId ? { workspaceId } : {}),
                    ...(dataSourceId ? { dataSourceId } : {}),
                    ...(viewId ? { viewId } : {}),
                },
                question: q,
                mode,
                ...(opts.currentPredicate ? { currentPredicate: opts.currentPredicate } : {}),
                ...(opts.choices && Object.keys(opts.choices).length ? { choices: opts.choices } : {}),
            }, controller.signal)
            if (!controller.signal.aborted) setState({ status: 'done', question: q, result, choices: opts.choices ?? {} })
        } catch (e) {
            if (controller.signal.aborted) return
            const copy = errorCopy(aiErrorCode(e) ?? '', e instanceof Error ? e.message : undefined)
            setState({ status: 'error', question: q, message: `${copy.title}. ${copy.hint}` })
        }
    }, [available, workspaceId, dataSourceId, viewId, mode])

    const reset = useCallback(() => {
        inFlight.current?.abort()
        setState(null)
    }, [])

    return { available, state, draft, reset }
}
