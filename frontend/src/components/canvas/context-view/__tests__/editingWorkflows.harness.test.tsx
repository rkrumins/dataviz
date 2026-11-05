/**
 * Editing workflows on the REAL Context View canvas, in a draft:
 *
 *   • the layer menu — right-click a column header, insert a layer beside it;
 *     it lands between the two, with its name open for editing, staged;
 *   • the Connect tool — click where a link starts, then where it goes, with
 *     no dragging; Escape backs out a step at a time;
 *   • Duplicate… — offered in an entity's menu, opening its dialog.
 */
import { act, fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { usePersonaStore } from '@/store/persona'
import { useStagedChangesStore } from '@/store/stagedChangesStore'

/** The columns, left to right, as rendered. */
const columnIds = () =>
  [...document.querySelectorAll<HTMLElement>('[data-layer-id].group\\/column')].map((el) => el.dataset.layerId)

const headerOf = (layerId: string) => {
  const header = document.querySelector<HTMLElement>(`[data-layer-id="${layerId}"].group\\/column .sticky.top-0`)
  if (!header) throw new Error(`no header for ${layerId}`)
  return header
}

const cardBody = (id: string) => {
  const card = document.getElementById(`layer-node-${id}`)
  if (!card) throw new Error(`no card ${id}`)
  return card
}

const open = () => renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', draft: true, deferTrace: true })

describe('editing workflows on the canvas', () => {
  it('inserts a layer between two columns from a header menu — named, in place, staged', async () => {
    const h = await open()
    expect(columnIds()).toEqual(['warehouse', 'report'])

    await act(async () => { fireEvent.contextMenu(headerOf('warehouse')) })
    await h.settle()
    expect(screen.getByText('Insert layer to the left')).toBeInTheDocument()

    await act(async () => { fireEvent.click(screen.getByText('Insert layer to the right')) })
    await h.settle()

    const ids = columnIds()
    expect(ids).toHaveLength(3)
    expect(ids[0]).toBe('warehouse')
    expect(ids[2]).toBe('report')
    // Its name is open for editing at once.
    expect(screen.getByDisplayValue('New layer')).toBeInTheDocument()
    expect(useStagedChangesStore.getState().changes.some(
      (c) => c.type === 'layer_config' && /Inserted layer/.test(c.summary ?? ''),
    )).toBe(true)
  }, 30000)

  it('keeps a layer\'s settings in a panel of their own — opened from its menu, staged on Stage', async () => {
    const h = await open()
    await act(async () => { fireEvent.contextMenu(headerOf('warehouse')) })
    await h.settle()
    await act(async () => { fireEvent.click(screen.getByText('Layer settings…')) })
    await h.settle()
    fireEvent.change(screen.getByRole('textbox', { name: 'Layer description' }), { target: { value: 'Where the numbers are kept' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stage changes' })) })
    await h.settle()
    expect(useStagedChangesStore.getState().changes.some(
      (c) => c.type === 'layer_config' && /Edited layer/.test(c.summary ?? ''),
    )).toBe(true)
  }, 30000)

  it('in the Business view, the header\'s ⋯ opens the layer menu — New group among it', async () => {
    usePersonaStore.setState({ mode: 'business' })
    const h = await open()
    const more = headerOf('warehouse').querySelector<HTMLElement>('[aria-label$=": layer actions"]')!
    await act(async () => { fireEvent.click(more) })
    await h.settle()
    await act(async () => { fireEvent.click(screen.getByText('New group')) })
    await h.settle()
    expect(screen.getByRole('textbox', { name: /^Name the new group in/ })).toBeInTheDocument()
  }, 30000)

  it('the gutter "+" inserts a layer just before a column', async () => {
    const h = await open()
    const plus = screen.getByRole('button', { name: 'Insert a layer before Report' })
    await act(async () => { fireEvent.click(plus) })
    await h.settle()
    const ids = columnIds()
    expect(ids).toHaveLength(3)
    expect(ids[0]).toBe('warehouse')
    expect(ids[2]).toBe('report')
  }, 30000)

  it('the Connect tool: click a source, then a target — no dragging — and Escape backs out', async () => {
    const h = await open()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })) })
    await h.settle()
    expect(screen.getByText(/click the entity a link starts from/)).toBeInTheDocument()

    await act(async () => { fireEvent.click(cardBody('tableau')) })
    await h.settle()
    expect(screen.getByText(/Connecting from/)).toHaveTextContent('tableau')

    await act(async () => { fireEvent.click(cardBody('INTERMEDIATE_T2')) })
    await h.settle()
    // No relationship in this ontology fits: the picker opens and says so.
    expect(h.connectPickerOpen()).toBe(true)

    // A key press starts at the focused element and bubbles through document and window.
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await h.settle()
    expect(h.connectPickerOpen()).toBe(false)
  }, 30000)

  it('offers Duplicate… in an entity menu, and opens its dialog', async () => {
    const h = await open()
    await act(async () => { fireEvent.contextMenu(cardBody('tableau')) })
    await h.settle()
    await act(async () => { fireEvent.click(screen.getByText('Duplicate…')) })
    await h.settle()
    expect(screen.getByRole('dialog')).toHaveTextContent(/Duplicate/)
  }, 30000)
})
