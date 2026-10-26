/**
 * Questions from a right-click, on the real canvas: the menu on a card asks
 * about that entity — or about the whole selection it is part of — and the
 * search panel opens on the question's query.
 */
import { describe, it, expect } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useCanvasStore } from '@/store/canvas'
import { useSearchStore } from '@/store/searchStore'


async function rightClick(id: string) {
  const card = document.querySelector<HTMLElement>(`#${CSS.escape(`layer-node-${id}`)}`)
  if (!card) throw new Error(`no card for ${id}`)
  await act(async () => { fireEvent.contextMenu(card) })
}


describe('questions from a right-click on the canvas', () => {
  it('asks what feeds the entity — and what is inside it — walking from it', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    const [id] = h.visibleCardIds()
    await rightClick(id)
    await act(async () => { fireEvent.click(screen.getByText('What feeds this')) })

    // The card holds others (childCount 1), so its lineage runs through them.
    const is = { kind: 'is', refs: [{ urn: id }] }
    expect(useSearchStore.getState().draftPredicate).toEqual({
      kind: 'related', axis: 'downstream', maxHops: 3,
      where: { kind: 'group', op: 'or', children: [is, { kind: 'related', axis: 'ancestor', where: is }] },
    })
  }, 30000)

  it('asks about the whole selection the entity is part of', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    const [a, b] = h.visibleCardIds()
    await act(async () => { useCanvasStore.setState({ selectedNodeIds: [a, b] }) })
    await rightClick(a)

    expect(screen.getByText('What all 2 feed')).toBeInTheDocument()
    expect(screen.queryByText('What feeds this')).not.toBeInTheDocument()
  }, 30000)
})
