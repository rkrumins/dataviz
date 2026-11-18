/**
 * A view that follows another keeps no layers of its own: they are that view's, served on every
 * read. So when someone puts a member in another of those layers, the canvas saves where they put
 * it and no layers — a layout write carrying layers to such a view is refused by the server.
 */
import { describe, it, expect, vi } from 'vitest'

const updateViewLayoutMock = vi.fn()
vi.mock('@/services/viewApiService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/viewApiService')>()),
  updateViewLayout: (...args: unknown[]) => updateViewLayoutMock(...args),
}))

import { act } from '@testing-library/react'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'
import { useSchemaStore } from '@/store/schema'
import { layoutWriter } from '@/store/canvasLayoutBridge'

/** Longer than the canvas's 1500ms autosave debounce. */
const PAST_THE_DEBOUNCE = 1800

describe('saving the layout of a view that follows another', () => {
  it('saves where people put things, and never layers', async () => {
    useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
    updateViewLayoutMock.mockResolvedValue({})
    const estate = cfoEstate()
    await renderCanvasWithTrace(estate, { focus: 'cfo' })
    const view = useSchemaStore.getState().getActiveView()!
    act(() => {
      useSchemaStore.getState().updateView(view.id, {
        membership: {
          v: 1, mode: 'live', sources: [], exclude: [], overrides: {}, provenance: { origin: 'trace' },
          layout: { kind: 'follow', sourceViewId: 'base-view', nest: true },
        },
      } as never)
    })
    const writer = layoutWriter()!
    const now = writer.current()
    const layer = now.layers[1]!.id
    vi.useFakeTimers()
    try {
      act(() => {
        writer.persist({ ...now, assignments: { ...now.assignments, cfo: { layerId: layer, assignedBy: 'user' } as never } })
      })
      await act(async () => { vi.advanceTimersByTime(PAST_THE_DEBOUNCE) })
    } finally {
      vi.useRealTimers()
    }
    expect(updateViewLayoutMock).toHaveBeenCalledOnce()
    const [, body] = updateViewLayoutMock.mock.calls[0]!
    expect(body.referenceLayout.layers).toEqual([])
    expect(body.referenceLayout.assignments.cfo).toMatchObject({ layerId: layer })
    // The canvas still shows the layers it was served.
    expect(useSchemaStore.getState().getActiveView()!.layout!.referenceLayout!.layers!.length).toBe(now.layers.length)
  }, 30000)
})
