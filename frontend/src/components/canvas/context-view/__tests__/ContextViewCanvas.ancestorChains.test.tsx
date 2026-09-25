/**
 * CHAIN RESOLUTION IS ALWAYS ON IN BROWSE.
 *
 * Where an end the canvas does not draw lives decides whether its lineage is
 * inside the view: a partner in a collapsed container or an anchored column
 * is in the view, and only one that nothing drawn holds leads outside. That
 * used to sit behind the `canvasLineageRollupEnabled` preview, off by
 * default, so every such partner read as outside the view.
 */
import { act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { anchoredEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'
import { useCanvasStore } from '@/store/canvas'

beforeEach(() => {
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
})

const flow = (id: string, source: string, target: string) =>
  ({ id, source, target, type: 'lineage', data: { edgeType: 'TRANSFORMS', relationship: 'TRANSFORMS' } })

describe('the browse canvas asks where the lineage ends it does not draw live', () => {
  it('with no switch turned on, and never about an anchor, drawn as its column', async () => {
    const h = await renderCanvasWithTrace(anchoredEstate(), { focus: 'SRC.orders', ancestorChains: true })

    act(() => {
      useCanvasStore.getState().addGraph([], [
        flow('f1', 'SRC.orders', 'DST'),
        flow('f2', 'SRC.orders', 'elsewhere.table'),
      ] as never)
    })

    await waitFor(() => {
      if (!h.chainRequests().flat().includes('elsewhere.table')) throw new Error('no chain asked for elsewhere.table')
    }, { timeout: 4000 })
    const asked = h.chainRequests().flat()
    expect(asked).not.toContain('DST')
    expect(asked).not.toContain('SRC.orders')
  })
})
