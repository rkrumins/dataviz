/**
 * An unstaged edit in the entity drawer, on the real canvas: whatever would move the drawer asks
 * first — Esc on the canvas, a click on another card, starting a trace — and nothing happens,
 * selection included, until the reader answers.
 */
import { describe, it, expect } from 'vitest'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useCanvasStore } from '@/store/canvas'

async function editInDrawer(h: Awaited<ReturnType<typeof renderCanvasWithTrace>>) {
  await h.openDrawer('tableau')
  const drawer = document.querySelector<HTMLElement>('[data-panel="entity-drawer"]')!
  await act(async () => { fireEvent.mouseDown(within(drawer).getByRole('tab', { name: /^Edit/ })) })
  await act(async () => {
    fireEvent.change(within(drawer).getByLabelText('Description'), { target: { value: 'An unstaged edit' } })
  })
  await h.settle()
  expect(useCanvasStore.getState().drawerDirty).toBe(true)
}

const dialog = () => screen.queryByRole('alertdialog', { name: 'Unsaved changes' })

describe('ContextViewCanvas — an unstaged drawer edit is asked about before the drawer moves', () => {
  it('Esc on the canvas asks; Keep editing leaves everything as it was', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', draft: true })
    await editInDrawer(h)
    act(() => { useCanvasStore.getState().setSelection(['tableau']) })

    h.pressEscape()
    await h.settle()
    expect(dialog()).toBeInTheDocument()
    expect(h.drawerEntity()).not.toBeNull()
    expect(useCanvasStore.getState().drawerNodeId).toBe('tableau')
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['tableau'])

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Keep editing' })) })
    await h.settle()
    expect(dialog()).not.toBeInTheDocument()
    expect(useCanvasStore.getState().drawerNodeId).toBe('tableau')
    expect(within(document.querySelector<HTMLElement>('[data-panel="entity-drawer"]')!).getByLabelText('Description'))
      .toHaveValue('An unstaged edit')
  }, 30000)

  it('a click on another card waits — selection too — and Discard carries it out', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', draft: true })
    await editInDrawer(h)
    const selectedBefore = useCanvasStore.getState().selectedNodeIds

    expect(h.visibleCardIds()).toContain('INTERMEDIATE_T2')
    await h.clickCard('INTERMEDIATE_T2')
    expect(dialog()).toBeInTheDocument()
    expect(useCanvasStore.getState().drawerNodeId).toBe('tableau')
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(selectedBefore)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Discard' })) })
    await h.settle()
    expect(useCanvasStore.getState().drawerNodeId).toBe('INTERMEDIATE_T2')
    expect(useCanvasStore.getState().selectedNodeIds).toContain('INTERMEDIATE_T2')
    expect(useCanvasStore.getState().drawerDirty).toBe(false)
  }, 30000)

  it('starting a trace from the drawer asks first, and starts once the edit is discarded', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', draft: true })
    await editInDrawer(h)

    const drawer = document.querySelector<HTMLElement>('[data-panel="entity-drawer"]')!
    await act(async () => { fireEvent.click(within(drawer).getByRole('button', { name: /Full Lineage/ })) })
    await h.settle()
    expect(dialog()).toBeInTheDocument()
    expect(h.isTracing()).toBe(false)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Discard' })) })
    await h.settle()
    expect(h.isTracing()).toBe(true)
  }, 30000)
})
