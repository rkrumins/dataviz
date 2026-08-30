/**
 * App-wide notification system.
 *
 * Three exports:
 *   - useAppNotifications()  — hook: { notify, dismiss, showLoading, hideLoading }
 *   - useNotificationStore   — Zustand store (for direct access outside React)
 *   - <NotificationStack />  — render once in AppLayout; animates all active ones
 *
 * Notification types:
 *   - success / error / warning / info  — auto-dismiss after 4.5s, or after the
 *                                         caller's own `durationMs`
 *   - loading                           — persists until explicitly dismissed via hideLoading(key)
 *
 * Usage:
 *   const { notify, showLoading, hideLoading } = useAppNotifications()
 *   notify('success', 'View saved')
 *   showLoading('assignments', 'Computing layer assignments')
 *   hideLoading('assignments')
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { AnimatePresence, motion } from 'framer-motion'
import { CheckCircle2, AlertCircle, AlertTriangle, Info, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────

export type NotificationType = 'success' | 'error' | 'warning' | 'info' | 'loading'

export interface AppNotification {
  id: number
  type: NotificationType
  message: string
  /** Stable key for loading notifications — used by hideLoading() to dismiss. */
  key?: string
  action?: { label: string; onClick: () => void }
  /** How long this one lives, in ms. Defaults to DURATION. An `action` a reader
   * has to notice, read and reach for needs longer than a remark they only
   * read — an Undo that expires first is worse than no Undo at all. */
  durationMs?: number
  /** Epoch-ms at which the notification was added — drives the progress bar and
   * dismiss timer against an immutable reference time so sibling removals
   * never restart this notification's countdown. */
  createdAt: number
}

/**
 * A notification that already came and went. One lives 4.5s; the user who
 * looked away has no way back to it, so every non-loading notification is also
 * written to a capped, newest-first log (`history`) that the canvas surfaces on
 * demand. Loading notifications are excluded — they are transient progress
 * whose outcome arrives as its own success/error notification.
 */
export interface NotificationHistoryEntry {
  id: number
  type: Exclude<NotificationType, 'loading'>
  message: string
  createdAt: number
}

/** Oldest entries fall off the end past this. In memory only — a refresh starts clean. */
export const NOTIFICATION_HISTORY_LIMIT = 100

// ─── Store ────────────────────────────────────────────────────────────────

interface NotificationState {
  notifications: AppNotification[]
  /** Newest first, capped at NOTIFICATION_HISTORY_LIMIT. Independent of `notifications`:
   *  dismissing a live notification never removes its history entry. Cleared per
   *  view by CanvasRouter so the log always describes the open view. */
  history: NotificationHistoryEntry[]
  _nextId: number
  add: (notification: Omit<AppNotification, 'id' | 'createdAt'>) => number
  remove: (id: number) => void
  removeByKey: (key: string) => void
  clearHistory: () => void
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  history: [],
  _nextId: 1,
  add: (notification) => {
    const id = get()._nextId
    const createdAt = Date.now()
    // For loading notifications with a key, replace any existing one with that
    // key so we don't stack duplicates for the same operation.
    set(state => ({
      _nextId: state._nextId + 1,
      notifications: [
        ...state.notifications.filter(t => !(notification.key && t.key === notification.key)),
        { ...notification, id, createdAt },
      ],
      history: notification.type === 'loading'
        ? state.history
        : [
            { id, type: notification.type, message: notification.message, createdAt },
            ...state.history,
          ].slice(0, NOTIFICATION_HISTORY_LIMIT),
    }))
    return id
  },
  remove: (id) => set(state => ({
    notifications: state.notifications.filter(t => t.id !== id),
  })),
  removeByKey: (key) => set(state => ({
    notifications: state.notifications.filter(t => t.key !== key),
  })),
  clearHistory: () => set({ history: [] }),
}))

// ─── Hook ─────────────────────────────────────────────────────────────────

export function useAppNotifications() {
  const add = useNotificationStore(s => s.add)
  const remove = useNotificationStore(s => s.remove)
  const removeByKey = useNotificationStore(s => s.removeByKey)

  const notify = useCallback((
    type: Exclude<NotificationType, 'loading'>,
    message: string,
    action?: { label: string; onClick: () => void },
    durationMs?: number,
  ) => {
    return add({ type, message, action, durationMs })
  }, [add])

  /** Show a persistent loading notification. Stays until hideLoading(key) is called. */
  const showLoading = useCallback((key: string, message: string) => {
    return add({ type: 'loading', message, key })
  }, [add])

  /** Dismiss a loading notification by key. */
  const hideLoading = useCallback((key: string) => {
    removeByKey(key)
  }, [removeByKey])

  const dismiss = useCallback((id: number) => {
    remove(id)
  }, [remove])

  return { notify, showLoading, hideLoading, dismiss }
}

/** A message, or a message computed at the moment it is shown. */
export type NotificationMessage = string | (() => string)

const resolveMessage = (message: NotificationMessage) =>
  typeof message === 'function' ? message() : message

