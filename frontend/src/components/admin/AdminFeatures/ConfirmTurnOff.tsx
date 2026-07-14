/**
 * Turning a feature OFF asks first. Turning it back ON does not.
 *
 * The asymmetry is the point. These two directions are not equally consequential: turning a
 * feature on gives a capability back and can be undone by looking at the screen, while turning one
 * off silently removes something from every user of the deployment at once — and the person doing
 * it is, by definition, not the person who will notice.
 *
 * The product already treats deletion this way (DangerConfirmDialog on workspaces and providers).
 * This is the same principle applied to the other action that changes what everybody can do, but
 * lighter: no type-to-confirm, because this is reversible and nothing is destroyed. What it does
 * insist on is that you SEE the consequence at the moment you commit to it — not on a card you
 * scrolled past, not in a panel you didn't open.
 *
 * It is also the only place the impact copy is unavoidable, which is why it exists at all.
 */
import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { AlertTriangle, Check, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FeatureDefinition } from '@/services/featuresService'

export function ConfirmTurnOff({
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
                        'fixed left-1/2 top-1/2 z-[60] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2',
                        'rounded-3xl border border-glass-border bg-canvas-elevated shadow-2xl focus:outline-none',
                        'data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95',
                    )}
                >
                    {feature && (
                        <>
                            <div className="flex items-start gap-4 p-6 pb-4">
                                <div className="w-11 h-11 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center shrink-0">
                                    <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <Dialog.Title className="text-lg font-bold tracking-tight text-ink">
                                        Turn off {feature.name}?
                                    </Dialog.Title>
                                    <Dialog.Description className="mt-1 text-xs text-ink-muted">
                                        This takes effect immediately, for every user.
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
                                {feature.impactWhenOff && (
                                    <div className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.07] p-4">
                                        <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
                                            What your users lose
                                        </p>
                                        <p className="mt-1.5 text-xs text-ink-secondary leading-relaxed">
                                            {feature.impactWhenOff}
                                        </p>
                                    </div>
                                )}

                                {/* The reassurance half. Turning a feature off is not destructive, and an
                                    admin who doesn't know that will hesitate over a switch they should
                                    feel free to use. */}
                                {(feature.stillAllowed?.length ?? 0) > 0 && (
                                    <div>
                                        <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                                            Still works
                                        </p>
                                        <ul className="mt-2 space-y-1.5">
                                            {feature.stillAllowed!.map(item => (
                                                <li
                                                    key={item}
                                                    className="flex items-start gap-2 text-xs text-ink-secondary leading-relaxed"
                                                >
                                                    <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
                                                    {item}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </div>

                            <div className="flex items-center justify-end gap-2 p-6 pt-5">
                                <button
                                    type="button"
                                    onClick={onCancel}
                                    disabled={busy}
                                    className="px-4 py-2.5 rounded-xl text-sm font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                                >
                                    Keep it on
                                </button>
                                <button
                                    type="button"
                                    onClick={commit}
                                    disabled={busy}
                                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700 transition-colors disabled:opacity-60 shadow-lg shadow-amber-600/20"
                                >
                                    {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                                    Turn off for everyone
                                </button>
                            </div>
                        </>
                    )}
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    )
}
