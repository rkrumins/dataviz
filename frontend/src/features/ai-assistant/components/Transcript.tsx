/**
 * Transcript — the conversation, oldest first. It follows a streaming answer down while the
 * person is reading at the bottom, and stays put once they scroll up to read something earlier.
 */
import { useLayoutEffect, useRef } from 'react'
import { Skeleton } from '@/components/ui/Skeleton'
import type { Turn } from '../lib/transcript'
import type { ClarificationChoice } from './blocks/ClarificationCard'
import { AssistantMessage, UserMessage } from './MessageView'

/** Within this far of the bottom counts as "reading at the bottom". */
const STICK_PX = 96

export function Transcript({ turns, loading, busy, onAsk, onRetry, onClarify, onOther }: {
    turns: Turn[]
    loading: boolean
    busy: boolean
    onAsk: (question: string) => void
    onRetry: (assistantTurnId: string) => void
    onClarify: (turnId: string, clarificationId: string, choice: ClarificationChoice) => void
    onOther: (turnId: string, clarificationId: string, text: string) => void
}) {
    const scroller = useRef<HTMLDivElement>(null)
    const stick = useRef(true)

    useLayoutEffect(() => {
        const el = scroller.current
        if (el && stick.current) el.scrollTop = el.scrollHeight
    }, [turns])

    const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant')
    const streaming = lastAssistant?.role === 'assistant' && lastAssistant.status === 'streaming'

    return (
        <div
            ref={scroller}
            onScroll={(e) => {
                const el = e.currentTarget
                stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
            }}
            className="min-h-0 flex-1 overflow-y-auto custom-scrollbar"
        >
            <div role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions" className="space-y-5 px-3.5 py-4">
                {loading && (
                    <div className="space-y-3" aria-label="Loading the conversation">
                        <Skeleton className="ml-auto h-8 w-2/3 rounded-2xl" />
                        <Skeleton className="h-3 w-11/12" /><Skeleton className="h-3 w-4/5" /><Skeleton className="h-24 w-full rounded-xl" />
                    </div>
                )}
                {turns.map((t) => (t.role === 'user'
                    ? <UserMessage key={t.id} text={t.text} />
                    : (
                        <AssistantMessage
                            key={t.id}
                            turn={t}
                            isLast={t === lastAssistant}
                            busy={busy && t !== lastAssistant}
                            onAsk={onAsk}
                            onRetry={() => onRetry(t.id)}
                            onClarify={onClarify}
                            onOther={onOther}
                        />
                    )))}
            </div>
            <div aria-live="polite" className="sr-only">
                {streaming ? 'Working on an answer…' : lastAssistant?.role === 'assistant' && lastAssistant.finished ? 'Answer ready.' : ''}
            </div>
        </div>
    )
}
