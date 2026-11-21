/**
 * Composer — where the question is typed. It grows with what is written (to a point, then
 * scrolls); Enter asks, Shift+Enter starts a new line, Esc closes the panel. While an answer
 * streams, Send becomes Stop.
 *
 * It sits in the rail's keyboard scope (`ai-chat`), so the canvas's shortcuts never see these
 * keys: Backspace here deletes a letter, not the node selected on the canvas.
 */
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { Kbd } from '@/components/ui/Kbd'
import { cn } from '@/lib/utils'

const MAX_HEIGHT_PX = 200

export interface ComposerHandle {
    focus: () => void
    /** Put a question in the box (a starter prompt chosen to edit). */
    fill: (text: string) => void
}

export const Composer = forwardRef<ComposerHandle, {
    onSend: (text: string) => void
    onStop: () => void
    onEscape: () => void
    streaming: boolean
    disabled?: boolean
    placeholder: string
    footer?: ReactNode
}>(function Composer({ onSend, onStop, onEscape, streaming, disabled = false, placeholder, footer }, ref) {
    const [value, setValue] = useState('')
    const area = useRef<HTMLTextAreaElement>(null)
    useImperativeHandle(ref, () => ({
        focus: () => area.current?.focus(),
        fill: (text) => { setValue(text); area.current?.focus() },
    }), [])

    useLayoutEffect(() => {
        const el = area.current
        if (!el) return
        el.style.height = 'auto'
        el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
    }, [value])

    const canSend = !disabled && !streaming && value.trim().length > 0
    const send = () => {
        if (!canSend) return
        onSend(value.trim())
        setValue('')
    }

    return (
        <div className="shrink-0 border-t border-glass-border px-3 pb-3 pt-2.5">
            <div className={cn(
                'flex items-end gap-2 rounded-2xl border border-glass-border bg-canvas px-3 py-2 shadow-sm transition-shadow',
                'focus-within:border-accent-lineage/50 focus-within:ring-2 focus-within:ring-accent-lineage/15',
            )}>
                <textarea
                    ref={area}
                    rows={1}
                    value={value}
                    disabled={disabled}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault()
                            send()
                        } else if (e.key === 'Escape') {
                            e.preventDefault()
                            e.stopPropagation()
                            onEscape()
                        }
                    }}
                    aria-label="Ask the assistant"
                    placeholder={placeholder}
                    className="max-h-[200px] min-h-[1.5rem] flex-1 resize-none bg-transparent py-1 text-sm leading-6 text-ink outline-none placeholder:text-ink-muted/80 disabled:opacity-60"
                />
                {streaming ? (
                    <button type="button" onClick={onStop} aria-label="Stop the answer"
                            className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-ink text-canvas transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                        <Square className="h-3.5 w-3.5 fill-current" aria-hidden />
                    </button>
                ) : (
                    <button type="button" onClick={send} disabled={!canSend} aria-label="Send"
                            className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-accent-lineage to-violet-600 text-white shadow-sm shadow-accent-lineage/25 transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 disabled:opacity-35 disabled:shadow-none">
                        <ArrowUp className="h-4 w-4" aria-hidden />
                    </button>
                )}
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2 px-1 text-2xs text-ink-muted">
                <span className="min-w-0 truncate">{footer}</span>
                <span className="inline-flex shrink-0 items-center gap-1">
                    <Kbd shortcut="shift+enter" /> new line
                </span>
            </div>
        </div>
    )
})
