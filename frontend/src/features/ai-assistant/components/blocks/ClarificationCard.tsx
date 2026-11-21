/**
 * ClarificationCard — the assistant could read the question more than one way, and asks which
 * is meant before it answers: the readings as a radio group, each with how many it finds, the
 * offer to remember the choice for this data source, and room for "something else" in the
 * person's own words. Once answered it shows what was chosen, and asks no more.
 */
import { useId, useState } from 'react'
import { ArrowRight, Check, HelpCircle, MessageSquareText } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { compact } from '@/lib/formatMetric'
import { onRadioGroupKeyDown } from '@/lib/radioGroupKeys'
import { cn } from '@/lib/utils'
import type { Clarification, ClarifyOption } from '../../api/types'

export interface ClarificationChoice {
    optionId: string
    label: string
    remember: boolean
}

export function ClarificationCard({ data, onAnswer, onOther, disabled = false }: {
    data: Clarification
    onAnswer: (choice: ClarificationChoice) => void
    /** "Something else…": the person's own words, sent as a new question. */
    onOther?: (text: string) => void
    disabled?: boolean
}) {
    const questionId = useId()
    const [chosen, setChosen] = useState<string | null>(null)
    const [remember, setRemember] = useState(false)
    const [other, setOther] = useState<string | null>(null)
    const answered = !!data.answered
    const picked = data.options.find((o) => o.id === (data.chosen ?? chosen))

    if (answered) {
        return (
            <section aria-labelledby={questionId} className="rounded-xl border border-glass-border bg-canvas px-3.5 py-3">
                <p id={questionId} className="text-xs text-ink-muted">{data.question}</p>
                <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-ink">
                    <Check className="h-4 w-4 text-emerald-500" aria-hidden />
                    {picked ? picked.label : 'Answered'}
                </p>
            </section>
        )
    }

    const send = () => {
        const option = data.options.find((o) => o.id === chosen)
        if (!option || disabled) return
        onAnswer({ optionId: option.id, label: option.label, remember: !!data.allowRemember && remember })
    }
    const sendOther = () => {
        const text = other?.trim()
        if (!text || disabled) return
        onOther?.(text)
        setOther(null)
    }
    const total = Math.max(0, ...data.options.map((o) => o.count ?? 0))

    return (
        <section aria-labelledby={questionId}
                 className="overflow-hidden rounded-xl border border-accent-lineage/30 bg-canvas shadow-sm shadow-accent-lineage/5">
            <header className="flex items-start gap-2.5 bg-accent-lineage/5 px-3.5 pb-2.5 pt-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-lineage/15 text-accent-lineage">
                    <HelpCircle className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-2xs font-bold uppercase tracking-wider text-accent-lineage">One question first</span>
                        {data.concept && (
                            <span className="rounded-full border border-accent-lineage/30 px-1.5 py-px text-2xs font-semibold text-accent-lineage">{data.concept}</span>
                        )}
                    </div>
                    <h3 id={questionId} className="mt-0.5 text-sm font-semibold leading-snug text-ink">{data.question}</h3>
                </div>
            </header>

            <div className="space-y-3 px-3.5 py-3">
                <div role="radiogroup" aria-labelledby={questionId} onKeyDown={onRadioGroupKeyDown} className="space-y-1.5">
                    {data.options.map((o, i) => (
                        <Option key={o.id} option={o} total={total} checked={chosen === o.id}
                                tabbable={chosen === o.id || (chosen === null && i === 0)}
                                disabled={disabled} onPick={() => setChosen(o.id)} />
                    ))}
                </div>

                {data.allowRemember && (
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-secondary">
                        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={disabled}
                               className="h-3.5 w-3.5 rounded border-glass-border accent-[rgb(var(--nx-accent-lineage-rgb))]" />
                        Remember for this data source
                    </label>
                )}

                {other !== null ? (
                    <div className="flex items-center gap-1.5">
                        <input
                            autoFocus
                            value={other}
                            onChange={(e) => setOther(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') { e.preventDefault(); sendOther() }
                                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOther(null) }
                            }}
                            aria-label="What you meant, in your own words"
                            placeholder="What you meant, in your own words…"
                            className="input h-8 min-w-0 flex-1 text-sm"
                        />
                        <Button size="sm" variant="primary" onClick={sendOther} disabled={disabled || !other.trim()}>Send</Button>
                    </div>
                ) : (
                    <div className="flex flex-wrap items-center gap-1.5">
                        <Button size="sm" variant="primary" rightIcon={ArrowRight} onClick={send} disabled={disabled || chosen === null}>
                            Continue
                        </Button>
                        {data.allowOther && onOther && (
                            <Button size="sm" variant="ghost" leftIcon={MessageSquareText} onClick={() => setOther('')} disabled={disabled}>
                                Something else…
                            </Button>
                        )}
                    </div>
                )}
            </div>
        </section>
    )
}

function Option({ option, total, checked, tabbable, disabled, onPick }: {
    option: ClarifyOption
    total: number
    checked: boolean
    tabbable: boolean
    disabled: boolean
    onPick: () => void
}) {
    const share = total > 0 && typeof option.count === 'number' ? option.count / total : 0
    return (
        <button
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={tabbable ? 0 : -1}
            disabled={disabled}
            onClick={onPick}
            className={cn(
                'relative flex w-full items-center gap-2.5 overflow-hidden rounded-lg border px-2.5 py-2 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 disabled:opacity-60',
                checked ? 'border-accent-lineage/50 bg-accent-lineage/10' : 'border-glass-border hover:border-accent-lineage/30 hover:bg-black/[0.02] dark:hover:bg-white/[0.03]',
            )}
        >
            {/* How much each reading finds, against the most any finds: a hairline along its foot. */}
            <span aria-hidden className="absolute bottom-0 left-0 h-0.5 bg-accent-lineage/30" style={{ width: `${share * 100}%` }} />
            <span aria-hidden className={cn('relative flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2',
                checked ? 'border-accent-lineage' : 'border-ink-muted/50')}>
                {checked && <span className="h-2 w-2 rounded-full bg-accent-lineage" />}
            </span>
            <span className="relative min-w-0 flex-1">
                <span className="block text-sm font-medium text-ink">{option.label}</span>
                {option.description && <span className="block text-xs text-ink-muted">{option.description}</span>}
            </span>
            {typeof option.count === 'number' && (
                <span className="relative shrink-0 text-sm font-semibold tabular-nums text-ink">
                    {compact(option.count)}
                </span>
            )}
        </button>
    )
}
