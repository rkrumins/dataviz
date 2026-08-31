/**
 * The board's drill-down.
 *
 * The board answers "what moved"; this answers "what happened to THAT one",
 * and it opens over the board rather than navigating away — so the operator
 * keeps their place, their filters and their window. Closing it returns them
 * to exactly the list they were reading, which a route change cannot promise.
 *
 * NO `AnimatePresence` with an `exit`. A portaled exit animation leaves an
 * invisible, still-mounted overlay intercepting clicks for as long as the
 * transition claims to be running — the click-freeze class this codebase has
 * already been bitten by three times. The panel animates in and unmounts
 * immediately on close.
 */
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { ExternalLink, X } from 'lucide-react'
import { Link } from 'react-router-dom'

import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import type { BoardRow } from '@/types/profiling'
import { SourceProfiling } from './SourceProfiling'
import { significanceMeta } from './shared'
import { MOTION } from '@/lib/motion'

export function ProfilingSourceDrawer({
    row, onClose,
}: { row: BoardRow | null; onClose: () => void }) {
    useEffect(() => {
        if (!row) return
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [row, onClose])

    if (!row) return null
    const meta = significanceMeta(row.significance)

    return createPortal(
        <>
            <Backdrop open onClick={onClose} />
            <motion.aside
                role="dialog"
                aria-label={`Profiling for ${row.name}`}
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                transition={MOTION.drawerSlide}
                className={cn(
                    'fixed right-0 top-0 z-50 h-full w-full max-w-3xl',
                    'overflow-y-auto bg-canvas border-l border-glass-border shadow-2xl',
                )}
            >
                <header className="sticky top-0 z-10 bg-canvas/90 backdrop-blur border-b border-glass-border">
                    <div className="flex items-start justify-between gap-3 px-6 py-4">
                        <div className="min-w-0">
                            <h2 className="text-lg font-bold text-ink truncate">{row.name}</h2>
                            <p className="text-xs text-ink-muted mt-0.5 flex flex-wrap items-center gap-x-2">
                                <span>{row.provider_name || 'Unknown provider'}</span>
                                {row.significance !== 'normal' && (
                                    <span className={cn('font-bold uppercase tracking-wide', meta.tone)}>
                                        · {meta.label}
                                    </span>
                                )}
                            </p>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                            {row.catalog_item_id && (
                                <Link
                                    to={`/datasources/${row.catalog_item_id}`}
                                    onClick={onClose}
                                    className={cn(
                                        'inline-flex items-center gap-1.5 rounded-lg border border-glass-border',
                                        'px-2.5 py-1.5 text-xs font-semibold text-ink-secondary',
                                        'hover:text-ink hover:bg-canvas-elevated transition-colors',
                                    )}
                                >
                                    <ExternalLink className="w-3.5 h-3.5" aria-hidden /> Open source
                                </Link>
                            )}
                            <button
                                type="button"
                                onClick={onClose}
                                aria-label="Close"
                                className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                </header>

                <div className="px-6 py-5">
                    <SourceProfiling
                        dataSourceId={row.data_source_id}
                        sourceName={row.name}
                    />
                </div>
            </motion.aside>
        </>,
        document.body,
    )
}
