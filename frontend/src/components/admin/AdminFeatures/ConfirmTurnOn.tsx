/**
 * Turning on a switch that says what turning it on MEANS asks first.
 *
 * Most switches give a capability back when they go on, and that is instant (see ConfirmTurnOff for
 * the other direction). A few are the opposite: turning one on starts the platform doing something
 * to every user's data — Graph residency starts evicting graphs from memory. Such a switch declares
 * ``impactWhenOn``, and this dialog is the moment an admin is guaranteed to read it, with the docs
 * one click away. A switch without it never opens this.
 */
import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { BookOpen, Loader2, Power, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FeatureDefinition } from '@/services/featuresService'

export function ConfirmTurnOn({
    feature,
    onCancel,
    onConfirm,
}: {
    /** null closes it. */
    feature: FeatureDefinition | null
    onCancel: () => void
    onConfirm: () => void | Promise<void>
}) {
    const [busy, setBusy] = useState(false)

    const commit = async () => {
        setBusy(true)
        try {
            await onConfirm()
        } finally {
            setBusy(false)
        }
    }

    return (
        <Dialog.Root
            open={Boolean(feature)}
            onOpenChange={open => {
                if (!open && !busy) onCancel()
            }}
        >
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in" />
                <Dialog.Content
                    className={cn(
                        'fixed left-1/2 top-1/2 z-[60] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2',
                        'max-h-[85vh] overflow-y-auto',
                        'rounded-2xl border border-glass-border bg-canvas-elevated shadow-2xl focus:outline-none',
                        'data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95',
                    )}
                >
                    {feature && (
                        <>
                            <div className="flex items-start gap-4 p-6 pb-4">
                                <div className="w-11 h-11 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center shrink-0">
                                    <Power className="w-5 h-5 text-indigo-600 dark:text-indigo-400" />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <Dialog.Title className="text-lg font-bold tracking-tight text-ink">
                                        Turn on {feature.name}?
                                    </Dialog.Title>
                                    <Dialog.Description className="mt-1 text-xs text-ink-muted">
                                        This applies to the whole deployment.
                                    </Dialog.Description>
                                </div>
                                <Dialog.Close
                                    disabled={busy}
                                    className="p-2 -m-1 rounded-xl text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors shrink-0 disabled:opacity-50"
                                    aria-label="Cancel"
                                >
                                    <X className="w-4 h-4" />
                                </Dialog.Close>
                            </div>

                            <div className="px-6 pb-2 space-y-4">
                                <div className="rounded-2xl border border-indigo-500/25 bg-indigo-500/[0.06] p-4">
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-indigo-700 dark:text-indigo-300">
                                        What turning it on means
                                    </p>
                                    <p className="mt-1.5 text-xs text-ink-secondary leading-relaxed">
                                        {feature.impactWhenOn}
                                    </p>
                                </div>
                                {feature.helpUrl && (
                                    <a
                                        href={feature.helpUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1.5 text-xs font-medium text-accent-lineage hover:underline"
                                    >
                                        <BookOpen className="w-3.5 h-3.5" />
                                        Read more
                                    </a>
                                )}
                            </div>

                            <div className="sticky bottom-0 flex items-center justify-end gap-2 p-6 pt-5 bg-canvas-elevated/95 backdrop-blur">
                                <button
                                    type="button"
                                    onClick={onCancel}
                                    disabled={busy}
                                    className="px-4 py-2.5 rounded-xl text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                                >
                                    Keep it off
                                </button>
                                <button
                                    type="button"
                                    onClick={commit}
                                    disabled={busy}
                                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors disabled:opacity-60 shadow-lg shadow-indigo-600/20"
                                >
                                    {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                                    Turn on for everyone
                                </button>
                            </div>
                        </>
                    )}
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    )
}
