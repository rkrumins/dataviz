/**
 * LINEAGE INTO ROWS THE VIEW HOLDS BUT HAS NOT LOADED, on the real canvas.
 *
 * Staging is anchored at STG and holds s9 past its loaded page. A card in
 * another column whose only lineage leads to s9 was never asked about: the
 * canvas asked for roll-ups among the rows it draws, and s9 is not one. So
 * the card read HOLLOW ("only outside this view") about a partner that is in
 * the view.
 *
 * The canvas now also asks about the anchor, against its rows, both ways, in
 * a request of its own; what the loaded rows do not carry is lineage into the
 * rows not loaded yet, and the card is solid facing that column. On a draft
 * or a branch too: a holder answer cut short there costs only the holders'
 * own request, never the rows' lines.
 */
import { waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { anchoredPortsEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'

beforeEach(() => {
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
})

const rollUp = (sourceUrn: string, targetUrn: string, edgeCount: number) => ({
  id: `agg:${sourceUrn}>${targetUrn}`, sourceUrn, targetUrn, edgeCount,
  edgeTypes: ['TRANSFORMS'], confidence: 1, sourceEdgeIds: [],
})

/** `kind:dir` of the card's port on each side, or null for no port. */
function ports(id: string): { left: string | null; right: string | null } {
  const at = (side: 'left' | 'right') => {
    const el = document.getElementById(`layer-node-${id}`)?.querySelector<HTMLElement>(`[data-lineage-port="${side}"]`)
    return el ? `${el.dataset.port}:${el.dataset.dir}` : null
  }
  return { left: at('left'), right: at('right') }
}

function open(draft = false) {
  const estate = anchoredPortsEstate()
  return renderCanvasWithTrace(estate, {
    focus: 'SRC.raw_orders',
    draft,
    // s9 is a row of Staging past its loaded page.
    browseHolds: estate.model.nodes.map(n => n.urn).filter(urn => urn !== 's9' && urn !== 'far'),
    ancestorChains: true,
    nodeDegrees: { 'SRC.quiet': { in: 0, out: 2 } },
    // SRC.quiet → s9: to the server, a flow into Staging's anchor.
    aggregatedCells: [rollUp('SRC.quiet', 'STG', 2)],
  })
}

describe('lineage into the rows an anchored column has not loaded', () => {
  it('asks about the anchor beside the rows, and the card is solid facing that column', async () => {
    const h = await open()

    await waitFor(() => {
      expect(ports('SRC.quiet')).toEqual({ left: null, right: 'here:out' })
    }, { timeout: 8000 })

    // The rows against the anchor, both ways, in a request of its own.
    const asks = h.aggregatedSources().map((sources, i) => [sources.sort(), h.aggregatedTargets()[i].sort()])
    expect(asks).toContainEqual([expect.arrayContaining(['SRC.quiet', 's1', 's2']), ['STG']])
    expect(asks).toContainEqual([['STG'], expect.arrayContaining(['SRC.quiet', 's1', 's2'])])
  }, 20_000)

  it('asks about the anchor on a draft too, in a request of its own', async () => {
    const h = await open(true)

    await waitFor(() => {
      expect(ports('SRC.quiet')).toEqual({ left: null, right: 'here:out' })
    }, { timeout: 8000 })
    const asks = h.aggregatedSources().map((sources, i) => [sources.sort(), h.aggregatedTargets()[i].sort()])
    expect(asks).toContainEqual([expect.arrayContaining(['SRC.quiet', 's1', 's2']), ['STG']])
    expect(asks).toContainEqual([['STG'], expect.arrayContaining(['SRC.quiet', 's1', 's2'])])
  }, 20_000)
})
