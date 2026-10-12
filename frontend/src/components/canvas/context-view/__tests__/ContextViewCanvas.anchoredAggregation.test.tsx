/**
 * AN ANCHORED COLUMN'S ROWS GET THEIR ROLL-UPS.
 *
 * A Data Source view is one column per entity: the column is anchored at the
 * entity, the anchor is promoted to be the column (never a row), and its
 * children are the rows. The canvas used to pick `/edges/aggregated` targets
 * from STORE parents, where every row sits under an anchor that is never
 * "expanded" — so the anchors, which nobody sees as rows, were asked about,
 * and the rows the reader does see never were. They got no roll-up lines.
 *
 * Read off what the canvas puts on the wire, on the real canvas, because the
 * promotion happens in the layer assignment and only the canvas holds both.
 */
import { waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { anchoredEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'

beforeEach(() => {
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
})

describe('an anchored view asks for the roll-ups of the rows it draws', () => {
  it('the anchored rows are targets and the anchor is not', async () => {
    const h = await renderCanvasWithTrace(anchoredEstate(), { focus: 'SRC.orders' })

    // The picture the reader has: the anchors are the columns, not rows.
    expect(h.visibleCardIds().sort()).toEqual(['DST.revenue', 'SRC.customers', 'SRC.orders'])

    // The fan-out is debounced behind the settle.
    await waitFor(() => {
      if (h.aggregatedSources().length === 0) throw new Error('no aggregated request went out')
    }, { timeout: 4000 })

    for (const sources of h.aggregatedSources()) {
      expect(sources.sort()).toEqual(['DST.revenue', 'SRC.customers', 'SRC.orders'])
    }
  })
})
