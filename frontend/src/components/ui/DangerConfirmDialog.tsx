/**
 * DangerConfirmDialog — type-to-confirm + blast radius, for anything irreversible.
 *
 * The pattern already existed THREE times: DeleteProviderDialog (which says in its
 * own header "Pattern follows DeleteViewDialog"), DeleteViewDialog, and
 * BulkDeleteDialog. Each hard-codes its resource type, its section labels and its
 * button copy, so they drift: only the provider one lists an impact, only the bulk
 * one counts, and none of them could be pointed at a workspace.
 *
 * This is the same dialog with the resource pulled out into props: a name to type,
 * a list of impact SECTIONS to expand, and the copy. Workspace deletion uses it for
 * both the single and the bulk path.
 *
 * The two states that matter:
 *   • impact still loading → the confirm button stays disabled. Letting someone
 *     confirm a destruction whose scale we haven't measured yet is the bug this
 *     whole component exists to prevent.
 *   • nothing will be destroyed → say so, in green, and stop scaring them.
 */
import { useState, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import {
    X, Trash2, AlertTriangle, ChevronDown, CheckCircle2, Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'

export interface ImpactSection {
    /** "Views", "Data sources" — plural, it's a count line. */
    label: string
    /** What happens to them. "Permanently deleted", "Access revoked". */
    consequence: string
    count: number
    /** Optional names to expand. Omit for count-only sections (e.g. members). */
    items?: { id: string; name: string }[]
    tone?: 'destructive' | 'warning'
}

export function DangerConfirmDialog({
    isOpen,
    title,
    subtitle,
    /** The exact string the user must type. Usually the resource's name. */
    confirmPhrase,
    confirmLabel = 'Delete',
    sections,
    loadingImpact,
    /**
     * The impact probe FAILED. Distinct from "the impact is empty" — see below.
     */
    impactUnknown,
    /** Shown when every section is empty — the honest "this is safe" case. */
    safeMessage = 'Nothing else will be affected.',
    /** Anything the deletion does NOT do, that a reasonable person would assume it does. */
    caveat,
    onClose,
    onConfirm,
}: {
    isOpen: boolean
    title: string
    subtitle?: string
    confirmPhrase: string
    confirmLabel?: string
    sections: ImpactSection[]
    loadingImpact?: boolean
    impactUnknown?: boolean
    safeMessage?: string
    caveat?: string
    onClose: () => void
    onConfirm: () => void | Promise<void>
}) {
    const [confirmText, setConfirmText] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [expanded, setExpanded] = useState<Record<string, boolean>>({})

    // A reopened dialog must never start with the previous resource's text still
    // typed in — that would let a second delete through with one click.
    useEffect(() => {
        if (isOpen) {
            setConfirmText('')
            setError(null)
            setExpanded({})
        }
    }, [isOpen, confirmPhrase])

    const total = sections.reduce((n, s) => n + s.count, 0)
    const typedCorrectly = confirmText === confirmPhrase
    // Never let someone confirm before we know the scale of what they're destroying.
    const canConfirm = typedCorrectly && !loadingImpact && !busy
    const progress = confirmPhrase.length > 0
        ? Math.min(confirmText.length / confirmPhrase.length, 1)
        : 0

    const handleConfirm = useCallback(async () => {
        if (!canConfirm) return
        setBusy(true)
        setError(null)
        try {
            await onConfirm()
            onClose()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed. Nothing was deleted.')
        } finally {
            setBusy(false)
        }
    }, [canConfirm, onConfirm, onClose])

    const handleClose = useCallback(() => {
        if (busy) return
        onClose()
    }, [busy, onClose])

    if (!isOpen) return null

    return createPortal(
        <>
            <Backdrop open onClick={handleClose} zClassName="z-[80]" className="bg-black/60" />
            <div className="fixed inset-0 z-[81] flex items-center justify-center p-4 pointer-events-none">
                <motion.div
                    initial={{ scale: 0.95, opacity: 0, y: 8 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    transition={{ type: 'spring', damping: 25, stiffness: 350 }}
                    onClick={e => e.stopPropagation()}
                    className="pointer-events-auto w-full max-w-lg max-h-[85vh] flex flex-col bg-canvas rounded-2xl shadow-2xl shadow-black/30 overflow-hidden border border-glass-border"
                >
                    <div className="relative shrink-0">
                        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-red-500 to-rose-500" />
                        <div className="flex items-center gap-3.5 px-6 pt-6 pb-4">
                            <div className="w-11 h-11 rounded-xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 flex items-center justify-center shrink-0">
                                <Trash2 className="w-5 h-5 text-red-500" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <h3 className="text-lg font-bold text-ink">{title}</h3>
                                {subtitle && (
                                    <p className="text-sm text-ink-muted truncate">{subtitle}</p>
                                )}
                            </div>
                            <button
                                onClick={handleClose}
                                disabled={busy}
                                className="p-2 rounded-xl text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-40"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                    </div>

                    <div className="px-6 pb-5 space-y-4 overflow-y-auto custom-scrollbar">
                        {loadingImpact && (
                            <div className="flex items-center justify-center gap-2 py-8 text-ink-muted">
                                <Loader2 className="w-4 h-4 animate-spin" />
                                <span className="text-sm">Working out what this will destroy…</span>
                            </div>
                        )}

                        {/* "We could not find out" is NOT "there is nothing to find". A failed
                            impact probe used to land in the green panel below and tell the user
                            "Nothing else will be affected" — the single most dangerous sentence
                            we could invent at exactly the moment we knew least. It gets its own
                            state, and it is amber, not green. */}
                        {!loadingImpact && impactUnknown && (
                            <div className="rounded-xl bg-amber-50 dark:bg-amber-500/[0.08] border border-amber-200 dark:border-amber-500/20 px-4 py-3.5 flex items-start gap-2.5">
                                <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                                <p className="text-sm text-amber-800 dark:text-amber-300">
                                    We couldn&rsquo;t check what this will affect. It may destroy more
                                    than you expect &mdash; try again in a moment, or continue only if
                                    you are certain.
                                </p>
                            </div>
                        )}

                        {!loadingImpact && !impactUnknown && total === 0 && (
                            <div className="rounded-xl bg-emerald-50 dark:bg-emerald-500/[0.08] border border-emerald-200 dark:border-emerald-500/20 px-4 py-3.5 flex items-start gap-2.5">
                                <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" />
                                <p className="text-sm text-emerald-800 dark:text-emerald-300">{safeMessage}</p>
                            </div>
                        )}

                        {!loadingImpact && !impactUnknown && total > 0 && (
                            <div className="rounded-xl bg-red-50 dark:bg-red-500/[0.08] border border-red-200 dark:border-red-500/20 px-4 py-3.5">
                                <div className="flex items-center gap-2 mb-3">
                                    <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
                                    <h4 className="text-xs font-bold uppercase tracking-wider text-red-600 dark:text-red-400">
                                        This will destroy
                                    </h4>
                                </div>

                                <ul className="space-y-1.5">
                                    {sections.filter(s => s.count > 0).map(section => {
                                        const open = expanded[section.label]
                                        const canExpand = (section.items?.length ?? 0) > 0
                                        return (
                                            <li key={section.label}>
                                                <button
                                                    type="button"
                                                    disabled={!canExpand}
                                                    onClick={() => setExpanded(p => ({ ...p, [section.label]: !p[section.label] }))}
                                                    className={cn(
                                                        'w-full flex items-center gap-2 text-left rounded-lg px-2 py-1.5 -mx-2',
                                                        canExpand && 'hover:bg-red-500/10 transition-colors',
                                                    )}
                                                >
                                                    <span className="text-sm font-bold text-ink tabular-nums shrink-0">
                                                        {section.count}
                                                    </span>
                                                    <span className="text-sm text-ink min-w-0 flex-1">
                                                        {section.label}
                                                        <span className="text-ink-muted"> — {section.consequence}</span>
                                                    </span>
                                                    {canExpand && (
                                                        <ChevronDown className={cn(
                                                            'w-3.5 h-3.5 text-ink-muted shrink-0 transition-transform',
                                                            open && 'rotate-180',
                                                        )} />
                                                    )}
                                                </button>

                                                {open && section.items && (
                                                    <ul className="mt-1 mb-2 ml-6 space-y-0.5 max-h-32 overflow-y-auto custom-scrollbar">
                                                        {section.items.map(item => (
                                                            <li key={item.id} className="text-xs text-ink-muted truncate">
                                                                {item.name}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )}
                                            </li>
                                        )
                                    })}
                                </ul>

                                <p className="mt-3 pt-3 border-t border-red-200 dark:border-red-500/20 text-[11px] font-bold uppercase tracking-wider text-red-600 dark:text-red-400">
                                    This cannot be undone
                                </p>
                            </div>
                        )}

                        {/* What the delete does NOT do. Silence here reads as "it's
                            all cleaned up", which is how orphans are born. */}
                        {caveat && !loadingImpact && (
                            <p className="text-[11px] text-ink-muted leading-relaxed rounded-lg border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] px-3 py-2">
                                {caveat}
                            </p>
                        )}

                        <div>
                            <label className="block text-xs font-medium text-ink-muted mb-1.5">
                                Type <span className="font-bold text-ink">{confirmPhrase}</span> to confirm
                            </label>
                            <input
                                autoFocus
                                value={confirmText}
                                onChange={e => setConfirmText(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter' && canConfirm) handleConfirm() }}
                                placeholder={confirmPhrase}
                                disabled={busy}
                                className={cn(
                                    'w-full px-3.5 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border text-sm text-ink',
                                    'placeholder:text-ink-muted/50 focus:outline-none focus:ring-2 transition-colors',
                                    typedCorrectly
                                        ? 'border-red-500/50 focus:ring-red-500/40'
                                        : 'border-glass-border focus:ring-red-500/20',
                                )}
                            />
                            <div className="mt-1.5 h-0.5 rounded-full bg-black/5 dark:bg-white/10 overflow-hidden">
                                <div
                                    className="h-full bg-gradient-to-r from-red-500 to-rose-500 transition-[width] duration-150"
                                    style={{ width: `${progress * 100}%` }}
                                />
                            </div>
                        </div>

                        {error && (
                            <p className="text-xs text-red-500 flex items-center gap-1.5">
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                {error}
                            </p>
                        )}
                    </div>

                    <div className="shrink-0 flex items-center justify-end gap-2 px-6 py-4 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02]">
                        <button
                            onClick={handleClose}
                            disabled={busy}
                            className="px-4 py-2.5 rounded-xl border border-glass-border text-sm font-medium text-ink-muted hover:text-ink transition-colors disabled:opacity-40"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleConfirm}
                            disabled={!canConfirm}
                            className={cn(
                                'inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold text-white transition-all',
                                canConfirm
                                    ? 'bg-gradient-to-r from-red-500 to-rose-600 shadow-lg shadow-red-500/25 hover:shadow-xl hover:-translate-y-0.5'
                                    : 'bg-slate-300 dark:bg-slate-700 cursor-not-allowed',
                            )}
                        >
                            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                            {busy ? 'Deleting…' : confirmLabel}
                        </button>
                    </div>
                </motion.div>
            </div>
        </>,
        document.body,
    )
}
