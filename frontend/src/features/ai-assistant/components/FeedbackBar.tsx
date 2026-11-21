/**
 * FeedbackBar — under a finished answer: copy it, and say whether it helped (with a note, if the
 * person wants to add one). What is said goes to the administrators' feedback view.
 */
import { useState } from 'react'
import { Check, Copy, ThumbsDown, ThumbsUp } from 'lucide-react'
import { Button, IconButton } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { rateAnswer } from '../lib/chatController'
import { answerAsText, type AssistantTurn } from '../lib/transcript'
import { useCopy } from '../lib/useCopy'

export function FeedbackBar({ turn }: { turn: AssistantTurn }) {
    const [copied, copy] = useCopy()
    const [noting, setNoting] = useState<1 | -1 | null>(null)
    const [note, setNote] = useState('')
    const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')
    const messageId = turn.messageId

    const rate = (rating: 1 | -1) => {
        if (!messageId) return
        setState('idle')
        setNoting(rating)
        rateAnswer(turn.id, messageId, rating).catch(() => setState('failed'))
    }
    const sendNote = () => {
        if (!messageId || noting === null || !note.trim()) return
        setState('sending')
        rateAnswer(turn.id, messageId, noting, note.trim()).then(
            () => { setState('sent'); setNoting(null); setNote('') },
            () => setState('failed'),
        )
    }

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-0.5 text-ink-muted">
                <IconButton size="sm" icon={copied ? Check : Copy} label={copied ? 'Copied' : 'Copy answer'}
                            onClick={() => copy(answerAsText(turn))} />
                {messageId && (
                    <>
                        <IconButton size="sm" icon={ThumbsUp} label="Helpful" aria-pressed={turn.feedback === 1}
                                    active={turn.feedback === 1} onClick={() => rate(1)}
                                    className={cn(turn.feedback === 1 && 'text-emerald-600 dark:text-emerald-400')} />
                        <IconButton size="sm" icon={ThumbsDown} label="Not helpful" aria-pressed={turn.feedback === -1}
                                    active={turn.feedback === -1} onClick={() => rate(-1)}
                                    className={cn(turn.feedback === -1 && 'text-rose-600 dark:text-rose-400')} />
                    </>
                )}
                <span aria-live="polite" className="ml-1.5 text-xs">
                    {state === 'sent' ? 'Thanks — that helps improve the answers.'
                        : state === 'failed' ? 'That didn’t send. Try again in a moment.' : ''}
                </span>
            </div>
            {noting !== null && state !== 'sent' && (
                <div className="flex items-start gap-1.5">
                    <textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendNote() }
                            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setNoting(null) }
                        }}
                        rows={2}
                        aria-label="Tell us more (optional)"
                        placeholder={noting === -1 ? 'What was wrong or missing? (optional)' : 'What was useful? (optional)'}
                        className="input min-h-[2.5rem] flex-1 resize-none text-xs"
                    />
                    <Button size="sm" variant="secondary" onClick={sendNote} loading={state === 'sending'} disabled={!note.trim()}>
                        Send
                    </Button>
                </div>
            )}
        </div>
    )
}
