/**
 * ProviderHoldDialog — pause, stop or resume automatic rebuilds for every
 * source under a provider (system:admin only; the caller hides the entry
 * point). It is the drawer's snooze row at provider scope, in a dialog,
 * writing immediately — one control, not a second idiom.
 */
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { PauseCircle } from 'lucide-react'
import { Backdrop } from '@/components/ui/Backdrop'
import { useAppNotifications } from '@/components/ui/notifications'
import type { ProviderFreshnessSummary } from '@/services/freshnessService'
import { useSetProviderHold } from './useFreshness'
import { SnoozeRow } from './SnoozeRow'

export function ProviderHoldDialog({ providerId, providerName, current, isOpen, onClose }: {
    providerId: string | null
    providerName: string
    /** The provider's summary, which carries its own hold (``heldBy ===
     *  'provider'``) or the fleet's (``'fleet'``, which outranks it). Null
     *  above the summary cap — the row then offers the controls blind. */
    current?: ProviderFreshnessSummary | null
    isOpen: boolean
    onClose: () => void
}) {
    const { notify } = useAppNotifications()
    const setHold = useSetProviderHold()

    if (!isOpen || !providerId) return null

    const own = current?.heldBy === 'provider'
    const inherited = current?.heldBy === 'fleet'
        ? { scope: 'fleet' as const, kind: current.heldKind ?? 'stopped', until: current.heldUntil ?? null }
        : null

    return createPortal(
        <>
            <Backdrop open={isOpen} onClick={onClose} zClassName="z-50" className="bg-black/50" />
            {/* No AnimatePresence: this portaled popover unmounts instantly on close so an interrupted exit can't strand an invisible click-blocker over the page. It still animates in. */}
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
                <motion.div
                    initial={{ scale: 0.96, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ duration: 0.12 }}
                    onClick={(e) => e.stopPropagation()}
                    className="pointer-events-auto w-full max-w-lg rounded-2xl bg-canvas-elevated border border-glass-border shadow-lg overflow-hidden"
                    role="dialog" aria-modal="true" aria-label="Pause provider"
                >
                    <div className="h-1 bg-gradient-to-r from-slate-500 to-slate-600" />
                    <div className="p-6">
                        <div className="flex items-center gap-2 mb-1">
                            <PauseCircle className="w-4 h-4 text-slate-500" />
                            <h3 className="text-lg font-bold text-ink">
                                {own ? `Resume ${providerName}` : `Pause ${providerName}`}
                            </h3>
                        </div>
                        <p className="text-sm text-ink-muted mb-3">
                            Holds automatic rebuilds for every live data source using this
                            provider. Drift is still detected and shown; nothing is rebuilt
                            automatically until the hold lapses or is resumed. Refreshing a
                            source by hand still works.
                        </p>

                        <div className="border-t border-glass-border/50">
                            <SnoozeRow
                                scope="provider"
                                idPrefix={`provider-hold-${providerId}`}
                                pausedUntil={own && current?.heldKind === 'paused' ? current.heldUntil : null}
                                stoppedAt={own && current?.heldKind === 'stopped' ? 'stopped' : null}
                                inherited={inherited}
                                allowStop
                                pending={setHold.isPending}
                                onPatch={(patch, ok) => setHold.mutate(
                                    { providerId, ...patch },
                                    {
                                        onSuccess: () => {
                                            notify('success', `${providerName}: ${ok}`)
                                            onClose()
                                        },
                                        onError: (e) => notify('error', e.message || 'Could not update the provider hold.'),
                                    },
                                )}
                            />
                        </div>

                        <div className="flex justify-end mt-4">
                            <button
                                type="button"
                                onClick={onClose}
                                className="px-4 py-2 rounded-xl text-sm font-semibold text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </motion.div>
            </div>
        </>,
        document.body,
    )
}
