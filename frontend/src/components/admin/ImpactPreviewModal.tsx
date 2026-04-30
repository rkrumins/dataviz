/**
 * ImpactPreviewModal — confirmation modal for destructive RBAC
 * operations (Phase 4.4).
 *
 * Shows the gained/lost permission diff plus the affected-user
 * count. Used by:
 *
 *   * RoleEditorDrawer (Save) — preview what users will gain/lose
 *     when a role's permission bundle is modified.
 *   * RoleEditorDrawer (Delete) — preview what users will lose when
 *     a role is deleted (cascades the bindings).
 *   * WorkspaceMembers (Revoke) — preview what one user (or every
 *     group member) will lose when a binding is revoked.
 *
 * Visual language matches the rest of the admin shell — gradient
 * icon, framer-motion entrance, layered border.
 */
import { motion, AnimatePresence } from 'framer-motion'
import {
    AlertTriangle, Loader2, Check, X, Plus, Minus, Users, Briefcase,
} from 'lucide-react'
import type {
    ImpactPreviewResponse,
    ImpactPreviewUser,
} from '@/services/permissionsService'
import { cn } from '@/lib/utils'


export interface ImpactPreviewModalProps {
    open: boolean
    title: string
    intent: 'destructive' | 'caution'  // colors the primary CTA
    confirmLabel: string
    /** Loaded preview payload. ``null`` while the request is in flight. */
    preview: ImpactPreviewResponse | null
    loading: boolean
    error: string | null
    onCancel: () => void
    onConfirm: () => void
    /** Disable the confirm button (e.g. while the actual mutation is
     *  in flight after the user clicked confirm). */
    confirming?: boolean
}