/**
 * Declarative loading notification — shows while `isLoading` is true, hides
 * when false. Call at the top of a component to bind a loading operation to
 * the notification system.
 *
 * If `successMessage` is provided, a green success notification fires on the
 * `isLoading: true → false` transition (4.5s auto-dismiss). This gives the
 * user explicit confirmation that the operation completed rather than the
 * loading notification just silently disappearing.
 *
 * Either message may be a function instead of a string, and it is called AT
 * the transition. A message that reports what a load produced — "Opened
 * “Customer 360” · 1,204 items" — has to read those counts at the moment the
 * load finishes, not on the render that happened to declare the hook.
 */
export function useLoadingNotification(
  key: string,
  isLoading: boolean,
  message: NotificationMessage,
  successMessage?: NotificationMessage,
  /** When true at the loading→done transition, hide the loading notification
   *  WITHOUT showing the success message — for when the operation ended in failure
   *  (e.g. hydration errored) so we never report "Entities loaded" over an
   *  empty/errored canvas. */
  suppressSuccess?: boolean,
) {
  const { showLoading, hideLoading, notify } = useAppNotifications()
  // Tracks whether we previously showed a loading notification for this key.
  // Needed because the effect runs on every dependency change, but we only
  // want to fire success on a genuine true → false transition (not on the
  // initial render where isLoading happens to be false).
  const wasLoadingRef = useRef(false)
  // Latest-value ref, written in its own effect (writing it during render is a
  // `react-hooks/refs` error here). A computed message is an inline closure
  // with a fresh identity every render; as a dependency it would re-run the
  // transition effect on every render, and `showLoading` would replace the
  // live card each time — a loading notification that restarts continuously.
  // Declared FIRST so React runs it before the transition effect below, which
  // therefore always reads the values of the render it fired on.
  const latestRef = useRef({ message, successMessage, suppressSuccess })
  useEffect(() => {
    latestRef.current = { message, successMessage, suppressSuccess }
  })
  // A STRING message still updates the live notification when it changes —
  // CanvasRouter reworded its loading notification per hydration phase long
  // before this hook could take a function, and that behaviour stays.
  const staticMessage = typeof message === 'string' ? message : null

  useEffect(() => {
    const { message: current, successMessage: done, suppressSuccess: skip } = latestRef.current
    if (isLoading) {
      showLoading(key, resolveMessage(current))
      wasLoadingRef.current = true
    } else {
      hideLoading(key)
      if (wasLoadingRef.current && done && !skip) {
        notify('success', resolveMessage(done))
      }
      wasLoadingRef.current = false
    }
    return () => hideLoading(key)
  }, [isLoading, key, staticMessage, showLoading, hideLoading, notify])
}

// ─── Visual constants ─────────────────────────────────────────────────────

/** How long a notification lives unless it asks for longer. */
const DURATION = 4500

const accentColors: Record<NotificationType, string> = {
  success: 'bg-emerald-500',
  error: 'bg-red-500',
  warning: 'bg-amber-500',
  info: 'bg-blue-500',
  loading: 'bg-indigo-500',
}

export const iconColors: Record<NotificationType, string> = {
  success: 'text-emerald-500',
  error: 'text-red-500',
  warning: 'text-amber-500',
  info: 'text-blue-500',
  loading: 'text-indigo-500',
}

export const iconComponents: Record<NotificationType, React.ComponentType<{ className?: string }>> = {
  success: CheckCircle2,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
  loading: Loader2,
}

// ─── Single notification ──────────────────────────────────────────────────

