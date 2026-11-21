/**
 * Several entities held on the canvas: the selection bar opens what they share
 * (outside a draft, Details — read-only) in the entity drawer, which compares
 * them. Opening one entity's details turns the same drawer to that entity.
 */
import { describe, it, expect } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useCanvasStore } from '@/store/canvas'

describe('several entities, read as one', () => {
  it('Details opens what they share, and an entity\'s own details take the rail back', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    act(() => {
      useCanvasStore.getState().selectNode('INTERMEDIATE_T2')
      useCanvasStore.getState().selectNode('REPORTING', true)
    })
    await h.settle()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Details' })) })
    await h.settle()
    expect(screen.getByRole('heading', { name: '2 entities' })).toBeInTheDocument()
    expect(useCanvasStore.getState().drawerNodeId).toBeNull()
    expect(useCanvasStore.getState().drawerNodeIds).toEqual(['INTERMEDIATE_T2', 'REPORTING'])

    act(() => useCanvasStore.getState().openNodeDrawer('tableau'))
    await h.settle()
    // The same drawer, now on the one entity.
    await waitFor(() => expect(screen.queryByRole('heading', { name: '2 entities' })).toBeNull(), { timeout: 3000 })
    expect(useCanvasStore.getState().drawerNodeIds).toBeNull()
  })
})
