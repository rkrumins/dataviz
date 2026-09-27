/**
 * The line the relationship drawer is open on, on the real canvas. In the default "On Hover"
 * density only a selection's lines are drawn — and the click on the line takes the selection — yet
 * the open line stays drawn. In any density it stays lit while every other line dims, until the
 * drawer closes.
 */
import { describe, it, expect } from 'vitest'
import { act, fireEvent } from '@testing-library/react'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useCanvasStore, type LineageEdge } from '@/store/canvas'
import { usePreferencesStore } from '@/store/preferences'

const groups = () => [...document.querySelectorAll<SVGGElement>('g[data-edge-id]')]
const lineGroup = (id: string) => groups().find((g) => g.getAttribute('data-edge-id') === id) ?? null

/** Two relationships on the board, both at `tableau`, then a click on one of their lines. */
async function openOneOfTwoLines() {
  const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
  act(() => {
    useCanvasStore.getState().addEdges([
      { id: 'f1', source: 'INTERMEDIATE_T2', target: 'tableau', data: { edgeType: 'FLOWS_TO' } },
      { id: 'f2', source: 'tableau', target: 'REPORTING', data: { edgeType: 'FLOWS_TO' } },
    ] as LineageEdge[])
  })
  await h.clickCard('tableau')
  await h.settle()
  const hits = document.querySelectorAll<SVGPathElement>('path[data-canvas-interactive]')
  expect(hits.length).toBe(2)
  await act(async () => { fireEvent.click(hits[0]) })
  await h.settle()
  const s = useCanvasStore.getState()
  expect(s.drawerEdge?.kind).toBe('relationship')
  expect(s.selectedNodeIds).toEqual([])
  return { h, lineId: s.drawerEdge!.kind === 'relationship' ? s.drawerEdge!.lineId! : '' }
}

describe('ContextViewCanvas — the line the drawer is open on', () => {
  it('stays drawn in "On Hover" after the click takes the selection, and goes when the drawer closes', async () => {
    usePreferencesStore.setState({ lineageRenderMode: 'stubs' })
    const { h, lineId } = await openOneOfTwoLines()
    expect(lineGroup(lineId)).not.toBeNull()
    expect(lineGroup(lineId)!.style.opacity).toBe('')

    h.pressEscape()
    await h.settle()
    expect(useCanvasStore.getState().drawerEdge).toBeNull()
    expect(lineGroup(lineId)).toBeNull()
  }, 30000)

  it('stays lit while every other line dims', async () => {
    usePreferencesStore.setState({ lineageRenderMode: 'raw' })
    const { lineId } = await openOneOfTwoLines()
    expect(groups()).toHaveLength(2)
    expect(lineGroup(lineId)!.style.opacity).toBe('')
    expect(groups().find((g) => g.getAttribute('data-edge-id') !== lineId)!.style.opacity).toBe('0.08')
  }, 30000)
})
