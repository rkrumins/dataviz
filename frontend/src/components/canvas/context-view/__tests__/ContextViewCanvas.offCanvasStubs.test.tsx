/**
 * Lineage that leaves the view, on the real canvas: its stubs follow the
 * Missing-link alerts switch.
 *
 * jsdom gives every row the same box, so the overlay never has room to paint
 * a stub; what the canvas hands the overlay for its stubs is read instead.
 */
import { act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OffCanvasLineage } from '@/hooks/useEdgeProjection'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { anchoredPortsEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'
import { useCanvasStore } from '@/store/canvas'
import { usePreferencesStore } from '@/store/preferences'

const overlay = vi.hoisted(() => ({ offCanvas: undefined as ReadonlyMap<string, OffCanvasLineage> | undefined }))
vi.mock('../LineageFlowOverlay', async (original) => {
  const real = await original<typeof import('../LineageFlowOverlay')>()
  return {
    ...real,
    LineageFlowOverlay: (props: Parameters<typeof real.LineageFlowOverlay>[0]) => {
      overlay.offCanvas = props.offCanvasLineage
      return <real.LineageFlowOverlay {...props} />
    },
  }
})

beforeEach(() => {
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
  usePreferencesStore.setState({ showMissingConnectionIndicators: true } as never)
  overlay.offCanvas = undefined
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
