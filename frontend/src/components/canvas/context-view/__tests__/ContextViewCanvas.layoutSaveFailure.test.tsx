/**
 * The canvas's layout autosave used to fail in silence — and take the user's work with it.
 *
 * `doLayoutSave` caught every error, logged it to the console and reset the indicator to 'idle'.
 * The header already carried a fully-built "Sync issue — retry" control, wired to `flushLayoutSave`
 * and gated on `syncStatus === 'error'`, that nothing could ever reach: the state was typed
 * 'idle' | 'saving'.
 *
 * Worse, the failure DESTROYED work. `doLayoutSave` nulls `pendingLayoutSave` before its await, and
 * the branch-switch effect flushes the pending save and then guards its re-fetch with
 * `if (pendingLayoutSave.current) return` — a guard the failed flush had already disarmed. The
 * server's stale layout then overwrote the edit. `UnsavedWorkGuard` cannot help: it keys off staged
 * changes, and layer/placement/display-rule edits are never staged.
 *
 * Everything durable on this canvas goes down this path — creating, renaming and reordering layers,
 * moving entities between columns, display rules. Driven here through display rules, which is the
 * one gesture reachable without a pointer: the Property Manager writes `useReferenceModelStore`,
 * and the canvas's persist effect arms exactly the same debounced save as every other gesture.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const updateViewLayoutMock = vi.fn()
vi.mock('@/services/viewApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/viewApiService')>()),
  updateViewLayout: (...args: unknown[]) => updateViewLayoutMock(...args),
}))

import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { useNotificationStore } from '@/components/ui/notifications'
import type { DisplayRuleConfig } from '@/types/schema'

/** Longer than the canvas's 1500ms autosave debounce. */
const PAST_THE_DEBOUNCE = 1800

const messages = () => useNotificationStore.getState().notifications.map(n => `${n.type}: ${n.message}`)
const retryButton = () => screen.queryByRole('button', { name: /sync issue/i })

const rule = (id: string): DisplayRuleConfig => ({
  id, name: id, color: '#ff0000', predicate: null, enabled: true, createdAt: '2026-08-30T00:00:00Z',
})

async function openCanvas() {
  // The layout save is armed only for a caller who may edit the view AND manage the data source.
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
  useNotificationStore.setState({ notifications: [], history: [] } as never)
  return renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
}

/** Make a durable layout edit — the canvas arms its debounced save on it. */
function editLayout(id = 'r1') {
  act(() => { useReferenceModelStore.getState().setDisplayRules([rule(id)]) })
}

describe('a canvas layout save that fails', () => {
  beforeEach(() => {
    updateViewLayoutMock.mockReset()
    updateViewLayoutMock.mockRejectedValue(new Error('layout PUT rejected'))
  })

  it('surfaces the failure — the header offers the retry it already had, and the app says so', async () => {
    const h = await openCanvas()
    editLayout()
    await act(async () => { await new Promise(r => setTimeout(r, PAST_THE_DEBOUNCE)) })
    await h.settle()

    expect(updateViewLayoutMock).toHaveBeenCalledTimes(1)
    expect(retryButton()).not.toBeNull()
    expect(messages().join('\n')).toMatch(/error: .*layout/i)
  }, 30000)

  it('KEEPS the failed edit pending, so retry re-sends it — the same slot the overwrite guard reads', async () => {
    const h = await openCanvas()
    editLayout()
    await act(async () => { await new Promise(r => setTimeout(r, PAST_THE_DEBOUNCE)) })
    await h.settle()

    const button = retryButton()
    expect(button).not.toBeNull()
    await act(async () => { fireEvent.click(button!) })
    await h.settle()

    // Twice, with the same payload: the pending edit survived its own failure. That ref is what the
    // branch-switch effect checks before letting the server's layout replace the local one.
    expect(updateViewLayoutMock).toHaveBeenCalledTimes(2)
    expect(updateViewLayoutMock.mock.calls[1]).toEqual(updateViewLayoutMock.mock.calls[0])
  }, 30000)

  it('reports a save that fails on the way out, when the canvas is already gone', async () => {
    const h = await openCanvas()
    editLayout()
    await h.settle()
    // Still inside the debounce window — nothing has been sent yet.
    expect(updateViewLayoutMock).not.toHaveBeenCalled()

    await act(async () => { cleanup() })
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })

    expect(updateViewLayoutMock).toHaveBeenCalledTimes(1)
    expect(messages().join('\n')).toMatch(/error: .*layout/i)
  }, 30000)

  it('a save that succeeds leaves no retry and says nothing', async () => {
    updateViewLayoutMock.mockResolvedValue({} as never)
    const h = await openCanvas()
    editLayout()
    await act(async () => { await new Promise(r => setTimeout(r, PAST_THE_DEBOUNCE)) })
    await h.settle()

    expect(updateViewLayoutMock).toHaveBeenCalledTimes(1)
    expect(retryButton()).toBeNull()
    expect(messages().some(m => m.startsWith('error'))).toBe(false)
  }, 30000)
})
