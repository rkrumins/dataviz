/**
 * Ask why before a one-click change — for the buttons that had no dialog.
 *
 *   const [reasonPrompt, askReason] = useReasonPrompt()
 *   const answer = await askReason({ title: 'Cancel this run?', ... })
 *   if (!answer) return                       // they backed out
 *   await aggregationService.cancelJob(ds, job, { reason: answer.reason })
 *   …
 *   return <>{…}{reasonPrompt}</>
 *
 * The prompt doubles as the confirmation the button never had, and the
 * reason in it is optional: Enter goes ahead without one.
 */
import { useCallback, useState, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

import { ConfirmDialog } from '@/components/admin/job-history/ConfirmDialog'

import type { ReasonAudience, ReasonContext } from './reasonPresets'
import { useReasonDraft } from './useReasonDraft'

export interface ReasonPromptOptions {
    title: string
    /** What the change will do, in a sentence. */
    message: string
    confirmLabel: string
    confirmIcon: LucideIcon
    context: ReasonContext
    audience: ReasonAudience
    /** `danger` for changes that remove or stop something. */
    tone?: 'danger' | 'neutral'
}

export interface ReasonAnswer {
    reason?: string
}

const TONES = {
    danger: { accent: 'from-red-500 to-red-400', button: 'bg-red-500 hover:bg-red-600 shadow-md' },
    neutral: { accent: 'from-indigo-500 to-violet-500', button: 'bg-indigo-500 hover:bg-indigo-600 shadow-md' },
} as const

export function useReasonPrompt(): [ReactNode, (options: ReasonPromptOptions) => Promise<ReasonAnswer | null>] {
    const [request, setRequest] = useState<{
        options: ReasonPromptOptions
        settle: (answer: ReasonAnswer | null) => void
    } | null>(null)
    const draft = useReasonDraft(request?.options.context ?? 'aggregation')
    const { reset } = draft

    const ask = useCallback((options: ReasonPromptOptions) => new Promise<ReasonAnswer | null>((resolve) => {
        reset()
        setRequest({ options, settle: resolve })
    }), [reset])

    let element: ReactNode = null
    if (request) {
        const { options, settle } = request
        const tone = TONES[options.tone ?? 'neutral']
        const finish = (answer: ReasonAnswer | null) => {
            setRequest(null)
            settle(answer)
        }
        element = (
            <ConfirmDialog
                open
                title={options.title}
                message={options.message}
                confirmLabel={options.confirmLabel}
                confirmIcon={options.confirmIcon}
                confirmColor={tone.button}
                accent={tone.accent}
                reason={draft}
                reasonAudience={options.audience}
                onConfirm={() => finish({ reason: draft.take() })}
                onCancel={() => finish(null)}
            />
        )
    }
    return [element, ask]
}
