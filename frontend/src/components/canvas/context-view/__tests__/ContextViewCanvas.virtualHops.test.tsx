/**
 * VIRTUAL HOPS ON THE REAL CANVAS.
 *
 * A subset view keeps entities whose lineage runs through ones it left out.
 * The canvas asks the graph — once, for every member — which of them reach
 * which, and draws a stitched line where no real line runs. Driven on the real
 * canvas in browse mode, because only the canvas holds all of what decides
 * it: the view's scope and connectivity, its members, the flag, and whether
 * a trace is drawing.
 */
import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useCanvasStore } from '@/store/canvas'

// cfoEstate's view holds INTERMEDIATE_T2 and REPORTING (warehouse) and
// tableau (report); browse holds no line between INTERMEDIATE_T2 and tableau.
const STITCH = { source: 'INTERMEDIATE_T2', target: 'tableau', hops: 3 }

describe('virtual hops on a subset view', () => {
  it('asks once for every member, and stitches the two it connects', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), {
      focus: 'cfo',
      bridges: { connectivity: { mode: 'bridged', maxHops: 6 }, links: [STITCH] },
    })
    await waitFor(() => expect(h.bridgeRequests().length).toBe(1), { timeout: 4000 })
    const [request] = h.bridgeRequests()
    expect(request.maxHops).toBe(6)
    expect(request.members.map(m => m.urn).sort()).toEqual(['INTERMEDIATE_T2', 'REPORTING', 'tableau'])

    // The status cluster counts it, and its list names both ends.
    const chip = await screen.findByRole('button', { name: '1 virtual hop' }, { timeout: 4000 })
    expect(chip).toBeTruthy()

    // A virtual hop is no relationship: the mirror the drawer reads never
    // lists its far end as a partner.
    const mirrored = useCanvasStore.getState().visibleEdges.map(e => e.id)
    expect(mirrored.some(id => id.startsWith('bridge-'))).toBe(false)
  })

  it('asks nothing of a view that draws direct lines only', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), {
      focus: 'cfo',
      bridges: { connectivity: { mode: 'direct' }, links: [STITCH] },
    })
    await h.settle()
    expect(h.bridgeRequests()).toEqual([])
    expect(screen.queryByRole('button', { name: /virtual hop/ })).toBeNull()
  })
})
