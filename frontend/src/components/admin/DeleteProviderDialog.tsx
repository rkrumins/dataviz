/**
 * DeleteProviderDialog — Enterprise-grade delete confirmation with type-to-confirm.
 * Renders via portal so it layers correctly above drawers and other overlays.
 * Pattern follows DeleteViewDialog from the explorer.
 */
import { useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Trash2, AlertCircle, Zap, ChevronDown, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ProviderResponse, ProviderImpactResponse } from '@/services/providerService'

interface DeleteProviderDialogProps {
    provider: ProviderResponse | null
    impact: ProviderImpactResponse | null
    loadingImpact: boolean
    isOpen: boolean
    onClose: () => void
    onConfirm: () => void | Promise<void>
}

export function DeleteProviderDialog({
    provider,
    impact,
    loadingImpact,
    isOpen,
    onClose,
    onConfirm,
}: DeleteProviderDialogProps) {
    const [confirmText, setConfirmText] = useState('')
    const [deleting, setDeleting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({})

    const providerName = provider?.name ?? ''
    const canDelete = confirmText === providerName
    const typingProgress = providerName.length > 0 ? confirmText.length / providerName.length : 0

    const totalImpact = impact
        ? impact.catalogItems.length + impact.workspaces.length + impact.views.length
        : 0

    const handleDelete = useCallback(async () => {
        if (!canDelete) return
        setDeleting(true)
        setError(null)
        try {
            await onConfirm()
            onClose()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to delete provider')
        } finally {
            setDeleting(false)
        }
    }, [canDelete, onConfirm, onClose])

    const handleClose = useCallback(() => {
        if (deleting) return
        setConfirmText('')
        setError(null)
        setExpandedSections({})
        onClose()
    }, [deleting, onClose])

    const toggleSection = (key: string) => {
        setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }))
    }

    if (!isOpen || !provider) return null

    const dialog = (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
                onClick={handleClose}
            >
                <motion.div
                    initial={{ scale: 0.95, opacity: 0, y: 8 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    exit={{ scale: 0.95, opacity: 0, y: 8 }}
                    transition={{ type: 'spring', damping: 25, stiffness: 350 }}
                    onClick={e => e.stopPropagation()}
                    className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl shadow-2xl shadow-black/20 overflow-hidden"
                >
                    {/* Red accent strip */}
                    <div className="relative">
                        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-red-500 to-rose-500" />
                        <div className="flex items-center gap-3.5 px-6 pt-6 pb-4">
                            <div className="w-11 h-11 rounded-xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 flex items-center justify-center">
                                <Trash2 className="w-5 h-5 text-red-500" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <h3 className="text-lg font-bold text-slate-900 dark:text-white">Delete Provider</h3>
                                <p className="text-sm text-slate-500 dark:text-slate-400 truncate">{providerName}</p>
                            </div>
                            <button
                                onClick={handleClose}
                                className="p-2 rounded-xl text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors duration-150"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                    </div>

                    {/* Body */}
                    <div className="px-6 pb-5 space-y-4">
                        {/* Loading impact */}
                        {loadingImpact && (
                            <div className="flex justify-center py-6">
                                <svg className="animate-spin h-6 w-6 text-slate-400" viewBox="0 0 24 24" fill="none">
                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                </svg>
                            </div>
                        )}

                        {/* Impact section */}
                        {!loadingImpact && impact && totalImpact > 0 && (
                            <div className="rounded-xl bg-red-50 dark:bg-red-500/[0.08] border border-red-200 dark:border-red-500/20 px-4 py-3.5">
                                <div className="flex items-center gap-2 mb-2">
                                    <Zap className="w-4 h-4 text-red-500" />
                                    <h4 className="text-sm font-semibold text-red-600 dark:text-red-400">Blast Radius Warning</h4>
                                </div>
                                <p className="text-xs text-red-500 dark:text-red-400 leading-relaxed mb-3">
                                    Deleting this infrastructure will permanently destroy the following dependent assets across the entire Enterprise:
                                </p>

                                {/* Catalog items */}
                                {impact.catalogItems.length > 0 && (
                                    <div className="mb-2">
                                        <button
                                            onClick={() => toggleSection('catalog')}
                                            className="flex items-center gap-1.5 text-xs font-semibold text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
                                        >
                                            <ChevronDown className={cn("w-3 h-3 transition-transform", expandedSections.catalog && "rotate-180")} />
                                            {impact.catalogItems.length} Enterprise Catalog Data Product{impact.catalogItems.length !== 1 ? 's' : ''}
                                        </button>
                                        {expandedSections.catalog && (
                                            <ul className="mt-1 ml-5 space-y-0.5">
                                                {impact.catalogItems.map(c => (
                                                    <li key={c.id} className="text-xs text-red-500 dark:text-red-400 font-mono">{c.name}</li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                )}

                                {/* Workspaces */}
                                {impact.workspaces.length > 0 && (
                                    <div className="mb-2">
                                        <button
                                            onClick={() => toggleSection('workspaces')}
                                            className="flex items-center gap-1.5 text-xs font-semibold text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
                                        >
                                            <ChevronDown className={cn("w-3 h-3 transition-transform", expandedSections.workspaces && "rotate-180")} />
                                            {impact.workspaces.length} Subscribing Workspace{impact.workspaces.length !== 1 ? 's' : ''}
                                        </button>
                                        {expandedSections.workspaces && (
                                            <ul className="mt-1 ml-5 space-y-0.5">
                                                {impact.workspaces.map(w => (
                                                    <li key={w.id} className="text-xs text-red-500 dark:text-red-400">{w.name}</li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                )}

                                {/* Views */}
                                {impact.views.length > 0 && (
                                    <div className="mb-2">
                                        <button
                                            onClick={() => toggleSection('views')}
                                            className="flex items-center gap-1.5 text-xs font-semibold text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
                                        >
                                            <ChevronDown className={cn("w-3 h-3 transition-transform", expandedSections.views && "rotate-180")} />
                                            {impact.views.length} Downstream Semantic View{impact.views.length !== 1 ? 's' : ''}
                                        </button>
                                        {expandedSections.views && (
                                            <ul className="mt-1 ml-5 space-y-0.5">
                                                {impact.views.map(v => (
                                                    <li key={v.id} className="text-xs text-red-500 dark:text-red-400">{v.name}</li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                )}

                                <p className="mt-3 text-red-400 text-[11px] uppercase tracking-wider font-bold">
                                    This action cannot be undone.
                                </p>
                            </div>
                        )}

                        {/* Safe to delete state */}
                        {!loadingImpact && impact && totalImpact === 0 && (
                            <div className="rounded-xl bg-emerald-50 dark:bg-emerald-500/[0.08] border border-emerald-200 dark:border-emerald-500/20 px-4 py-3.5">
                                <div className="flex items-center gap-2.5">
                                    <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                                    <div>
                                        <h4 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">Safe to delete</h4>
                                        <p className="text-xs text-emerald-600 dark:text-emerald-500 mt-0.5">
                                            No workspaces or views depend on this provider.
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Type to confirm */}
                        <div>
                            <label className="block text-sm font-medium text-slate-600 dark:text-slate-400 mb-2">
                                Type <code className="px-1.5 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 text-xs font-mono font-bold">{providerName}</code> to confirm
                            </label>
                            <input
                                type="text"
                                value={confirmText}
                                onChange={e => setConfirmText(e.target.value)}
                                placeholder={providerName}
                                className={cn(
                                    'w-full px-4 py-3 rounded-xl border text-sm font-medium',
                                    'bg-slate-50 dark:bg-slate-800/50 text-slate-900 dark:text-white',
                                    'placeholder:text-slate-300 dark:placeholder:text-slate-600',
                                    'outline-none transition-all duration-200',
                                    canDelete
                                        ? 'border-red-400 dark:border-red-500/50 ring-2 ring-red-100 dark:ring-red-500/10'
                                        : 'border-slate-200 dark:border-slate-700 focus:border-slate-400 dark:focus:border-slate-500 focus:ring-2 focus:ring-slate-100 dark:focus:ring-slate-500/10'
                                )}
                                autoFocus
                                onKeyDown={e => { if (e.key === 'Enter' && canDelete) handleDelete() }}
                            />
                            {/* Typing progress indicator */}
                            <div className="mt-2 h-1 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                                <div
                                    className={cn(
                                        "h-full rounded-full transition-all duration-300",
                                        canDelete ? "bg-red-500" : "bg-slate-300 dark:bg-slate-600"
                                    )}
                                    style={{ width: `${Math.min(typingProgress * 100, 100)}%` }}
                                />
                            </div>
                        </div>

                        {error && (
                            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20">
                                <AlertCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
                                <p className="text-xs font-medium text-red-600 dark:text-red-400">{error}</p>
                            </div>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/30">
                        <button
                            onClick={handleClose}
                            disabled={deleting}
                            className="px-4 py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors duration-150"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleDelete}
                            disabled={!canDelete || deleting}
                            className={cn(
                                'px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200',
                                canDelete && !deleting
                                    ? 'bg-red-500 text-white hover:bg-red-600 shadow-lg shadow-red-500/25 hover:shadow-xl hover:-translate-y-0.5 active:translate-y-0'
                                    : 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-600 cursor-not-allowed'
                            )}
                        >
                            {deleting ? (
                                <span className="flex items-center gap-2">
                                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                    </svg>
                                    Deleting...
                                </span>
                            ) : (
                                <span className="flex items-center gap-2">
                                    <Trash2 className="w-3.5 h-3.5" />
                                    Delete Provider
                                </span>
                            )}
                        </button>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    )

    return createPortal(dialog, document.body)
}