function NotificationCard({ notification }: { notification: AppNotification }) {
  const remove = useNotificationStore(s => s.remove)
  const isLoading = notification.type === 'loading'
  const id = notification.id
  const createdAt = notification.createdAt
  const duration = notification.durationMs ?? DURATION

  // The bar is a CSS animation, not React state.
  //
  // It used to be a `setInterval(..., 30)` calling `setProgress` — ~33 re-renders
  // a second, on a `<motion.div layout>`, which makes framer-motion re-measure
  // layout on every one of them. `NotificationStack` is always mounted and
  // `CanvasRouter` raises a hydration notification during EVERY canvas load,
  // so that ran at exactly the moment the canvas was busiest. Handing the
  // interpolation to the compositor costs zero renders.
  //
  // Both values are computed from the immutable `createdAt`, so a remount (React
  // StrictMode, or the parent re-rendering for an unrelated reason) resumes the
  // bar where it should be rather than snapping back to 100%.
  // Computed once at mount, in a state initializer — `createdAt` is immutable
  // for a given notification and `NotificationCard` is keyed by id, so there is
  // nothing to recompute.
  const [{ fromPercent, remainingMs }] = useState(() => {
    const elapsed = Date.now() - createdAt
    return {
      fromPercent: Math.max(0, 100 - (elapsed / duration) * 100),
      remainingMs: Math.max(0, duration - elapsed),
    }
  })

  useEffect(() => {
    // Loading notifications don't auto-dismiss.
    if (isLoading) return

    // Anchor both the dismiss timer and the progress bar on the immutable
    // createdAt timestamp. Previously the timer was restarted from "now"
    // whenever this effect re-ran (e.g. because a sibling notification dismissed
    // and the parent's onDismiss closure changed), which gave the user the
    // misleading impression that the remaining notifications had reset.
    const timer = setTimeout(() => remove(id), Math.max(0, duration - (Date.now() - createdAt)))

    return () => {
      clearTimeout(timer)
    }
  }, [createdAt, duration, id, isLoading, remove])

  const onDismiss = useCallback(() => remove(id), [remove, id])

  const Icon = iconComponents[notification.type]

  return (
    <motion.div
      layout
      // No `scale`: a scaled card measures narrower than the 320px it occupies
      // (304px at 0.95), so its left edge crept in and out while it animated
      // and a stack mid-flight looked like cards of several different widths.
      // Rising and fading says the same thing and holds the column still.
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ type: 'spring', damping: 22, stiffness: 320 }}
      // The card itself never takes a click. A notification is a passing remark
      // laid over the app's bottom-right corner — on a canvas that is the
      // right-hand column, and while three or four of these were up, a business
      // user could not click the rows underneath: the left of a row worked and
      // the rest was dead, for a few seconds at a time, over and over as
      // children loaded.
      // Only the controls below opt back in, so the message can still be
      // dismissed or actioned, and everything else passes straight through.
      className={cn(
        'w-80 max-w-sm rounded-xl overflow-hidden pointer-events-none',
        'bg-white dark:bg-slate-800',
        'border border-slate-200 dark:border-slate-700 shadow-lg shadow-black/15 dark:shadow-black/40',
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3.5">
        <Icon className={cn(
          'w-4.5 h-4.5 flex-shrink-0',
          iconColors[notification.type],
          isLoading && 'animate-spin',
        )} />
        <span className="flex-1 text-sm text-ink leading-snug">{notification.message}</span>
        {notification.action && (
          <button
            onClick={() => { notification.action!.onClick(); onDismiss() }}
            className="pointer-events-auto flex-shrink-0 px-2.5 py-1 rounded-lg text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition-colors"
          >
            {notification.action.label}
          </button>
        )}
        {!isLoading && (
          <button
            onClick={onDismiss}
            className="pointer-events-auto opacity-40 hover:opacity-100 transition-opacity flex-shrink-0 rounded-md p-0.5 hover:bg-black/5 dark:hover:bg-white/5"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Progress bar — only for auto-dismissing notifications */}
      {!isLoading && (
        <div className="h-0.5 w-full bg-black/5 dark:bg-white/5">
          <div
            className={cn('h-full transition-none rounded-r-full', accentColors[notification.type])}
            style={{
              width: `${fromPercent}%`,
              opacity: 0.6,
              animation: `nx-toast-progress ${remainingMs}ms linear forwards`,
            }}
          />
        </div>
      )}

      {/* Indeterminate bar for loading notifications */}
      {isLoading && (
        <div className="h-0.5 w-full bg-black/5 dark:bg-white/5 overflow-hidden">
          <div
            className={cn('h-full w-1/3 rounded-full', accentColors[notification.type])}
            style={{
              opacity: 0.6,
              animation: 'toast-indeterminate 1.5s ease-in-out infinite',
            }}
          />
          <style>{`@keyframes toast-indeterminate { 0% { transform: translateX(-100%); } 100% { transform: translateX(400%); } }`}</style>
        </div>
      )}
    </motion.div>
  )
}

// ─── Container ────────────────────────────────────────────────────────────

/**
 * Render once at the app root (e.g. AppLayout). Displays all active notifications
 * in a fixed stack at the bottom-right.
 */
export function NotificationStack() {
  const notifications = useNotificationStore(s => s.notifications)

  return (
    <div
      // Notifications share the bottom-right corner with the canvas dock (the
      // Data loads and Connections panels), which sits BELOW them at z-40 —
      // a visible notification used to sit on top of the dock's headers and eat
      // the click that collapses them. Surfaces that reserve that corner
      // publish their height as `--canvas-dock-height` on the document
      // element; the stack starts above whatever is reserved, and the var
      // is absent (0px) everywhere else in the app.
      data-testid="notification-stack"
      style={{ bottom: 'calc(1.5rem + var(--canvas-dock-height, 0px))' }}
      // `items-end` pins every card's right edge, so the column reads as one
      // stack however wide a message makes a card.
      className="fixed right-6 z-[80] flex flex-col-reverse items-end gap-2 pointer-events-none"
    >
      {/* `popLayout` is what keeps the stack tidy. In the default mode a
          dismissed card keeps its slot in the flex column for the whole exit
          animation — invisible, but still 56px tall — so with messages
          arriving and leaving continuously the survivors were left floating
          above 64px holes, scattered down the right of the screen. popLayout
          takes an exiting card out of the flow at once and the rest close up
          (each card carries `layout`, so they slide rather than jump). */}
      <AnimatePresence mode="popLayout">
        {notifications.map(notification => (
          <NotificationCard key={notification.id} notification={notification} />
        ))}
      </AnimatePresence>
    </div>
  )
}
