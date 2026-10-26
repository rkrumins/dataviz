/**
 * InboxBell — the messages addressed to you.
 *
 * Every sharing flow in this product used to end in silence. A view was
 * shared with you and you found out by being told in a meeting; a
 * publication request sat waiting on an admin who had no idea it existed;
 * the answer to a request you filed was written to a timeline nobody
 * opens. All of that was already recorded — this is the surface that
 * finally shows it to the person it happened to.
 *
 * Trigger and panel deliberately copy ``BookmarksPopover`` (same header
 * cluster, same Radix Popover, same panel chrome) so the bell reads as
 * another shortcut in that group rather than a new kind of thing.
 *
 * NOTE: no ``AnimatePresence``/``exit`` here, by rule. A portaled overlay
 * animating on exit strands an invisible click-blocker in this codebase.
 * Radix's mount-only ``animate-in`` classes are the house pattern.
 */
import { useState } from 'react'
import {
    ArrowRightLeft,
    Bell,
    Building2,
    CalendarClock,
    CheckCheck,
    CheckCircle2,
    ClipboardCheck,
    Clock,
    KeyRound,
    KeySquare,
    LayoutTemplate,
    Megaphone,
    Share2,
    RotateCcw,
    ShieldAlert,
    Sparkles,
    Trash2,
    Undo2,
    UserMinus,
    UserPlus,
    XCircle,
    type LucideIcon,
} from 'lucide-react'
import * as Popover from '@radix-ui/react-popover'
import { useNavigate } from 'react-router-dom'
import { useInbox } from '@/hooks/useInbox'
import { formatUtc, timeAgo } from '@/lib/timeAgo'
import type { InboxItem } from '@/services/inboxService'
import { cn } from '@/lib/utils'

interface KindVisual {
    Icon: LucideIcon
    /** Literal Tailwind classes — never interpolated. The JIT only sees
     *  class names that appear verbatim in the source, so a
     *  `text-${colour}-500` here would silently render uncoloured. */
    icon: string
    tile: string
}

