/**
 * The canvas holds ONE pending layout-save payload, and the failure path decides what goes in it.
 *
 * Keeping a failed save's payload there was the right call — it is the work the user still has, and
 * the branch-switch effect's overwrite guard reads that same ref. But the slot was treated as a
 * plain flag, and two things fell out of that:
 *
 *  - The overwrite guard asked only "is something pending?", never "whose?". A save that failed on
 *    branch A therefore blocked branch B's layout from ever loading — the canvas showed A's columns
 *    under B's name, indefinitely — and the next gesture would have stamped A's layout onto B.
 *  - The restore in the catch asked only "is the slot empty?", never "is this still the newest
 *    attempt?". A slow PUT that rejects AFTER a later one succeeded put its stale payload back and
 *    raised an error over work that had in fact saved — and retrying it reverted the newer edit.
 *
 * Driven through display rules, the one durable layout gesture reachable without a pointer: the
 * Property Manager writes `useReferenceModelStore` and the canvas's persist effect arms exactly the
 * same debounced save as a layer create, a rename or an entity moved between columns.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const updateViewLayoutMock = vi.fn()
const getViewMock = vi.fn()
vi.mock('@/services/viewApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/viewApiService')>()),
  updateViewLayout: (...args: unknown[]) => updateViewLayoutMock(...args),
  getView: (...args: unknown[]) => getViewMock(...args),
}))

import { act, fireEvent, screen } from '@testing-library/react'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'
import { useBranchStore } from '@/store/branchStore'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { useSchemaStore } from '@/store/schema'
import { useNotificationStore } from '@/components/ui/notifications'
import type { DisplayRuleConfig, ViewLayerConfig } from '@/types/schema'

/** Longer than the canvas's 1500ms autosave debounce. */
const PAST_THE_DEBOUNCE = 1800

const messages = () => useNotificationStore.getState().notifications.map(n => `${n.type}: ${n.message}`)
const retryButton = () => screen.queryByRole('button', { name: /sync issue/i })
const activeLayers = (): ViewLayerConfig[] =>
  (useSchemaStore.getState().getActiveView()?.layout?.referenceLayout?.layers ?? []) as ViewLayerConfig[]

const rule = (id: string): DisplayRuleConfig => ({
  id, name: id, color: '#ff0000', predicate: null, enabled: true, createdAt: '2026-08-30T00:00:00Z',
})

/** A promise this test settles by hand, so two saves can be in flight at once. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** The branch the canvas opens on (the harness's draft) and the one we switch to. */
const BRANCH_A = 'harness-branch'
const BRANCH_B = 'harness-branch-2'
/** A layer that exists ONLY in branch B's layout — the proof B's layout was applied. */
const B_ONLY: ViewLayerConfig = { id: 'B-ONLY', name: 'Branch B only', entityTypes: [], order: 9, color: '#00ff88' }

async function openCanvas(estate: ReturnType<typeof cfoEstate>, draft = false) {
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
  useNotificationStore.setState({ notifications: [], history: [] } as never)
  const base = { layers: estate.layers, assignments: estate.assignments }
  getViewMock.mockImplementation(async (_id: string, branchId?: string) => ({
    id: 'harness-view',
    config: {
      layout: {
        type: 'reference',
        referenceLayout: branchId === BRANCH_B ? { ...base, layers: [...estate.layers, B_ONLY] } : base,
      },
      content: { entityScope: 'curated' },
    },
  }))
  return renderCanvasWithTrace(estate, { focus: 'cfo', draft })
}

/** Make a durable layout edit — the canvas arms its debounced save on it. */
function editLayout(id: string) {
  act(() => { useReferenceModelStore.getState().setDisplayRules([rule(id)]) })
}

const pastTheDebounce = async () => {
  await act(async () => { await new Promise(r => setTimeout(r, PAST_THE_DEBOUNCE)) })
}

describe('the canvas\'s single pending layout-save slot', () => {
  beforeEach(() => {
    updateViewLayoutMock.mockReset()
    getViewMock.mockReset()
  })

  it('does not resurrect an older failed save over a newer one that landed', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    updateViewLayoutMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const h = await openCanvas(cfoEstate())

    editLayout('r1')
    await pastTheDebounce()
    expect(updateViewLayoutMock).toHaveBeenCalledTimes(1)   // PUT1 in flight
    editLayout('r2')
    await pastTheDebounce()
    expect(updateViewLayoutMock).toHaveBeenCalledTimes(2)   // PUT2 in flight

    // The NEWER save lands…
    await act(async () => { second.resolve({}) })
    await h.settle()
    // …and only then does the older one give up. It is stale: its work is contained in the save
    // that just succeeded, so it must not go back in the slot, and the user must not be told the
    // layout failed to save. Retrying it would PUT the older layout and revert the newer edit.
    await act(async () => { first.reject(new Error('PUT1 rejected')) })
    await h.settle()

    expect(retryButton()).toBeNull()
    expect(messages().some(m => m.startsWith('error'))).toBe(false)
  }, 30000)

  it('still reports a lone failure — the newest attempt keeps its payload and says so', async () => {
    updateViewLayoutMock.mockRejectedValue(new Error('layout PUT rejected'))
    const h = await openCanvas(cfoEstate())

    editLayout('r1')
    await pastTheDebounce()
    await h.settle()

    expect(retryButton()).not.toBeNull()
    expect(messages().join('\n')).toMatch(/error: .*layout/i)
  }, 30000)

  it('loads the new branch\'s layout even while a save that failed on the OLD branch is pending', async () => {
    updateViewLayoutMock.mockRejectedValue(new Error('layout PUT rejected'))
    const h = await openCanvas(cfoEstate(), true)

    editLayout('r1')
    await pastTheDebounce()
    await h.settle()
    expect(retryButton()).not.toBeNull()          // the edit is pending, owned by branch A
    expect(activeLayers().some(l => l.id === B_ONLY.id)).toBe(false)

    act(() => { useBranchStore.setState({ currentBranchId: BRANCH_B } as never) })
    await h.settle()
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
    await h.settle()

    // The pending edit belongs to branch A, so it has no claim on branch B's layout: B's own
    // layout must load, or the canvas shows A's columns under B's name for the rest of the session
    // — and the next gesture writes A's layout onto B.
    expect(getViewMock).toHaveBeenCalledWith('harness-view', BRANCH_B)
    expect(activeLayers().some(l => l.id === B_ONLY.id)).toBe(true)

    // …and the failed edit is still branch A's work: a retry goes back to the branch it was made on.
    const button = retryButton()
    expect(button).not.toBeNull()
    await act(async () => { fireEvent.click(button!) })
    await h.settle()
    expect(updateViewLayoutMock.mock.calls.at(-1)?.[2]).toBe(BRANCH_A)
  }, 30000)
})
