/**
 * Notification history — the per-view record of messages that already came
 * and went.
 *
 * A notification lives 4.5 seconds; the user who looked away has no way back to
 * it. The store therefore keeps a parallel, capped, newest-first log that is
 * INDEPENDENT of the live `notifications` array: removing a live one (timer,
 * close button, hideLoading) must never touch history, and history is only ever
 * emptied wholesale by clearHistory() — which CanvasRouter calls on every view
 * change, so the log always describes the view you are looking at.
 *
 * Loading notifications are deliberately excluded: they are transient progress,
 * and their outcome arrives as its own success/error notification.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useNotificationStore, NOTIFICATION_HISTORY_LIMIT } from '../notifications'

beforeEach(() => {
  useNotificationStore.setState({ notifications: [], history: [], _nextId: 1 })
})

describe('notification history', () => {
  it('records every non-loading notification, newest first', () => {
    const { add } = useNotificationStore.getState()
    add({ type: 'success', message: 'View saved' })
    add({ type: 'error', message: 'Save failed' })

    const { history } = useNotificationStore.getState()
    expect(history.map(h => h.message)).toEqual(['Save failed', 'View saved'])
    expect(history.map(h => h.type)).toEqual(['error', 'success'])
    expect(history[0].id).toBeTypeOf('number')
    expect(history[0].createdAt).toBeTypeOf('number')
  })

  it('does not record loading notifications', () => {
    const { add } = useNotificationStore.getState()
    add({ type: 'loading', message: 'Loading entities', key: 'hydration' })
    expect(useNotificationStore.getState().notifications).toHaveLength(1)
    expect(useNotificationStore.getState().history).toEqual([])

    add({ type: 'success', message: 'Canvas ready' })
    expect(useNotificationStore.getState().history.map(h => h.message)).toEqual(['Canvas ready'])
  })

  it('caps at NOTIFICATION_HISTORY_LIMIT, dropping the oldest', () => {
    const { add } = useNotificationStore.getState()
    for (let i = 0; i < NOTIFICATION_HISTORY_LIMIT + 5; i++) {
      add({ type: 'info', message: `message ${i}` })
    }

    const { history } = useNotificationStore.getState()
    expect(history).toHaveLength(NOTIFICATION_HISTORY_LIMIT)
    // Newest kept…
    expect(history[0].message).toBe(`message ${NOTIFICATION_HISTORY_LIMIT + 4}`)
    // …oldest five dropped.
    expect(history[history.length - 1].message).toBe('message 5')
  })

  it('clearHistory empties the log without touching live notifications', () => {
    const { add, clearHistory } = useNotificationStore.getState()
    add({ type: 'success', message: 'View saved' })
    expect(useNotificationStore.getState().history).toHaveLength(1)

    clearHistory()
    expect(useNotificationStore.getState().history).toEqual([])
    expect(useNotificationStore.getState().notifications).toHaveLength(1)
  })

  it('removing a live notification leaves its history entry intact', () => {
    const { add, remove, removeByKey } = useNotificationStore.getState()
    const id = add({ type: 'warning', message: 'Some edges were skipped' })
    add({ type: 'success', message: 'Keyed', key: 'k' })

    remove(id)
    removeByKey('k')

    expect(useNotificationStore.getState().notifications).toEqual([])
    expect(useNotificationStore.getState().history.map(h => h.message))
      .toEqual(['Keyed', 'Some edges were skipped'])
  })
})
