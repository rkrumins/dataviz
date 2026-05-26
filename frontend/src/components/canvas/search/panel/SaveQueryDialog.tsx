/**
 * SaveQueryDialog — name + description prompt for promoting a recent
 * query into the user's named "Mine" library.
 *
 * Lightweight modal (not a Radix Dialog — the project's existing
 * panels use div-based modals via a fixed overlay). Shows the DSL
 * preview so the user can confirm they're naming the right query.
 * Submits via Enter; cancels via Escape or backdrop click.
 *
 * Rendered via ``createPortal`` to document.body so the dialog's
 * ``position: fixed inset-0`` resolves to the viewport, NOT to the
 * search panel's framer-motion ``aside`` wrapper. Framer-motion sets
 * a CSS transform on animated elements which creates a new
 * containing block for fixed-positioned descendants — without the
 * portal, the dialog would be trapped inside the panel and render at
 * panel width instead of full-screen.
 */
import { motion } from 'framer-motion'
import { BookmarkPlus, X } from 'lucide-react'
import {
    type FC, type KeyboardEvent, useCallback, useEffect,
    useRef, useState,
} from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/lib/utils'
import type { RecentQueryEntry } from '@/store/searchStore'


export interface SaveQueryDialogProps {
    entry: RecentQueryEntry
    onCancel: () => void
    onSave: (name: string, description?: string) => void
}


