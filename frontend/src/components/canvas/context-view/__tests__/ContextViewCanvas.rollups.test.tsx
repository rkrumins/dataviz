/**
 * Relationships only, or roll-ups too — on the real canvas. By default every line is a
 * relationship: a roll-up between two cards is not drawn, and the layer strip says how many such
 * lines it left out. "Show roll-ups" draws them; "Hide roll-ups" takes them away again.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { act, fireEvent, within } from '@testing-library/react'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useCanvasStore, type LineageEdge } from '@/store/canvas'
import { usePreferencesStore } from '@/store/preferences'

const drawn = () => [...document.querySelectorAll<SVGGElement>('g[data-edge-id]')].map((g) =>
  `${g.getAttribute('data-edge-src')}->${g.getAttribute('data-edge-tgt')}`)

beforeEach(() => {
  usePreferencesStore.setState({ lineageRenderMode: 'raw', showLineageRollups: false })
})

describe('ContextViewCanvas — relationships only, or roll-ups too', () => {
  it('leaves roll-ups out by default, says how many, and draws them on request', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    act(() => {
      useCanvasStore.getState().addEdges([
        { id: 'f1', source: 'tableau', target: 'REPORTING', data: { edgeType: 'FLOWS_TO' } },
        // A materialized roll-up between two cards on the board.
        { id: 'agg1', source: 'INTERMEDIATE_T2', target: 'tableau', data: { edgeType: 'AGGREGATED', isAggregated: true, sourceEdgeCount: 6 } },
      ] as LineageEdge[])
    })
    await h.settle()
    expect(drawn()).toEqual(['tableau->REPORTING'])
    const chip = document.querySelector<HTMLElement>('[data-testid="rollups-chip"]')!
    expect(chip).toHaveTextContent('Relationships only · 1 roll-up line hidden')

    await act(async () => { fireEvent.click(within(chip).getByRole('button', { name: 'Show roll-ups' })) })
    await h.settle()
    expect(usePreferencesStore.getState().showLineageRollups).toBe(true)
    expect(drawn().sort()).toEqual(['INTERMEDIATE_T2->tableau', 'tableau->REPORTING'])

    await act(async () => { fireEvent.click(within(document.querySelector<HTMLElement>('[data-testid="rollups-chip"]')!).getByRole('button', { name: 'Hide roll-ups' })) })
    await h.settle()
    expect(drawn()).toEqual(['tableau->REPORTING'])
  }, 30000)
})
