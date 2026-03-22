/**
 * ExplorerPreviewDrawer — Premium slide-in side drawer for quick-previewing
 * a view's metadata without leaving the Explorer page.
 *
 * Matches the glass-panel / backdrop-blur design language of Dashboard & Admin.
 */

import { Link } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
    X,
    Star,
    Share2,
    Tag,
    Lock,
    Users,
    Globe,
    Calendar,
    User,
    ExternalLink,
    Network,
    GitBranch,
    Layout,
    Table2,
    Layers,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { workspaceColor } from '@/lib/workspaceColor'
import { timeAgo } from '@/lib/timeAgo'
import type { View } from '@/services/viewApiService'

interface ExplorerPreviewDrawerProps {
    view: View | null
    isOpen: boolean
    onClose: () => void
    onToggleFavourite: () => void
    onShare: () => void
}

const VISIBILITY_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
    private: { label: 'Private', icon: Lock },
    workspace: { label: 'Workspace', icon: Users },
    enterprise: { label: 'Enterprise', icon: Globe },
}

const VIEW_TYPE_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; color: string }> = {
    graph: { label: 'Graph', icon: Network, color: 'bg-indigo-500/10 border-indigo-500/20 text-indigo-500' },
    hierarchy: { label: 'Hierarchy', icon: GitBranch, color: 'bg-violet-500/10 border-violet-500/20 text-violet-500' },
    lineage: { label: 'Lineage', icon: Layers, color: 'bg-amber-500/10 border-amber-500/20 text-amber-500' },
    table: { label: 'Table', icon: Table2, color: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-500' },
    context: { label: 'Context', icon: Layout, color: 'bg-rose-500/10 border-rose-500/20 text-rose-500' },
}

export function ExplorerPreviewDrawer({
    view,
    isOpen,
    onClose,
    onToggleFavourite,
    onShare,
}: ExplorerPreviewDrawerProps) {
    return (
        <AnimatePresence>
            {isOpen && view && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                    />

                    {/* Drawer panel */}
                    <motion.aside
                        className={cn(
                            'fixed right-0 top-0 h-full w-[420px] z-40',
                            'bg-canvas/98 backdrop-blur-2xl border-l border-glass-border',
                            'flex flex-col overflow-y-auto custom-scrollbar',
                            'shadow-2xl',
                        )}
                        initial={{ x: 420 }}
                        animate={{ x: 0 }}
                        exit={{ x: 420 }}
                        transition={{ type: 'spring', damping: 30, stiffness: 300 }}
                    >
                        {/* Header */}
                        <div className="flex items-start justify-between gap-3 px-6 pt-6 pb-5 border-b border-glass-border/50">
                            <div className="flex-1 min-w-0">
                                {/* View type badge */}
                                {(() => {
                                    const typeMeta = VIEW_TYPE_META[view.viewType] ?? VIEW_TYPE_META.graph
                                    const TypeIcon = typeMeta.icon
                                    return (
                                        <div className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold mb-3', typeMeta.color)}>
                                            <TypeIcon className="h-3 w-3" />
                                            {typeMeta.label} View
                                        </div>
                                    )
                                })()}
                                <h2 className="text-ink text-xl font-bold leading-tight">
                                    {view.name}
                                </h2>
                            </div>
                            <button
                                onClick={onClose}
                                className="flex-shrink-0 p-2 rounded-xl text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-all"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        {/* Body */}
                        <div className="flex-1 px-6 py-5 space-y-6">
                            {/* Workspace + Visibility */}
                            <div className="flex items-center gap-2 flex-wrap">
                                {view.workspaceName && (() => {
                                    const wsColor = workspaceColor(view.workspaceId)
                                    return (
                                        <span
                                            className={cn(
                                                'inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold border',
                                                wsColor.bg,
                                                wsColor.text,
                                                wsColor.border,
                                            )}
                                        >
                                            {view.workspaceName}
                                        </span>
                                    )
                                })()}

                                {(() => {
                                    const vis = VISIBILITY_META[view.visibility] ?? VISIBILITY_META.private
                                    const VisIcon = vis.icon
                                    return (
                                        <span className="inline-flex items-center gap-1.5 rounded-full bg-black/5 dark:bg-white/5 px-3 py-1 text-xs font-medium text-ink-muted">
                                            <VisIcon className="h-3 w-3" />
                                            {vis.label}
                                        </span>
                                    )
                                })()}
                            </div>

                            {/* Description */}
                            {view.description && (
                                <div>
                                    <h4 className="text-ink-muted text-[10px] uppercase tracking-widest font-bold mb-2">
                                        Description
                                    </h4>
                                    <p className="text-ink text-sm leading-relaxed">
                                        {view.description}
                                    </p>
                                </div>
                            )}

                            {/* Tags */}
                            {view.tags && view.tags.length > 0 && (
                                <div>
                                    <h4 className="text-ink-muted text-[10px] uppercase tracking-widest font-bold mb-2">
                                        Tags
                                    </h4>
                                    <div className="flex flex-wrap gap-1.5">
                                        {view.tags.map((tag) => (
                                            <span
                                                key={tag}
                                                className="inline-flex items-center gap-1 rounded-full glass-panel border border-glass-border px-2.5 py-1 text-xs font-medium text-ink-muted"
                                            >
                                                <Tag className="h-3 w-3" />
                                                {tag}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* View type + layout */}
                            <div className="grid grid-cols-2 gap-4">
                                <div className="glass-panel rounded-xl border border-glass-border p-3">
                                    <h4 className="text-ink-muted text-[10px] uppercase tracking-widest font-bold mb-1.5">
                                        View Type
                                    </h4>
                                    <div className="flex items-center gap-2 text-ink text-sm font-semibold">
                                        {(() => {
                                            const typeMeta = VIEW_TYPE_META[view.viewType] ?? VIEW_TYPE_META.graph
                                            const TypeIcon = typeMeta.icon
                                            return (
                                                <>
                                                    <div className={cn('w-6 h-6 rounded-lg border flex items-center justify-center', typeMeta.color)}>
                                                        <TypeIcon className="h-3 w-3" />
                                                    </div>
                                                    {typeMeta.label}
                                                </>
                                            )
                                        })()}
                                    </div>
                                </div>
                                {view.config?.layout?.type && (
                                    <div className="glass-panel rounded-xl border border-glass-border p-3">
                                        <h4 className="text-ink-muted text-[10px] uppercase tracking-widest font-bold mb-1.5">
                                            Layout
                                        </h4>
                                        <p className="text-ink text-sm font-semibold capitalize">
                                            {view.config.layout.type}
                                        </p>
                                    </div>
                                )}
                            </div>

                            {/* Metadata: created by, dates */}
                            <div className="space-y-3 pt-3 border-t border-glass-border/50">
                                {view.createdBy && (
                                    <div className="flex items-center gap-3 text-sm">
                                        <div className="w-7 h-7 rounded-lg bg-black/5 dark:bg-white/5 flex items-center justify-center">
                                            <User className="h-3.5 w-3.5 text-ink-muted" />
                                        </div>
                                        <div>
                                            <span className="text-ink-muted text-[10px] uppercase tracking-widest font-bold block">Created by</span>
                                            <span className="text-ink font-medium">{view.createdBy}</span>
                                        </div>
                                    </div>
                                )}
                                <div className="flex items-center gap-3 text-sm">
                                    <div className="w-7 h-7 rounded-lg bg-black/5 dark:bg-white/5 flex items-center justify-center">
                                        <Calendar className="h-3.5 w-3.5 text-ink-muted" />
                                    </div>
                                    <div>
                                        <span className="text-ink-muted text-[10px] uppercase tracking-widest font-bold block">Created</span>
                                        <span className="text-ink font-medium">{timeAgo(view.createdAt)}</span>
                                    </div>
                                </div>
                                <div className="flex items-center gap-3 text-sm">
                                    <div className="w-7 h-7 rounded-lg bg-black/5 dark:bg-white/5 flex items-center justify-center">
                                        <Calendar className="h-3.5 w-3.5 text-ink-muted" />
                                    </div>
                                    <div>
                                        <span className="text-ink-muted text-[10px] uppercase tracking-widest font-bold block">Updated</span>
                                        <span className="text-ink font-medium">{timeAgo(view.updatedAt)}</span>
                                    </div>
                                </div>
                            </div>

                            {/* Favourite count + toggle */}
                            <div className="flex items-center gap-3 pt-3 border-t border-glass-border/50">
                                <button
                                    onClick={onToggleFavourite}
                                    className={cn(
                                        'inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-all duration-200',
                                        view.isFavourited
                                            ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20 hover:bg-amber-500/15'
                                            : 'glass-panel border border-glass-border text-ink-muted hover:text-amber-500 hover:border-amber-500/30',
                                    )}
                                >
                                    <Star
                                        className="h-4 w-4"
                                        fill={view.isFavourited ? 'currentColor' : 'none'}
                                    />
                                    {view.isFavourited ? 'Favourited' : 'Favourite'}
                                </button>
                                <span className="text-ink-muted text-xs font-medium">
                                    {view.favouriteCount}{' '}
                                    {view.favouriteCount === 1 ? 'favourite' : 'favourites'}
                                </span>
                            </div>
                        </div>

                        {/* Footer actions */}
                        <div className="flex items-center gap-3 px-6 py-5 border-t border-glass-border/50">
                            <Link
                                to={`/views/${view.id}`}
                                className={cn(
                                    'flex-1 inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3',
                                    'bg-gradient-to-r from-accent-lineage to-violet-600 text-white text-sm font-semibold',
                                    'shadow-lg shadow-accent-lineage/25',
                                    'hover:shadow-xl hover:-translate-y-0.5 transition-all duration-200',
                                )}
                            >
                                <ExternalLink className="h-4 w-4" />
                                Open Full View
                            </Link>
                            <button
                                onClick={onShare}
                                className={cn(
                                    'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3',
                                    'glass-panel border border-glass-border text-sm font-medium text-ink-muted',
                                    'hover:text-ink hover:border-glass-border/80 transition-all duration-200',
                                )}
                            >
                                <Share2 className="h-4 w-4" />
                                Share
                            </button>
                        </div>
                    </motion.aside>
                </>
            )}
        </AnimatePresence>
    )
}