const KIND_VISUALS: Record<string, KindVisual> = {
    'view.shared': {
        Icon: Share2,
        icon: 'text-sky-500',
        tile: 'bg-sky-500/10',
    },
    'layout_template.shared': {
        Icon: LayoutTemplate,
        icon: 'text-fuchsia-500',
        tile: 'bg-fuchsia-500/10',
    },
    'layout_template.updated': {
        Icon: Sparkles,
        icon: 'text-fuchsia-500',
        tile: 'bg-fuchsia-500/10',
    },
    'layout_template.promotion_requested': {
        Icon: Building2,
        icon: 'text-sky-500',
        tile: 'bg-sky-500/10',
    },
    'layout_template.promotion_approved': {
        Icon: CheckCircle2,
        icon: 'text-emerald-500',
        tile: 'bg-emerald-500/10',
    },
    'layout_template.promotion_declined': {
        Icon: XCircle,
        icon: 'text-rose-500',
        tile: 'bg-rose-500/10',
    },
    'view.publish_requested': {
        Icon: Megaphone,
        icon: 'text-amber-500',
        tile: 'bg-amber-500/10',
    },
    'view.publish_approved': {
        Icon: CheckCircle2,
        icon: 'text-emerald-500',
        tile: 'bg-emerald-500/10',
    },
    'view.publish_denied': {
        Icon: XCircle,
        icon: 'text-rose-500',
        tile: 'bg-rose-500/10',
    },
    // Asking to join a workspace: the ask reaches its approvers; the answer,
    // a group to join at the identity provider, or the access arriving
    // reaches the person who asked.
    'access_request.submitted': {
        Icon: UserPlus,
        icon: 'text-emerald-500',
        tile: 'bg-emerald-500/10',
    },
    'access_request.approved': {
        Icon: CheckCircle2,
        icon: 'text-emerald-500',
        tile: 'bg-emerald-500/10',
    },
    'access_request.denied': {
        Icon: XCircle,
        icon: 'text-rose-500',
        tile: 'bg-rose-500/10',
    },
    'access_request.routed': {
        Icon: KeyRound,
        icon: 'text-sky-500',
        tile: 'bg-sky-500/10',
    },
    'access_request.fulfilled': {
        Icon: CheckCircle2,
        icon: 'text-emerald-500',
        tile: 'bg-emerald-500/10',
    },
    // A request nobody has answered, brought up again — then to the Org Admins.
    'access_request.reminder': {
        Icon: Clock,
        icon: 'text-amber-500',
        tile: 'bg-amber-500/10',
    },
    'access_request.escalated': {
        Icon: ShieldAlert,
        icon: 'text-amber-500',
        tile: 'bg-amber-500/10',
    },
    // Access once granted: added, removed, its end moved or near, an
    // exception the identity provider took over, a review running late.
    'workspace.member_added': {
        Icon: UserPlus,
        icon: 'text-emerald-500',
        tile: 'bg-emerald-500/10',
    },
    'workspace.member_removed': {
        Icon: UserMinus,
        icon: 'text-rose-500',
        tile: 'bg-rose-500/10',
    },
    'workspace.access_end_changed': {
        Icon: CalendarClock,
        icon: 'text-sky-500',
        tile: 'bg-sky-500/10',
    },
    'access.expiring': {
        Icon: CalendarClock,
        icon: 'text-amber-500',
        tile: 'bg-amber-500/10',
    },
    'access.exception_retired': {
        Icon: KeyRound,
        icon: 'text-sky-500',
        tile: 'bg-sky-500/10',
    },
    'access_review.overdue': {
        Icon: ClipboardCheck,
        icon: 'text-amber-500',
        tile: 'bg-amber-500/10',
    },
    // Moving a data source between workspaces: the ask reaches the destination's
    // admins; the answer reaches whoever asked, as does a request that lapsed;
    // the move itself, and an undo, reach both workspaces' admins, the owners of
    // the views that moved, and the people who lost access to them.
    'data_source.transfer_requested': {
        Icon: ArrowRightLeft,
        icon: 'text-sky-500',
        tile: 'bg-sky-500/10',
    },
    'data_source.transfer_accepted': {
        Icon: CheckCircle2,
        icon: 'text-emerald-500',
        tile: 'bg-emerald-500/10',
    },
    'data_source.transfer_declined': {
        Icon: XCircle,
        icon: 'text-rose-500',
        tile: 'bg-rose-500/10',
    },
    'data_source.transfer_cancelled': {
        Icon: XCircle,
        icon: 'text-slate-500',
        tile: 'bg-slate-500/10',
    },
    'data_source.moved': {
        Icon: ArrowRightLeft,
        icon: 'text-indigo-500',
        tile: 'bg-indigo-500/10',
    },
    'data_source.move_undone': {
        Icon: Undo2,
        icon: 'text-amber-500',
        tile: 'bg-amber-500/10',
    },
    'data_source.access_lost': {
        Icon: UserMinus,
        icon: 'text-amber-500',
        tile: 'bg-amber-500/10',
    },
    'data_source.transfer_expired': {
        Icon: Clock,
        icon: 'text-slate-500',
        tile: 'bg-slate-500/10',
    },
    'reconcile.suspended': {
        Icon: ShieldAlert,
        icon: 'text-amber-500',
        tile: 'bg-amber-500/10',
    },
    api_key_expiring: {
        Icon: Clock,
        icon: 'text-amber-500',
        tile: 'bg-amber-500/10',
    },
    api_key_misuse: {
        Icon: ShieldAlert,
        icon: 'text-rose-500',
        tile: 'bg-rose-500/10',
    },
    api_key_revoked_by_admin: {
        Icon: KeySquare,
        icon: 'text-rose-500',
        tile: 'bg-rose-500/10',
    },
    // Service accounts: one left with nobody answering for it, its keys
    // about to pause, a new manager and one no longer managing it, a key
    // made by someone who isn't one, an administrator disabling or enabling
    // it, someone deleting or restoring it, someone joining a team that
    // manages it, a key revoked by whoever held it, and keys that still work
    // made by someone who no longer answers for it.
    service_account_unmanaged: {
        Icon: ShieldAlert,
        icon: 'text-amber-500',
        tile: 'bg-amber-500/10',
    },
    service_account_pausing: {
        Icon: Clock,
        icon: 'text-amber-500',
        tile: 'bg-amber-500/10',
    },
    service_account_manager_added: {
        Icon: UserPlus,
        icon: 'text-emerald-500',
        tile: 'bg-emerald-500/10',
    },
    service_account_manager_removed: {
        Icon: UserMinus,
        icon: 'text-slate-500',
        tile: 'bg-slate-500/10',
    },
    service_account_key_created: {
        Icon: KeySquare,
        icon: 'text-sky-500',
        tile: 'bg-sky-500/10',
    },
    service_account_disabled: {
        Icon: XCircle,
        icon: 'text-rose-500',
        tile: 'bg-rose-500/10',
    },
    service_account_enabled: {
        Icon: CheckCircle2,
        icon: 'text-emerald-500',
        tile: 'bg-emerald-500/10',
    },
    service_account_deleted: {
        Icon: Trash2,
        icon: 'text-rose-500',
        tile: 'bg-rose-500/10',
    },
    service_account_restored: {
        Icon: RotateCcw,
        icon: 'text-emerald-500',
        tile: 'bg-emerald-500/10',
    },
    service_account_team_joined: {
        Icon: UserPlus,
        icon: 'text-amber-500',
        tile: 'bg-amber-500/10',
    },
    api_key_revoked_itself: {
        Icon: KeySquare,
        icon: 'text-amber-500',
        tile: 'bg-amber-500/10',
    },
    service_account_maker_left: {
        Icon: KeySquare,
        icon: 'text-amber-500',
        tile: 'bg-amber-500/10',
    },
}

/** Kinds are added backend-side without a frontend deploy, so an unknown
 *  one must still render as a normal, legible row — a plain bell rather
 *  than a gap or a crash. */
const DEFAULT_VISUAL: KindVisual = {
    Icon: Bell,
    icon: 'text-ink-muted',
    tile: 'bg-black/5 dark:bg-white/5',
}

