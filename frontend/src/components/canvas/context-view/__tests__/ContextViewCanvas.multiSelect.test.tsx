/**
 * A MULTI-SELECTION on the real canvas, before any trace — browse mode.
 *
 * Cmd-clicking a second entity has to read as "these, together": every
 * selected entity's lines drawn, and the partners those lines reach lit as
 * they are for one entity — ringed, at full strength. They used to take the
 * selection's dim like any row nobody picked, so the combined lineage was
 * drawn and then faded out at both ends. The header and the SelectionBar
 * then say what is held and what it touches.
 */
import { act, fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useCanvasStore, type LineageEdge } from '@/store/canvas'
import { usePreferencesStore } from '@/store/preferences'

const row = (id: string) => {
  const el = document.getElementById(`layer-node-${id}`)
  if (!el) throw new Error(`no card ${id}`)
  return el
}

const wireKeys = (h: { wires(): Array<{ source: string; target: string }> }) =>
  h.wires().map(w => `${w.source}>${w.target}`).sort()

describe('selecting two entities in browse mode', () => {
  it('draws both entities’ lines, keeps their partner lit, and says so in the header and the bar', async () => {
    // Stubs: the canvas draws only the lines of what is selected, so a line
    // on screen is a line the selection owns.
    usePreferencesStore.setState({ lineageRenderMode: 'stubs' })
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    // The warehouse's two containers, each with one flow through Tableau:
    // one feeds it, the other is fed by it.
    act(() => {
      useCanvasStore.getState().addEdges([
        { id: 'f1', source: 'INTERMEDIATE_T2', target: 'tableau', data: { edgeType: 'FLOWS_TO' } },
        { id: 'f2', source: 'tableau', target: 'REPORTING', data: { edgeType: 'FLOWS_TO' } },
      ] as LineageEdge[])
    })
    await h.settle()

    await act(async () => { fireEvent.click(row('INTERMEDIATE_T2'), { metaKey: true }) })
    await act(async () => { fireEvent.click(row('REPORTING'), { metaKey: true }) })
    await h.settle()
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['INTERMEDIATE_T2', 'REPORTING'])

    // Each selected entity's line, not just the first's.
    expect(wireKeys(h)).toEqual(['INTERMEDIATE_T2>tableau', 'tableau>REPORTING'])

    // The partner both lines reach: ringed, and not dimmed as unpicked.
    const partner = row('tableau').className
    expect(partner).toContain('ring-blue-400/40')
    expect(partner).not.toContain('opacity-60')
    expect(partner).not.toContain('opacity-40')

    // The header traces the pair as one.
    expect(screen.getByRole('button', { name: /^trace 2 entities$/i })).toBeTruthy()

    // The bar: two held, one entity feeding them and one fed by them.
    const bar = screen.getByRole('region', { name: /selected entities/i })
    expect(within(bar).getByText('2')).toBeTruthy()
    expect(within(bar).getByText(/^1 in$/)).toBeTruthy()
    expect(within(bar).getByText(/^1 out$/)).toBeTruthy()
    expect(h.consoleErrors()).toEqual([])
  }, 30000)
})