export function ImpactPreviewModal({
    open, title, intent, confirmLabel, preview, loading, error,
    onCancel, onConfirm, confirming = false,
}: ImpactPreviewModalProps) {
    const intentColors = intent === 'destructive'
        ? {
            iconBg: 'bg-red-500/10 border-red-500/20',
            icon: 'text-red-500',
            confirm: 'bg-red-500 hover:bg-red-600 shadow-red-500/20',
        }
        : {
            iconBg: 'bg-amber-500/10 border-amber-500/20',
            icon: 'text-amber-500',
            confirm: 'bg-amber-500 hover:bg-amber-600 shadow-amber-500/20',
        }

    return (
        <AnimatePresence>
            {open && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="fixed inset-0 z-[90] flex items-center justify-center p-4"
                >
                    <div className="absolute inset-0 bg-black/60" onClick={onCancel} />
                    <motion.div
                        initial={{ scale: 0.96, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.96, opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        onClick={(e) => e.stopPropagation()}
                        className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-xl w-full max-w-2xl flex flex-col max-h-[80vh] overflow-hidden"
                    >
                        <div className="p-6 pb-4 border-b border-glass-border flex items-start gap-3">
                            <div className={cn(
                                'w-10 h-10 rounded-xl border flex items-center justify-center shrink-0',
                                intentColors.iconBg,
                            )}>
                                <AlertTriangle className={cn('w-5 h-5', intentColors.icon)} />
                            </div>
                            <div className="flex-1 min-w-0">
                                <h2 className="text-lg font-bold text-ink">{title}</h2>
                                <p className="text-xs text-ink-muted mt-0.5">
                                    Review the impact below before confirming. This action cannot be undone automatically.
                                </p>
                            </div>
                            <button
                                onClick={onCancel}
                                className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5"
                                aria-label="Close"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto p-6 space-y-4">
                            {loading ? (
                                <div className="flex items-center justify-center py-12">
                                    <Loader2 className="w-5 h-5 animate-spin text-ink-muted" />
                                </div>
                            ) : error ? (
                                <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-600 dark:text-red-400">
                                    {error}
                                </div>
                            ) : preview ? (
                                <PreviewBody preview={preview} />
                            ) : null}
                        </div>

                        <div className="px-6 py-4 border-t border-glass-border flex items-center justify-end gap-2">
                            <button
                                onClick={onCancel}
                                disabled={confirming}
                                className="px-4 py-2 rounded-xl text-sm font-semibold text-ink-secondary hover:text-ink bg-glass-base/40 border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50 transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={onConfirm}
                                disabled={loading || !!error || confirming}
                                className={cn(
                                    'inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white shadow-sm disabled:opacity-50 disabled:cursor-not-allowed transition-colors',
                                    intentColors.confirm,
                                )}
                            >
                                {confirming
                                    ? <Loader2 className="w-4 h-4 animate-spin" />
                                    : <Check className="w-4 h-4" />}
                                {confirmLabel}
                            </button>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    )
}


function PreviewBody({ preview }: { preview: ImpactPreviewResponse }) {
    const noChange = preview.affectedUsers === 0
        && preview.gainedPerms.length === 0
        && preview.lostPerms.length === 0

    if (noChange) {
        return (
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 text-sm text-emerald-700 dark:text-emerald-300">
                No users will lose or gain any effective permissions. The change is safe to commit.
            </div>
        )
    }

    return (
        <>
            {/* Summary strip */}
            <div className="grid grid-cols-2 gap-3">
                <SummaryTile
                    icon={Users}
                    label="Users affected"
                    value={preview.affectedUsers}
                    accent="indigo"
                />
                <SummaryTile
                    icon={Briefcase}
                    label="Workspaces touched"
                    value={preview.affectedWorkspaces}
                    accent="violet"
                />
            </div>

            {/* Aggregate diff */}
            <div className="space-y-2">
                {preview.lostPerms.length > 0 && (
                    <DiffRow type="lost" perms={preview.lostPerms} />
                )}
                {preview.gainedPerms.length > 0 && (
                    <DiffRow type="gained" perms={preview.gainedPerms} />
                )}
            </div>

            {/* Per-user breakdown — collapsed when many */}
            {preview.userImpact.length > 0 && preview.userImpact.length <= 8 && (
                <div className="space-y-2">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-ink-muted">
                        Per-user impact
                    </h4>
                    <div className="rounded-xl border border-glass-border divide-y divide-glass-border">
                        {preview.userImpact.map(u => (
                            <UserImpactRow key={u.userId} u={u} />
                        ))}
                    </div>
                </div>
            )}
            {preview.userImpact.length > 8 && (
                <p className="text-xs text-ink-muted">
                    {preview.userImpact.length} users affected — showing aggregate impact only.
                </p>
            )}
        </>
    )
}


function SummaryTile({
    icon: Icon, label, value, accent,
}: {
    icon: typeof Users
    label: string
    value: number
    accent: string
}) {
    return (
        <div className="rounded-xl border border-glass-border bg-glass-base/30 px-4 py-3">
            <div className="flex items-center gap-2">
                <Icon className={cn('w-3.5 h-3.5', `text-${accent}-500`)} />
                <span className="text-[10px] uppercase tracking-wider font-semibold text-ink-muted">{label}</span>
            </div>
            <p className={cn('text-2xl font-bold mt-0.5', `text-${accent}-600 dark:text-${accent}-400`)}>{value}</p>
        </div>
    )
}


function DiffRow({ type, perms }: { type: 'gained' | 'lost'; perms: string[] }) {
    const config = type === 'gained'
        ? {
            label: 'Will gain',
            border: 'border-emerald-500/20',
            bg: 'bg-emerald-500/[0.04]',
            icon: <Plus className="w-3 h-3 text-emerald-500" />,
            chip: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20',
        }
        : {
            label: 'Will lose',
            border: 'border-red-500/20',
            bg: 'bg-red-500/[0.04]',
            icon: <Minus className="w-3 h-3 text-red-500" />,
            chip: 'bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/20',
        }
    return (
        <div className={cn('rounded-xl border', config.border, config.bg, 'p-3')}>
            <div className="flex items-center gap-1.5 mb-2">
                {config.icon}
                <span className="text-[11px] uppercase tracking-wider font-bold text-ink">
                    {config.label}
                </span>
                <span className="text-[10px] text-ink-muted">({perms.length})</span>
            </div>
            <div className="flex flex-wrap gap-1">
                {perms.map(p => (
                    <code
                        key={p}
                        className={cn(
                            'inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-mono font-semibold border',
                            config.chip,
                        )}
                    >
                        {p}
                    </code>
                ))}
            </div>
        </div>
    )
}


function UserImpactRow({ u }: { u: ImpactPreviewUser }) {
    return (
        <div className="px-3 py-2.5">
            <p className="text-sm font-semibold text-ink">
                {u.displayName ?? u.userId}
                {u.email && (
                    <span className="font-normal text-ink-muted ml-1.5 text-xs">{u.email}</span>
                )}
            </p>
            <div className="flex flex-wrap gap-1 mt-1.5">
                {u.lost.map(p => (
                    <code key={'-' + p} className="inline-flex items-center gap-0.5 px-1.5 py-px rounded text-[10px] font-mono font-semibold border bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/20">
                        <Minus className="w-2 h-2" />{p}
                    </code>
                ))}
                {u.gained.map(p => (
                    <code key={'+' + p} className="inline-flex items-center gap-0.5 px-1.5 py-px rounded text-[10px] font-mono font-semibold border bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20">
                        <Plus className="w-2 h-2" />{p}
                    </code>
                ))}
            </div>
        </div>
    )
}
