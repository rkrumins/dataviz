/**
 * The drawer a connection or a knowledge source is edited in — the shape of
 * SSO's `ProviderEditorDrawer`: a header that says what is being edited, a
 * body that scrolls, and a footer that says what is unsaved. Closing with
 * unsaved edits asks first.
 *
 * The scrim is a `<Backdrop>` sibling and the panel carries no exit
 * animation, so an interrupted close cannot strand a click-blocker.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { AlertCircle, Loader2, Save, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import { DocsLink } from '@/components/help/DocsLink'

export function EditorDrawer({
    icon: Icon, title, subtitle, badges, dirty, changedCount, valid, saving, saveError,
    saveLabel = 'Save changes', onSave, onClose, children,
}: {
    icon: LucideIcon
    title: string
    subtitle?: string
    badges?: ReactNode
    dirty: boolean
    changedCount: number
    valid: boolean
    saving: boolean
    saveError: string | null
    saveLabel?: string
    onSave: () => void
    onClose: () => void
    children: ReactNode
}) {
    const titleId = useId()
    const panel = useRef<HTMLDivElement>(null)
    const [confirmDiscard, setConfirmDiscard] = useState(false)

    useEffect(() => { panel.current?.focus() }, [])

    function requestClose() {
        if (dirty) { setConfirmDiscard(true); return }
        onClose()
    }

    useEffect(() => {
        function esc(e: KeyboardEvent) {
            if (e.key === 'Escape' && !confirmDiscard) requestClose()
        }
        document.addEventListener('keydown', esc)
        return () => document.removeEventListener('keydown', esc)
    })

    const canSave = dirty && valid && !saving

    return (
        <>
            <Backdrop open onClick={requestClose} zClassName="z-50" className="bg-black/60" />
            <motion.div
                ref={panel}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                initial={{ x: 40, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                transition={{ duration: 0.14, ease: 'easeOut' }}
                className="fixed inset-y-0 right-0 z-[51] w-full max-w-[760px] bg-canvas-elevated shadow-2xl flex flex-col focus:outline-none"
            >
                <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-glass-border bg-gradient-to-r from-black/[0.02] to-transparent dark:from-white/[0.02]">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-xl bg-black/[0.04] dark:bg-white/[0.06] flex items-center justify-center shrink-0">
                            <Icon className="w-5 h-5 text-violet-500" />
                        </div>
                        <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                                <h2 id={titleId} className="text-lg font-bold text-ink truncate">{title}</h2>
                                {badges}
                            </div>
                            {subtitle && <p className="text-xs text-ink-muted font-mono truncate">{subtitle}</p>}
                        </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                        <DocsLink slug="ai-assistant" variant="icon" />
                        <button
                            onClick={requestClose}
                            aria-label="Close"
                            className="p-2 rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10"
                        >
                            <X className="w-4 h-4 text-ink-muted" />
                        </button>
                    </div>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-8">{children}</div>

                <div className="flex items-center justify-between gap-4 px-6 py-4 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02]">
                    <div className="min-w-0 text-xs">
                        {saveError ? (
                            <span className="flex items-start gap-1.5 text-red-500">
                                <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0" />
                                {saveError}
                            </span>
                        ) : dirty && !valid ? (
                            <span className="flex items-center gap-1.5 text-red-500">
                                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                                Fix the fields marked in red to save.
                            </span>
                        ) : dirty ? (
                            <span className="flex items-center gap-1.5 text-ink-muted">
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                                {changedCount} unsaved change{changedCount === 1 ? '' : 's'}
                            </span>
                        ) : (
                            <span className="text-ink-muted">No changes</span>
                        )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <button
                            onClick={requestClose}
                            className="px-4 py-2 rounded-xl text-sm font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={onSave}
                            disabled={!canSave}
                            className={cn(
                                'flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-medium transition-colors duration-150',
                                canSave
                                    ? 'bg-gradient-to-r from-indigo-500 to-violet-600 text-white hover:brightness-110 shadow-md'
                                    : 'bg-black/5 dark:bg-white/5 text-ink-muted cursor-not-allowed',
                            )}
                        >
                            {saving
                                ? <><Loader2 className="w-4 h-4 animate-spin" />Saving…</>
                                : <><Save className="w-4 h-4" />{saveLabel}</>}
                        </button>
                    </div>
                </div>
            </motion.div>

            {confirmDiscard && (
                <>
                    <Backdrop open zClassName="z-[60]" className="bg-black/50" />
                    <div className="fixed inset-0 z-[61] flex items-center justify-center p-4 pointer-events-none">
                        <div role="alertdialog" aria-modal="true" className="pointer-events-auto w-full max-w-sm rounded-2xl bg-canvas-elevated shadow-xl p-5">
                            <h3 className="text-base font-bold text-ink">
                                Discard {changedCount} unsaved change{changedCount === 1 ? '' : 's'}?
                            </h3>
                            <p className="mt-1.5 text-xs text-ink-muted">Closing now throws them away. Nothing has been saved.</p>
                            <div className="mt-4 flex justify-end gap-2">
                                <button
                                    onClick={() => setConfirmDiscard(false)}
                                    className="px-4 py-2 rounded-xl text-sm font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5"
                                >
                                    Keep editing
                                </button>
                                <button
                                    onClick={onClose}
                                    className="px-4 py-2 rounded-xl text-sm font-medium bg-red-500 text-white hover:bg-red-600"
                                >
                                    Discard
                                </button>
                            </div>
                        </div>
                    </div>
                </>
            )}
        </>
    )
}

/** A titled block inside the drawer. */
export function DrawerSection({ title, blurb, children }: { title: string; blurb?: ReactNode; children: ReactNode }) {
    return (
        <section className="space-y-4">
            <header>
                <h3 className="text-base font-bold text-ink">{title}</h3>
                {blurb && <p className="mt-1 text-xs text-ink-muted leading-relaxed max-w-xl">{blurb}</p>}
            </header>
            {children}
        </section>
    )
}
