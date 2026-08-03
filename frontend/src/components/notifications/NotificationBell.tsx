/**
 * NotificationBell — the notification centre.
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
    Bell,
    CheckCheck,
    CheckCircle2,
    Megaphone,
    Share2,
    XCircle,
    type LucideIcon,
} from 'lucide-react'
import * as Popover from '@radix-ui/react-popover'
import { useNavigate } from 'react-router-dom'
import { useNotifications } from '@/hooks/useNotifications'
import { formatUtc, timeAgo } from '@/lib/timeAgo'
import type { Notification } from '@/services/notificationsService'
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

export function NotificationBell() {
    const [isOpen, setIsOpen] = useState(false)
    const navigate = useNavigate()
    const { items, unread, isLoading, markAllRead, markRead } = useNotifications()

    const handleOpenItem = (item: Notification) => {
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
                            ? `Notifications, ${unread} unread`
                            : 'Notifications'
                    }
                    title={
                        unread > 0
                            ? `${unread} unread notification${unread !== 1 ? 's' : ''}`
                            : 'Notifications'
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
                        <span className="text-sm font-semibold text-ink">Notifications</span>
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
                                    <NotificationRow
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

// ── Notification Row ──────────────────────────────────────────────────

function NotificationRow({
    item,
    onClick,
}: {
    item: Notification
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
