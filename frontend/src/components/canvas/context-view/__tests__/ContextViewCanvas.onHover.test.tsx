/**
 * Edge Density: On Hover, on the real canvas.
 *
 * On Hover draws no line until an entity is hovered or selected. The Flows
 * panel still lists every line the canvas could draw, so it is not empty on
 * open, and hovering one of its rows draws that row's lines.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { anchoredEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'
import { useCanvasStore } from '@/store/canvas'
import { usePreferencesStore } from '@/store/preferences'

beforeEach(() => {
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
  usePreferencesStore.setState({ lineageRenderMode: 'stubs' } as never)
})

const flow = (source: string, target: string) => ({
  id: `f:${source}>${target}`, source, target, type: 'lineage',
  data: { edgeType: 'TRANSFORMS', relationship: 'TRANSFORMS' },
})

async function openView() {
  const h = await renderCanvasWithTrace(anchoredEstate(), { focus: 'SRC.orders' })
  act(() => {
    useCanvasStore.getState().addGraph([], [flow('SRC.orders', 'DST.revenue')] as never)
  })
  await h.settle()
  return h
}

const drawn = (h: Awaited<ReturnType<typeof openView>>) => h.wires().map(w => `${w.source}>${w.target}`)

describe('On Hover', () => {
  it('the Flows panel lists the lines the canvas can draw, and hovering a row draws them', async () => {
    const h = await openView()
    // Nothing hovered or selected: On Hover draws nothing.
    expect(drawn(h)).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: /Flows/ }))
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-connection-row="TRANSFORMS"]')
      if (!el) throw new Error('the Flows panel lists no TRANSFORMS row')
      return el
    })

    fireEvent.mouseEnter(row)
    await waitFor(() => expect(drawn(h)).toContain('SRC.orders>DST.revenue'), { timeout: 4000 })
  }, 20_000)

  it('selecting several entities draws all of their lines', async () => {
    const h = await openView()
    act(() => {
      useCanvasStore.getState().addGraph([], [flow('SRC.customers', 'DST.revenue')] as never)
    })
    await h.settle()

    act(() => { useCanvasStore.getState().setSelection(['SRC.orders', 'SRC.customers']) })

    await waitFor(() => expect(drawn(h).sort()).toEqual(['SRC.customers>DST.revenue', 'SRC.orders>DST.revenue']),
      { timeout: 4000 })
  }, 20_000)
})
