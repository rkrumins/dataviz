/**
 * Toast history — the per-view record of messages that already came and went.
 *
 * A toast lives 4.5 seconds; the user who looked away has no way back to it.
 * The store therefore keeps a parallel, capped, newest-first log that is
 * INDEPENDENT of the live `toasts` array: removing a live toast (timer, close
 * button, hideLoading) must never touch history, and history is only ever
 * emptied wholesale by clearHistory() — which CanvasRouter calls on every view
 * change, so the log always describes the view you are looking at.
 *
 * Loading toasts are deliberately excluded: they are transient progress, and
 * their outcome arrives as its own success/error toast.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useToastStore, TOAST_HISTORY_LIMIT } from '../toast'

beforeEach(() => {
  useToastStore.setState({ toasts: [], history: [], _nextId: 1 })
})

describe('toast history', () => {
  it('records every non-loading toast, newest first', () => {
    const { addToast } = useToastStore.getState()
    addToast({ type: 'success', message: 'View saved' })
    addToast({ type: 'error', message: 'Save failed' })

    const { history } = useToastStore.getState()
    expect(history.map(h => h.message)).toEqual(['Save failed', 'View saved'])
    expect(history.map(h => h.type)).toEqual(['error', 'success'])
    expect(history[0].id).toBeTypeOf('number')
    expect(history[0].createdAt).toBeTypeOf('number')
  })

  it('does not record loading toasts', () => {
    const { addToast } = useToastStore.getState()
    addToast({ type: 'loading', message: 'Loading entities', key: 'hydration' })
    expect(useToastStore.getState().toasts).toHaveLength(1)
    expect(useToastStore.getState().history).toEqual([])

    addToast({ type: 'success', message: 'Canvas ready' })
    expect(useToastStore.getState().history.map(h => h.message)).toEqual(['Canvas ready'])
  })

  it('caps at TOAST_HISTORY_LIMIT, dropping the oldest', () => {
    const { addToast } = useToastStore.getState()
    for (let i = 0; i < TOAST_HISTORY_LIMIT + 5; i++) {
      addToast({ type: 'info', message: `message ${i}` })
    }

    const { history } = useToastStore.getState()
    expect(history).toHaveLength(TOAST_HISTORY_LIMIT)
    // Newest kept…
    expect(history[0].message).toBe(`message ${TOAST_HISTORY_LIMIT + 4}`)
    // …oldest five dropped.
    expect(history[history.length - 1].message).toBe('message 5')
  })

  it('clearHistory empties the log without touching live toasts', () => {
    const { addToast, clearHistory } = useToastStore.getState()
    addToast({ type: 'success', message: 'View saved' })
    expect(useToastStore.getState().history).toHaveLength(1)

    clearHistory()
    expect(useToastStore.getState().history).toEqual([])
    expect(useToastStore.getState().toasts).toHaveLength(1)
  })

  it('removing a live toast leaves its history entry intact', () => {
    const { addToast, removeToast, removeByKey } = useToastStore.getState()
    const id = addToast({ type: 'warning', message: 'Some edges were skipped' })
    addToast({ type: 'success', message: 'Keyed', key: 'k' })

    removeToast(id)
    removeByKey('k')

    expect(useToastStore.getState().toasts).toEqual([])
    expect(useToastStore.getState().history.map(h => h.message))
      .toEqual(['Keyed', 'Some edges were skipped'])
  })
})
