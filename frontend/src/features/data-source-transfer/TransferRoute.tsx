/**
 * TransferRoute — "from this workspace, to that one", drawn.
 *
 * Each workspace keeps the tile it has everywhere else (its monogram in the
 * colour keyed on its id), so the two ends are recognisable at a glance. The
 * connector draws itself once and the source rides it as a pill: transform
 * and opacity only, and MotionConfig quiets it for reduced motion.
 */
import { motion } from 'framer-motion'
import { ArrowRight, Database } from 'lucide-react'

import { accentFor, monogram } from '@/components/admin/WorkspaceCard'
import { cn } from '@/lib/utils'
import type { TransferWorkspaceRef } from '@/services/dataSourceTransferService'
import { workspaceLabel } from './transferCopy'

export function WorkspaceTile({ workspace, size = 'md', className }: {
    workspace: TransferWorkspaceRef
    size?: 'sm' | 'md'
    className?: string
}) {
    const known = !!workspace.name
    return (
        <span
            aria-hidden
            className={cn(
                'inline-flex items-center justify-center shrink-0 font-bold text-white',
                size === 'sm' ? 'w-6 h-6 rounded-md text-[9px]' : 'w-11 h-11 rounded-xl text-sm shadow-md',
                known ? cn('bg-gradient-to-br', accentFor(workspace.id)) : 'bg-slate-400 dark:bg-slate-600',
                className,
            )}
        >
            {known ? monogram(workspace.name as string) : '?'}
        </span>
    )
}

export function TransferRoute({ from, to, sourceName }: {
    from: TransferWorkspaceRef
    to: TransferWorkspaceRef
    sourceName: string
}) {
    return (
        <div className="relative rounded-2xl border border-black/[0.08] dark:border-white/[0.10] bg-canvas-elevated overflow-hidden">
            <div className="h-1 bg-gradient-to-r from-indigo-500 via-violet-500 to-sky-500" />
            <div className="flex items-center gap-3 px-5 py-4">
                <End label="From" workspace={from} />
                <div className="relative flex-1 min-w-[4rem] h-10" aria-hidden>
                    <motion.div
                        initial={{ scaleX: 0 }}
                        animate={{ scaleX: 1 }}
                        transition={{ duration: 0.5, ease: 'easeOut' }}
                        style={{ originX: 0 }}
                        className="absolute inset-x-0 top-1/2 border-t-2 border-dashed border-indigo-500/40"
                    />
                    {/* Centred by a static wrapper: framer's inline transform on the
                        pill itself would replace Tailwind's translate. */}
                    <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
                        <motion.span
                            initial={{ opacity: 0, scale: 0.85 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ delay: 0.3, duration: 0.2, ease: 'easeOut' }}
                            className="inline-flex max-w-[12rem] items-center gap-1.5 rounded-full border border-indigo-500/25 bg-canvas-elevated px-2.5 py-1 text-[11px] font-semibold text-indigo-600 dark:text-indigo-300 shadow-sm"
                        >
                            <Database className="w-3 h-3 shrink-0" />
                            <span className="truncate">{sourceName}</span>
                            <ArrowRight className="w-3 h-3 shrink-0" />
                        </motion.span>
                    </span>
                </div>
                <End label="To" workspace={to} align="right" />
            </div>
        </div>
    )
}

function End({ label, workspace, align = 'left' }: {
    label: string
    workspace: TransferWorkspaceRef
    align?: 'left' | 'right'
}) {
    return (
        <div className={cn('flex items-center gap-2.5 min-w-0 max-w-[40%]', align === 'right' && 'flex-row-reverse text-right')}>
            <WorkspaceTile workspace={workspace} />
            <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">{label}</p>
                <p className="text-sm font-bold text-ink truncate">{workspaceLabel(workspace.name)}</p>
            </div>
        </div>
    )
}
