/**
 * Edge Density: On Click, on the real canvas.
 *
 * Lines draw only for what is selected. Pointing at an entity draws nothing,
 * lights nothing and dims nothing — On Hover's control below shows the same
 * hover does draw there — and a trace still draws every line it walks.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { anchoredEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'
import { useCanvasStore } from '@/store/canvas'
import { usePreferencesStore } from '@/store/preferences'
import { DisplayMenu } from '../header/DisplayMenu'

beforeEach(() => {
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
})

const flow = (source: string, target: string) => ({
  id: `f:${source}>${target}`, source, target, type: 'lineage',
  data: { edgeType: 'TRANSFORMS', relationship: 'TRANSFORMS' },
})

async function openView() {
  const h = await renderCanvasWithTrace(anchoredEstate(), { focus: 'SRC.orders' })
  act(() => {
    useCanvasStore.getState().addGraph([], [flow('SRC.orders', 'DST.revenue'), flow('SRC.customers', 'DST.revenue')] as never)
  })
  await h.settle()
  return h
}
const drawn = (h: Awaited<ReturnType<typeof openView>>) => h.wires().map(w => `${w.source}>${w.target}`).sort()
const row = (id: string) => document.getElementById(`layer-node-${id}`)!
const spotlit = () => !!document.querySelector('[data-row-spotlight]')

describe('On Click', () => {
  it('a hover draws and dims nothing; a selection draws its own lines', async () => {
    usePreferencesStore.setState({ lineageRenderMode: 'click' } as never)
    const h = await openView()
    expect(drawn(h)).toEqual([])

    await act(async () => { fireEvent.mouseEnter(row('SRC.orders')) })
    await h.settle()
    expect(drawn(h)).toEqual([])
    expect(spotlit()).toBe(false)
    await act(async () => { fireEvent.mouseLeave(row('SRC.orders')) })

    act(() => { useCanvasStore.getState().setSelection(['SRC.orders']) })
    await waitFor(() => expect(drawn(h)).toEqual(['SRC.orders>DST.revenue']), { timeout: 4000 })
    // Selecting a second: both of their lines, still none for a hover.
    act(() => { useCanvasStore.getState().setSelection(['SRC.orders', 'SRC.customers']) })
    await waitFor(() => expect(drawn(h)).toEqual(['SRC.customers>DST.revenue', 'SRC.orders>DST.revenue']), { timeout: 4000 })
  }, 30_000)

  it('control: On Hover draws a hovered entity\'s lines and lights them', async () => {
    usePreferencesStore.setState({ lineageRenderMode: 'stubs' } as never)
    const h = await openView()
    expect(drawn(h)).toEqual([])
    await act(async () => { fireEvent.mouseEnter(row('SRC.orders')) })
    await waitFor(() => expect(drawn(h)).toEqual(['SRC.orders>DST.revenue']), { timeout: 4000 })
    expect(spotlit()).toBe(true)
    await act(async () => { fireEvent.mouseLeave(row('SRC.orders')) })
  }, 30_000)
})

describe('the On Click option', () => {
  it('is offered in Edge Density, in plain words in the Business view, with its own per-entity cap', () => {
    const onSet = vi.fn()
    const props = {
      canvasZoom: 1, onSetCanvasZoom: vi.fn(), canvasDensity: 'spacious' as const, onSetCanvasDensity: vi.fn(),
      showTypeBadge: true, onToggleTypeBadge: vi.fn(), subtleTreeLines: false, onToggleSubtleTreeLines: vi.fn(),
      onReset: vi.fn(), showEdgeDirection: false, onToggleEdgeDirection: vi.fn(), lineageEnabled: true,
    }
    const { unmount } = render(<DisplayMenu {...props} lineageRenderMode="stubs" onSetLineageRenderMode={onSet} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))
    fireEvent.click(screen.getByRole('radio', { name: /On Click/ }))
    expect(onSet).toHaveBeenCalledWith('click')
    unmount()

    render(<DisplayMenu {...props} lineageRenderMode="click" onSetLineageRenderMode={onSet} />)
    fireEvent.click(screen.getByRole('button', { name: 'Display' }))
    expect(screen.getByRole('radio', { name: /On Click/ })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('slider', { name: 'Lines per entity' })).toBeInTheDocument()
    expect(screen.getByText(/The most lines a selected entity draws at once/)).toBeInTheDocument()
  })
})
