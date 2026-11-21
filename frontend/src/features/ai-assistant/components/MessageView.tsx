/**
 * One turn of the conversation: the person's question, or the assistant's answer — how it got
 * there, the words, the cards, the buttons, and (once it is done) what to ask next and whether
 * it helped. While the answer is being worked out and nothing is written yet, a shimmer holds
 * its place.
 */
import { AlertCircle, Bot, RotateCcw, Square } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { citationNumbers } from '../lib/citations'
import { errorCopy } from '../lib/errorCopy'
import type { AssistantTurn } from '../lib/transcript'
import { useAssistantActions } from '../lib/useAssistantActions'
import { AnswerMarkdown } from './AnswerMarkdown'
import { BlockView } from './BlockView'
import type { ClarificationChoice } from './blocks/ClarificationCard'
import { FeedbackBar } from './FeedbackBar'
import { FollowUpChips } from './FollowUpChips'
import { StepTimeline } from './StepTimeline'

export function UserMessage({ text }: { text: string }) {
    return (
        <div className="flex justify-end">
            <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent-lineage/10 px-3.5 py-2 text-sm text-ink">
                <span className="sr-only">You asked: </span>{text}
            </div>
        </div>
    )
}

export function AssistantAvatar({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
    return (
        <span aria-hidden className={size === 'lg'
            ? 'flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-accent-lineage to-violet-600 text-white shadow-lg shadow-accent-lineage/25'
            : 'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-accent-lineage to-violet-600 text-white shadow-sm shadow-accent-lineage/20'}>
            <Bot className={size === 'lg' ? 'h-6 w-6' : 'h-4 w-4'} />
        </span>
    )
}

export function AssistantMessage({ turn, isLast, busy, onAsk, onRetry, onClarify, onOther }: {
    turn: AssistantTurn
    /** The latest answer: only it offers follow-ups. */
    isLast: boolean
    /** Another answer is streaming. */
    busy: boolean
    onAsk: (question: string) => void
    onRetry?: () => void
    onClarify: (turnId: string, clarificationId: string, choice: ClarificationChoice) => void
    onOther: (turnId: string, clarificationId: string, text: string) => void
}) {
    const actions = useAssistantActions()
    const streaming = turn.status === 'streaming'
    const thinking = streaming && !turn.text && turn.blocks.length === 0
    const running = turn.steps.filter((s) => s.status === 'running').pop()
    const cited = citationNumbers(turn.blocks)
    const anchorPrefix = `ans-${turn.id}`
    const failure = turn.status === 'error' && turn.error ? errorCopy(turn.error.code, turn.error.message) : null

    return (
        <article aria-label="Answer" aria-busy={streaming} className="flex gap-2.5">
            <AssistantAvatar />
            <div className="min-w-0 flex-1 space-y-3">
                <StepTimeline steps={turn.steps} live={streaming} />

                {thinking && (
                    <div className="space-y-2 pt-0.5" role="status">
                        <span className="text-xs font-medium text-ink-muted">{running ? `${running.label}…` : 'Thinking…'}</span>
                        <div className="space-y-2">
                            <Skeleton className="nx-skeleton h-3 w-11/12" />
                            <Skeleton className="nx-skeleton h-3 w-4/5" />
                            <Skeleton className="nx-skeleton h-3 w-3/5" />
                        </div>
                    </div>
                )}

                {turn.text && <AnswerMarkdown text={turn.text} cited={cited} anchorPrefix={anchorPrefix} streaming={streaming} />}

                {turn.blocks.map((b) => (
                    <BlockView
                        key={b.id}
                        block={b}
                        anchorPrefix={anchorPrefix}
                        busy={busy || streaming}
                        onClarify={(id, choice) => onClarify(turn.id, id, choice)}
                        onOther={(id, text) => onOther(turn.id, id, text)}
                        onAsk={onAsk}
                    />
                ))}

                {turn.actions.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                        {turn.actions.map((a) => (
                            <Button key={a.id} size="sm" variant="secondary" onClick={() => actions.run(a)}>{a.label}</Button>
                        ))}
                    </div>
                )}

                {failure && (
                    <div role="alert" className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/5 px-3 py-2.5">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" aria-hidden />
                        <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-ink">{failure.title}</p>
                            <p className="text-xs text-ink-muted">{failure.hint}</p>
                            {failure.retry && onRetry && (
                                <Button size="sm" variant="ghost" leftIcon={RotateCcw} onClick={onRetry} disabled={busy} className="-ml-2 mt-1">
                                    Try again
                                </Button>
                            )}
                        </div>
                    </div>
                )}

                {turn.status === 'stopped' && (
                    <p className="flex items-center gap-1.5 text-xs text-ink-muted">
                        <Square className="h-3 w-3" aria-hidden /> Stopped — what arrived is above.
                    </p>
                )}

                {isLast && !streaming && turn.status !== 'clarify' && (
                    <FollowUpChips items={turn.followups} onAsk={onAsk} disabled={busy} />
                )}

                {turn.finished && turn.status === 'ok' && <FeedbackBar turn={turn} />}
            </div>
        </article>
    )
}
