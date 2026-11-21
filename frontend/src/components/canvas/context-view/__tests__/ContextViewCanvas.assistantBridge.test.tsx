/**
 * The AI assistant's way into the real canvas (store/canvasActionsBridge): the mounted Context
 * View registers for its view, says what it is looking at (the view, the selection, the entity in
 * focus), starts a trace the way the reader's own Trace does — with the direction and hops asked
 * for — and leaves with the canvas. The links that reach a canvas not yet open (`?focus=`,
 * `?search=`) are consumed and stripped; a malformed one leaves the view opening normally.
 */
import { act, cleanup, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useCanvasStore } from '@/store/canvas'
import { canvasActions } from '@/store/canvasActionsBridge'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'

describe('ContextViewCanvas — the assistant bridge', () => {
  it('registers for its view, says what it is looking at, and leaves with the canvas', async () => {
    await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    const bridge = canvasActions()
    expect(bridge?.viewId).toBe('harness-view')
    expect(bridge!.getContext()).toMatchObject({ viewId: 'harness-view', viewName: 'Harness View', selectedUrns: [] })

    act(() => { useCanvasStore.getState().setSelection(['cfo', 'tableau']) })
    expect(canvasActions()!.getContext()).toMatchObject({ selectedUrns: ['cfo', 'tableau'], focusUrn: 'cfo' })

    cleanup()
    expect(canvasActions()).toBeNull()
  }, 30_000)

  it('starts a trace with the direction and hops asked for', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    act(() => { canvasActions()!.startTrace(['cfo'], { direction: 'upstream', depth: 3 }) })
    await waitFor(() => expect(h.isTracing()).toBe(true), { timeout: 10_000 })
    await h.settle()
    expect(h.direction()).toBe('up')
    expect(h.providerCalls()).toBeGreaterThan(0)
  }, 30_000)

  it('consumes a ?focus= link, and opens normally on a ?search= it cannot read', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', search: '?focus=orders&search=%%%not-base64' })
    await waitFor(() => expect(window.location.search).toBe(''), { timeout: 10_000 })
    expect(h.visibleCardIds().length).toBeGreaterThan(0)
  }, 30_000)
})
