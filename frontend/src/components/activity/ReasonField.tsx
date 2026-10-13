/**
 * "Why?" — the optional reason that goes with a change.
 *
 * One line of text, the reasons people usually have for this kind of change
 * as one-click chips, and the ones this person gave recently. Never required:
 * the change goes ahead either way, and the log says "No reason given" rather
 * than inventing one. Under the field, in plain words, who will be able to
 * read it — it is free text, saved with the person's name.
 *
 * Enter confirms and Escape cancels when the surrounding dialog passes those
 * through, so a person who has nothing to add loses one keystroke at most.
 */
import { useEffect, useId, useRef } from 'react'
import { History } from 'lucide-react'

import { cn } from '@/lib/utils'
import { REASON_MAX_LENGTH } from '@/services/activityReason'

import { REASON_PRESETS, REASON_READERS, type ReasonAudience } from './reasonPresets'
import type { ReasonDraft } from './useReasonDraft'

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export function ReasonField({
    draft, audience, note, label = 'Why?', disabled, autoFocus, onSubmit, onEscape, className,
}: {
    draft: ReasonDraft
    audience: ReasonAudience
    /** Anywhere else the reason will show, e.g. "It also shows on the run in Job History." */
    note?: string
    label?: string
    disabled?: boolean
    autoFocus?: boolean
    onSubmit?: () => void
    onEscape?: () => void
    className?: string
}) {
    const id = useId()
    const inputRef = useRef<HTMLInputElement>(null)
    const presets = REASON_PRESETS[draft.context]
    const recent = draft.recent.filter((r) => !presets.some((p) => sameText(p, r))).slice(0, 3)
    const length = Array.from(draft.value).length

    // Focused from an effect, not the autoFocus attribute: a drawer underneath
    // that steps aside for this dialog hands focus back to the page in its
    // effect cleanup, which runs after autoFocus and would win.
    useEffect(() => {
        if (autoFocus) inputRef.current?.focus()
    }, [autoFocus])

    const choose = (text: string) => {
        draft.setValue(text)
        inputRef.current?.focus()
    }
    const chip = (text: string, fromMemory: boolean) => {
        const active = sameText(draft.value, text)
        return (
            <button
                key={`${fromMemory ? 'recent' : 'preset'}:${text}`}
                type="button"
                aria-pressed={active}
                disabled={disabled}
                onClick={() => choose(text)}
                title={fromMemory ? 'You gave this reason recently' : undefined}
                className={cn(
                    'inline-flex max-w-full items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50',
                    'outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                    active
                        ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300'
                        : 'border-glass-border bg-black/[0.03] dark:bg-white/[0.02] text-ink-secondary hover:text-ink hover:border-indigo-500/30',
                )}
            >
                {fromMemory && <History className="h-3 w-3 shrink-0" aria-hidden />}
                <span className="truncate">{text}</span>
            </button>
        )
    }

    return (
        <div className={cn('space-y-2', className)}>
            <div className="flex items-baseline justify-between gap-2">
                <label htmlFor={id} className="text-xs font-semibold text-ink">
                    {label} <span className="font-normal text-ink-muted">Optional</span>
                </label>
                {length > REASON_MAX_LENGTH - 100 && (
                    <span className="text-[10px] tabular-nums text-ink-muted" aria-live="polite">
                        {length}/{REASON_MAX_LENGTH}
                    </span>
                )}
            </div>
            <input
                ref={inputRef}
                id={id}
                type="text"
                value={draft.value}
                maxLength={REASON_MAX_LENGTH}
                disabled={disabled}
                autoComplete="off"
                placeholder="Say what prompted this, in a few words"
                aria-describedby={`${id}-readers`}
                onChange={(e) => draft.setValue(e.target.value)}
                onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return
                    if (e.key === 'Enter' && onSubmit) {
                        e.preventDefault()
                        onSubmit()
                    } else if (e.key === 'Escape' && onEscape) {
                        e.preventDefault()
                        onEscape()
                    }
                }}
                className="input h-9 w-full text-sm"
            />
            <div role="group" aria-label="Suggested reasons" className="flex flex-wrap gap-1.5">
                {recent.map((r) => chip(r, true))}
                {presets.map((p) => chip(p, false))}
            </div>
            <p id={`${id}-readers`} className="text-[11px] leading-relaxed text-ink-muted">
                {REASON_READERS[audience]}{note ? ` ${note}` : ''}
            </p>
        </div>
    )
}