export const SaveQueryDialog: FC<SaveQueryDialogProps> = ({
    entry, onCancel, onSave,
}) => {
    const [name, setName] = useState('')
    const [description, setDescription] = useState('')
    const nameRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        nameRef.current?.focus()
    }, [])

    const canSave = name.trim().length > 0

    const handleSubmit = useCallback(() => {
        if (!canSave) return
        onSave(name.trim(), description.trim() || undefined)
    }, [canSave, name, description, onSave])

    const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' && canSave) {
            e.preventDefault()
            handleSubmit()
        } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
        }
    }, [canSave, handleSubmit, onCancel])

    // Portal the dialog out of any framer-motion-transformed ancestor
    // so ``fixed inset-0`` resolves to the viewport. SSR-safe: skip
    // render when document is unavailable (Vitest jsdom always has
    // it, but stay defensive).
    if (typeof document === 'undefined') return null
    return createPortal(
        <div
            className="fixed inset-0 z-[60] flex items-center justify-center p-4"
            onClick={(e) => {
                // Backdrop click cancels — only if the click landed on
                // the overlay itself, not propagated from the card.
                if (e.target === e.currentTarget) onCancel()
            }}
        >
            {/* Backdrop — solid-ish dim with subtle blur. Works in
                both themes because rgba black darkens whatever it
                sits over. */}
            <div className="absolute inset-0 bg-black/50" aria-hidden />
            <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.15 }}
                className={cn(
                    'relative w-full max-w-md rounded-2xl overflow-hidden',
                    // Solid bg in both themes — no /98 transparency.
                    // ``canvas-elevated`` is white in light mode,
                    // #161b22 in dark mode, both fully opaque.
                    'bg-canvas-elevated',
                    // Border: glass-border is barely visible white in
                    // light mode against a white card. Pair it with a
                    // theme-aware slate border so the card has a
                    // crisp edge regardless of theme.
                    'border border-slate-200 dark:border-glass-border',
                    'shadow-2xl shadow-black/40',
                )}
                role="dialog"
                aria-modal="true"
                aria-labelledby="save-query-title"
            >
                {/* Header */}
                <div className={cn(
                    'flex items-center gap-3 px-5 py-4',
                    'border-b border-slate-200 dark:border-glass-border/60',
                )}>
                    <div className={cn(
                        'w-10 h-10 rounded-xl flex items-center justify-center shrink-0',
                        'bg-cyan-50 dark:bg-cyan-950/30',
                    )}>
                        <BookmarkPlus className="w-5 h-5 text-cyan-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3
                            id="save-query-title"
                            className="text-[15px] font-display font-bold text-ink leading-tight"
                        >
                            Save query
                        </h3>
                        <p className="text-[11.5px] text-ink-muted mt-0.5">
                            Give it a name so you can find it later.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onCancel}
                        className={cn(
                            'inline-flex items-center justify-center w-8 h-8 rounded-lg',
                            'text-ink-muted hover:text-ink transition-colors',
                            'hover:bg-black/5 dark:hover:bg-white/5',
                        )}
                        aria-label="Cancel"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Body */}
                <div className="px-5 py-4 space-y-4">
                    <label className="block">
                        <span className="block text-[11.5px] font-semibold text-ink-secondary mb-1.5">
                            Name
                        </span>
                        <input
                            ref={nameRef}
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="e.g. PII columns missing owners"
                            className={cn(
                                'w-full px-3.5 py-2 rounded-xl text-[13px]',
                                // Theme-adaptive input bg — proven
                                // pattern from CreateOntologyDialog.
                                'bg-black/[0.03] dark:bg-white/[0.03]',
                                'border border-slate-200 dark:border-glass-border',
                                'text-ink placeholder:text-ink-muted/60',
                                'focus:outline-none focus:ring-2 focus:ring-cyan-500/40',
                                'focus:border-cyan-500/60',
                                'transition-colors duration-150',
                            )}
                        />
                    </label>

                    <label className="block">
                        <span className="block text-[11.5px] font-semibold text-ink-secondary mb-1.5">
                            Description{' '}
                            <span className="font-normal text-ink-muted/70">
                                (optional)
                            </span>
                        </span>
                        <input
                            type="text"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="One-line context for future-you"
                            className={cn(
                                'w-full px-3.5 py-2 rounded-xl text-[13px]',
                                'bg-black/[0.03] dark:bg-white/[0.03]',
                                'border border-slate-200 dark:border-glass-border',
                                'text-ink placeholder:text-ink-muted/60',
                                'focus:outline-none focus:ring-2 focus:ring-cyan-500/40',
                                'focus:border-cyan-500/60',
                                'transition-colors duration-150',
                            )}
                        />
                    </label>

                    <div>
                        <span className="block text-[11.5px] font-semibold text-ink-secondary mb-1.5">
                            Query preview
                        </span>
                        <pre className={cn(
                            'px-3.5 py-2.5 rounded-xl max-h-[96px] overflow-y-auto',
                            'bg-black/[0.04] dark:bg-white/[0.03]',
                            'border border-slate-200 dark:border-glass-border',
                            'text-[11.5px] font-mono text-ink-secondary leading-snug',
                            'whitespace-pre-wrap break-all m-0',
                        )}>
                            {entry.label || '(empty)'}
                        </pre>
                    </div>
                </div>

                {/* Footer */}
                <div className={cn(
                    'flex items-center justify-end gap-2 px-5 py-3.5',
                    'border-t border-slate-200 dark:border-glass-border/60',
                    'bg-black/[0.02] dark:bg-white/[0.02]',
                )}>
                    <button
                        type="button"
                        onClick={onCancel}
                        className={cn(
                            'inline-flex items-center px-3.5 h-8 rounded-lg',
                            'text-[12px] font-medium',
                            'text-ink-secondary hover:text-ink',
                            'hover:bg-black/5 dark:hover:bg-white/5',
                            'transition-colors',
                        )}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={handleSubmit}
                        disabled={!canSave}
                        className={cn(
                            'inline-flex items-center gap-1.5 px-3.5 h-8 rounded-lg',
                            'text-[12px] font-semibold transition-colors',
                            canSave
                                // Solid cyan button with WHITE text in both
                                // themes (text-canvas-base became near-white
                                // on cyan in light mode → invisible).
                                ? cn(
                                    'bg-cyan-600 hover:bg-cyan-700 text-white',
                                    'shadow-sm shadow-cyan-600/30',
                                )
                                : cn(
                                    'bg-slate-100 dark:bg-white/5',
                                    'text-slate-400 dark:text-ink-muted/60',
                                    'cursor-not-allowed',
                                ),
                        )}
                    >
                        <BookmarkPlus className="w-3.5 h-3.5" />
                        Save
                    </button>
                </div>
            </motion.div>
        </div>,
        document.body,
    )
}