function visualFor(kind: string): KindVisual {
    return KIND_VISUALS[kind] ?? DEFAULT_VISUAL
}

export function InboxBell() {
    const [isOpen, setIsOpen] = useState(false)
    const navigate = useNavigate()
    const { items, unread, isLoading, markAllRead, markRead } = useInbox()

    const handleOpenItem = (item: InboxItem) => {
        // Only spend a request when there is something to change. Re-marking
        // an already-read row would be a POST that alters nothing.
        if (!item.readAt) markRead(item.id)
        setIsOpen(false)
        if (item.link) navigate(item.link)
    }

    return (
        <Popover.Root open={isOpen} onOpenChange={setIsOpen}>
            <Popover.Trigger asChild>
                <button
                    className="btn btn-ghost p-2 rounded-lg relative"
                    aria-label={
                        unread > 0
                            ? `Inbox, ${unread} unread`
                            : 'Inbox'
                    }
                    title={
                        unread > 0
                            ? `${unread} unread message${unread !== 1 ? 's' : ''}`
                            : 'Inbox'
                    }
                >
                    <Bell
                        className={cn(
                            'w-5 h-5 transition-colors',
                            unread > 0 ? 'text-accent-lineage' : 'text-ink-secondary',
                        )}
                    />
                    {unread > 0 && (
                        <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-accent-lineage text-[9px] text-white flex items-center justify-center font-bold leading-none">
                            {unread > 9 ? '9+' : unread}
                        </span>
                    )}
                </button>
            </Popover.Trigger>

            <Popover.Portal>
                <Popover.Content
                    className="w-80 bg-canvas-elevated border border-glass-border rounded-xl shadow-lg overflow-hidden z-50 animate-in fade-in zoom-in-95 data-[side=bottom]:slide-in-from-top-2"
                    sideOffset={8}
                    align="end"
                >
                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-3 border-b border-glass-border">
                        <span className="text-sm font-semibold text-ink">Inbox</span>
                        {unread > 0 && (
                            <button
                                onClick={() => markAllRead()}
                                className="flex items-center gap-1 text-2xs text-ink-muted hover:text-accent-lineage transition-colors"
                            >
                                <CheckCheck className="w-3 h-3" />
                                Mark all read
                            </button>
                        )}
                    </div>

                    {/* Content */}
                    <div className="max-h-[60vh] overflow-y-auto custom-scrollbar">
                        {isLoading ? (
                            <div className="px-4 py-6 text-center">
                                <div className="w-5 h-5 border-2 border-accent-lineage/30 border-t-accent-lineage rounded-full animate-spin mx-auto" />
                            </div>
                        ) : items.length === 0 ? (
                            <div className="px-6 py-8 text-center">
                                <Bell className="w-8 h-8 text-ink-muted mx-auto mb-3" />
                                <p className="text-sm font-medium text-ink">You&rsquo;re all caught up</p>
                                <p className="text-xs text-ink-muted mt-1 leading-relaxed">
                                    When someone shares a view with you, or answers a
                                    request you made, you&rsquo;ll hear about it here.
                                </p>
                            </div>
                        ) : (
                            <div className="py-1">
                                {items.map((item) => (
                                    <InboxRow
                                        key={item.id}
                                        item={item}
                                        onClick={() => handleOpenItem(item)}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    )
}

// ── Inbox row ──────────────────────────────────────────────────────

function InboxRow({
    item,
    onClick,
}: {
    item: InboxItem
    onClick: () => void
}) {
    const { Icon, icon, tile } = visualFor(item.kind)
    const isUnread = !item.readAt

    return (
        <div
            className={cn(
                'flex items-start gap-2.5 px-4 py-2.5 cursor-pointer transition-colors',
                'hover:bg-black/5 dark:hover:bg-white/5',
                isUnread && 'bg-accent-lineage/5',
            )}
            onClick={onClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && onClick()}
        >
            <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5', tile)}>
                <Icon className={cn('w-3.5 h-3.5', icon)} />
            </div>

            <div className="min-w-0 flex-1">
                <p
                    className={cn(
                        'text-xs leading-snug',
                        isUnread ? 'text-ink font-semibold' : 'text-ink-secondary',
                    )}
                >
                    {item.title}
                </p>
                {item.body && (
                    <p className="text-[11px] text-ink-muted leading-snug mt-0.5 line-clamp-2">
                        {item.body}
                    </p>
                )}
                <p
                    className="text-[11px] text-ink-muted mt-0.5"
                    title={formatUtc(item.createdAt)}
                >
                    {item.actorName && (
                        <>
                            {item.actorName}
                            <span className="text-ink-muted/50"> · </span>
                        </>
                    )}
                    {timeAgo(item.createdAt)}
                </p>
            </div>

            {/* The dot repeats what the bolding already says, for anyone
                scanning the left-to-right rhythm rather than reading. */}
            {isUnread && (
                <span
                    className="w-1.5 h-1.5 rounded-full bg-accent-lineage shrink-0 mt-1.5"
                    aria-label="Unread"
                />
            )}
        </div>
    )
}
