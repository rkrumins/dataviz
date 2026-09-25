/**
 * A card's lineage on the real canvas, in and out of the view.
 *
 *   - Lineage that leaves the view has stubs; they follow the Missing-link
 *     alerts switch, and a click opens the Focus Lens on the stub's row.
 *   - Lineage into a row of an anchored column that is not loaded is in the
 *     view: selecting the card brings that row in, with nothing said.
 *
 * jsdom gives every row the same box, so the overlay never has room to paint
 * a stub; what the canvas hands the overlay for its stubs is read instead.
 */
import { act, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OffCanvasLineage } from '@/hooks/useEdgeProjection'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { anchoredPortsEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'
import { useCanvasStore } from '@/store/canvas'
import { usePreferencesStore } from '@/store/preferences'
import { useNotificationStore } from '@/components/ui/notifications'

const overlay = vi.hoisted(() => ({
  offCanvas: undefined as ReadonlyMap<string, OffCanvasLineage> | undefined,
  onOpen: undefined as ((nodeId: string) => void) | undefined,
}))
vi.mock('../LineageFlowOverlay', async (original) => {
  const real = await original<typeof import('../LineageFlowOverlay')>()
  return {
    ...real,
    LineageFlowOverlay: (props: Parameters<typeof real.LineageFlowOverlay>[0]) => {
      overlay.offCanvas = props.offCanvasLineage
      overlay.onOpen = props.onOpenOffCanvas
      return <real.LineageFlowOverlay {...props} />
    },
  }
})

beforeEach(() => {
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
  usePreferencesStore.setState({ showMissingConnectionIndicators: true } as never)
  overlay.offCanvas = undefined
  overlay.onOpen = undefined
})

const flow = (source: string, target: string) => ({
  id: `f:${source}>${target}`, source, target, type: 'lineage',
  data: { edgeType: 'TRANSFORMS', relationship: 'TRANSFORMS' },
})

async function openView() {
  const estate = anchoredPortsEstate()
  const h = await renderCanvasWithTrace(estate, {
    focus: 'SRC.raw_orders',
    // s9 is a row of Staging past its loaded page; `far` is held by nothing.
    browseHolds: estate.model.nodes.map(n => n.urn).filter(urn => urn !== 's9' && urn !== 'far'),
    ancestorChains: true,
  })
  act(() => {
    useCanvasStore.getState().addGraph([], [flow('far', 'dash'), flow('s2', 's9')] as never)
  })
  await h.settle()
  return h
}

describe('stubs for lineage that leaves the view', () => {
  it('follow the Missing-link alerts switch', async () => {
    await openView()
    await waitFor(() => expect(overlay.offCanvas?.get('dash')?.in).toBe(1), { timeout: 8000 })

    act(() => { usePreferencesStore.setState({ showMissingConnectionIndicators: false } as never) })
    await waitFor(() => expect(overlay.offCanvas).toBeUndefined())

    act(() => { usePreferencesStore.setState({ showMissingConnectionIndicators: true } as never) })
    await waitFor(() => expect(overlay.offCanvas?.get('dash')?.in).toBe(1))
  }, 20_000)
})

describe('a card\'s lines into rows of an anchored column that are not loaded', () => {
  it('selecting the card brings those rows in, and says nothing about it', async () => {
    const h = await openView()
    await waitFor(() => expect(overlay.offCanvas?.get('s2')?.columns.get('stg')?.outPartners.has('s9')).toBe(true),
      { timeout: 8000 })
    expect(h.visibleCardIds()).not.toContain('s9')
    const said = useNotificationStore.getState().notifications.length

    act(() => { useCanvasStore.getState().selectNode('s2') })

    await waitFor(() => expect(h.visibleCardIds()).toContain('s9'), { timeout: 8000 })
    await h.settle()
    expect(useNotificationStore.getState().notifications).toHaveLength(said)
    expect(h.consoleErrors()).toEqual([])
  }, 20_000)
})

describe('a stub\'s click', () => {
  it('opens the Focus Lens on its row', async () => {
    await openView()
    await waitFor(() => expect(overlay.onOpen).toBeDefined())

    act(() => { overlay.onOpen!('dash') })

    expect(await screen.findByRole('dialog', { name: /Connections of dash/ })).toBeInTheDocument()
  }, 20_000)
})
