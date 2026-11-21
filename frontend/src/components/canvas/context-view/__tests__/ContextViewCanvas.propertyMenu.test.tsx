/**
 * Properties from a right-click, on the real canvas: a selection is compared and edited in the
 * entity drawer; in a draft, a container's menu changes a property on its children (or on
 * everything inside it) through the bulk-change dialog — and outside a draft it isn't offered.
 */
import { describe, it, expect } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'

async function rightClick(id: string) {
  const card = document.querySelector<HTMLElement>(`#${CSS.escape(`layer-node-${id}`)}`)
  if (!card) throw new Error(`no card for ${id}`)
  await act(async () => { fireEvent.contextMenu(card) })
}

describe('properties from a right-click on the canvas', () => {
  it('compares a selection the entity is part of, in the entity drawer', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    const [a, b] = h.visibleCardIds()
    await act(async () => { useCanvasStore.setState({ selectedNodeIds: [a, b] }) })
    await rightClick(a)
    await act(async () => { fireEvent.click(screen.getByText('Compare & edit 2…')) })
    expect(useCanvasStore.getState().drawerNodeIds).toEqual([a, b])
  }, 30000)

  it('in a draft, changes a property on a container\'s children through the dialog', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', draft: true })
    await act(async () => { useBranchStore.setState({ graphId: 'harness-graph' } as never) })
    // The first card holds others (childCount 1).
    const [id] = h.visibleCardIds()
    await rightClick(id)
    expect(screen.getByText('Change properties of everything inside…')).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByText('Change properties of its children…')) })
    expect(await screen.findByRole('heading', { name: 'Change a property' })).toBeInTheDocument()
  }, 30000)

  it('outside a draft, offers no change to a container\'s entities', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    const [id] = h.visibleCardIds()
    await rightClick(id)
    expect(screen.queryByText('Change properties of its children…')).not.toBeInTheDocument()
  }, 30000)
})
