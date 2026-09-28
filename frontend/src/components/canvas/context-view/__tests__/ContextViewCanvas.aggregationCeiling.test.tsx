/**
 * ROLL-UPS ARE NOT STARVED BY A LOAD THAT NEVER SETTLES.
 *
 * The canvas holds its `/edges/aggregated` fetch while any child load is in
 * flight, so a page that lands is not asked about only to be superseded a
 * moment later. But the hold was for the WHOLE canvas: one slow page, or
 * columns that keep paging as the reader scrolls, and the rows every other
 * expand brought in waited for their roll-up lines for as long as that went
 * on. The hold now has a ceiling: the fetch runs at the latest about two
 * seconds after the rows it is for changed, loading or not.
 *
 * Driven on the real canvas, because the hold reads the hydration's live
 * `loadingNodes`, which only the canvas wires to the fetch.
 */
import { waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'

beforeEach(() => {
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
})

describe('the aggregated fetch while another container is still loading', () => {
  it('asks about the rows an expand brought in within its ceiling', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), {
      focus: 'cfo',
      browseHolds: ['snowflake', 'tableau', 'INTERMEDIATE_T2', 'REPORTING'],
      // REPORTING's children never arrive: its load stays in flight.
      holdChildren: ['REPORTING'],
    })
    await waitFor(() => {
      if (h.aggregatedSources().length === 0) throw new Error('no aggregated request went out')
    }, { timeout: 4000 })

    await h.toggle('REPORTING')
    await h.toggle('INTERMEDIATE_T2')
    await waitFor(() => expect(h.visibleCardIds()).toContain('orders'), { timeout: 4000 })

    // `orders` landed while REPORTING is still loading.
    await waitFor(() => {
      expect(h.aggregatedSources().some(sources => sources.includes('orders'))).toBe(true)
    }, { timeout: 3500 })
  }, 20000)
})
