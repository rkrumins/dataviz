/**
 * NotificationBell — who has joined through your invite links.
 *
 * This was a "coming soon" placeholder. Its first real content is invite
 * activity, because that is the half of an invitation that was missing:
 * you sent a link and never heard whether it worked, which left you with
 * no idea whether to follow up or let it expire.
 *
 * "Seen" is tracked locally rather than server-side. A read receipt is
 * per-person-per-device by nature, it is worth no schema, and the cost of
 * getting it wrong is one extra dot.
 */
import { useEffect, useState } from 'react'
import { Bell, UserPlus } from 'lucide-react'
import * as Popover from '@radix-ui/react-popover'
import { adminUserService, type InviteActivityItem } from '@/services/adminUserService'
import { formatUtc, timeAgo, toUtcDate } from '@/lib/timeAgo'
import { roleVisualFor } from '@/lib/roleVisual'
import { onAppVisible } from '@/lib/appVisibility'
import { subscribeToUserTopic } from '@/store/changeFeed'

const SEEN_KEY = 'nx-invite-activity-seen'

function readSeenAt(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY) || 0)
  } catch {
    return 0
  }
}

function writeSeenAt(ms: number): void {
  try {
    localStorage.setItem(SEEN_KEY, String(ms))
  } catch {
    // Private mode — the badge just won't persist as read.
  }
}


export function NotificationBell() {
  const [items, setItems] = useState<InviteActivityItem[]>([])
  const [seenAt, setSeenAt] = useState<number>(() => readSeenAt())

  // A counter the effect depends on, so every state write lands on the
  // far side of an await and a slow response cannot overwrite a newer one.
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const rows = await adminUserService.listMyInviteActivity()
        if (!cancelled) setItems(rows)
      } catch {
        // Not everyone may call this, and a bell is never worth an error.
        if (!cancelled) setItems([])
      }
    })()

    const refresh = () => setTick(n => n + 1)
    // One coalesced signal instead of a `visibilitychange` + `focus`
    // pair. Listening to both fired this twice on every alt-tab, and
    // four other surfaces were doing the same thing beside it.
    const unsubscribeVisible = onAppVisible(refresh)
    // Somebody redeeming your invite is an event, and it is a rare one.
    // The 120s timer this replaces asked about it thirty times an hour
    // and got the same answer every time.
    const unsubscribeTopic = subscribeToUserTopic('inviteActivity', refresh)
    return () => {
      cancelled = true
      unsubscribeVisible()
      unsubscribeTopic()
    }
  }, [tick])

  const unread = items.filter(i => {
    const t = toUtcDate(i.redeemedAt)?.getTime() ?? 0
    return t > seenAt
  }).length

  const markSeen = (open: boolean) => {
    if (!open || items.length === 0) return
    const newest = Math.max(
      ...items.map(i => toUtcDate(i.redeemedAt)?.getTime() ?? 0),
    )
    writeSeenAt(newest)
    setSeenAt(newest)
  }

  return (
    <Popover.Root onOpenChange={markSeen}>
      <Popover.Trigger asChild>
        <button
          className="btn btn-ghost p-2 rounded-lg relative"
          title={unread > 0 ? `${unread} new since you last looked` : 'Notifications'}
        >
          <Bell className="w-5 h-5 text-ink-secondary" />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-red-500 text-[9px] text-white flex items-center justify-center font-bold leading-none">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          className="w-80 bg-canvas-elevated border border-glass-border rounded-xl shadow-lg z-50 animate-in fade-in zoom-in-95 data-[side=bottom]:slide-in-from-top-2 overflow-hidden"
          sideOffset={8}
          align="end"
        >
          <div className="px-4 py-3 border-b border-glass-border">
            <p className="text-sm font-semibold text-ink">Your invitations</p>
          </div>

          {items.length === 0 ? (
            <div className="text-center px-6 py-8">
              <Bell className="w-7 h-7 text-ink-muted/40 mx-auto mb-2" />
              <p className="text-xs text-ink-muted leading-relaxed">
                Nobody has signed up through your invite links yet. When they
                do, they'll show up here.
              </p>
            </div>
          ) : (
            <ul className="max-h-80 overflow-y-auto divide-y divide-glass-border">
              {items.map(item => (
                <li key={item.id} className="flex items-start gap-2.5 px-4 py-3">
                  <div className="w-7 h-7 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0 mt-0.5">
                    <UserPlus className="w-3.5 h-3.5 text-emerald-500" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-ink leading-snug">
                      <span className="font-semibold">{item.email}</span> joined
                      {item.role && <> as {roleVisualFor(item.role).label}</>}
                      {item.workspaceName && (
                        <span className="text-ink-muted"> in {item.workspaceName}</span>
                      )}
                    </p>
                    <p
                      className="text-[11px] text-ink-muted mt-0.5"
                      title={formatUtc(item.redeemedAt)}
                    >
                      {timeAgo(item.redeemedAt)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
