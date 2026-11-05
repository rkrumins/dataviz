/**
 * Editing workflows on the REAL Context View canvas, in a draft:
 *
 *   • the layer menu — right-click a column header, insert a layer beside it;
 *     it lands between the two, with its name open for editing, staged;
 *   • the Connect tool — click where a link starts, then where it goes, with
 *     no dragging; Escape backs out a step at a time;
 *   • Duplicate… — offered in an entity's menu, opening its dialog;
 *   • a draft edited end to end in the Business view, from its own menus —
 *     up to Review & Save and Done (the harness has no graph to save to).
 */
import { act, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderCanvasWithTrace, type TraceCanvasHarness } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import { usePersonaStore } from '@/store/persona'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useHierarchyBuilderStore } from '@/components/canvas/create/hierarchyBuilderStore'

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

/** A type that holds others: its rows offer a "+" for a child. */
const container = {
  id: 'container', name: 'Container', visual: {}, properties: [], behavior: {},
  hierarchy: { level: 1, canContain: ['dataset'], canBeContainedBy: [] },
}

describe('a draft edited end to end in the Business view', () => {
  const openBusiness = () => renderCanvasWithTrace(cfoEstate(), {
    focus: 'cfo', draft: true, deferTrace: true, persona: 'business', entityTypes: [container],
  })
  const staged = () => useStagedChangesStore.getState().changes
  const builder = () => useHierarchyBuilderStore.getState()

  /** Open a layer's ⋯ (the Business header's one door to its actions) and pick `item`. */
  const fromLayerMenu = async (h: TraceCanvasHarness, layerId: string, item: string) => {
    await act(async () => { fireEvent.click(within(headerOf(layerId)).getByRole('button', { name: /: layer actions$/ })) })
    await h.settle()
    await act(async () => { fireEvent.click(screen.getByText(item)) })
    await h.settle()
  }
  const fromEntityMenu = async (h: TraceCanvasHarness, id: string, item: string) => {
    await act(async () => { fireEvent.contextMenu(cardBody(id)) })
    await h.settle()
    await act(async () => { fireEvent.click(screen.getByText(item)) })
    await h.settle()
  }

  beforeEach(() => {
    useStagedChangesStore.setState({ changes: [], redoStack: [], isReviewPanelOpen: false })
    useHierarchyBuilderStore.getState().close()
  })

  it('a layer\'s ⋯ adds an entity, or builds a lot at once, in the builder', async () => {
    const h = await openBusiness()
    await fromLayerMenu(h, 'warehouse', 'Add entity')
    expect(builder()).toMatchObject({ isOpen: true, layerId: 'warehouse', surface: 'rail' })

    act(() => builder().close())
    await h.settle()
    await fromLayerMenu(h, 'report', 'Build a lot at once')
    expect(builder()).toMatchObject({ isOpen: true, layerId: 'report', surface: 'build' })
  }, 30000)

  it('a layer\'s ⋯ opens its settings, staged on Stage', async () => {
    const h = await openBusiness()
    await fromLayerMenu(h, 'warehouse', 'Layer settings…')
    fireEvent.change(screen.getByRole('textbox', { name: 'Layer description' }), { target: { value: 'Where the numbers are kept' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stage changes' })) })
    await h.settle()
    expect(staged()).toEqual([expect.objectContaining({ type: 'layer_config', summary: 'Edited layer “Warehouse”' })])
  }, 30000)

  it('a layer\'s ⋯ deletes it, staged', async () => {
    const h = await openBusiness()
    await fromLayerMenu(h, 'warehouse', 'Delete layer')
    expect(columnIds()).toEqual(['report'])
    expect(staged()).toEqual([expect.objectContaining({ type: 'layer_config', summary: 'Deleted layer “Warehouse”' })])
  }, 30000)

  it('Create Entity Here, on a column\'s empty space, opens the builder in that layer', async () => {
    const h = await openBusiness()
    const empty = document.querySelector<HTMLElement>('[data-layer-id="report"].group\\/column .custom-scrollbar')!
    await act(async () => { fireEvent.contextMenu(empty) })
    await h.settle()
    await act(async () => { fireEvent.click(screen.getByText('Create Entity Here')) })
    await h.settle()
    expect(builder()).toMatchObject({ isOpen: true, layerId: 'report' })
  }, 30000)

  it('a row\'s "+" adds a child to it, in the builder', async () => {
    const h = await openBusiness()
    await act(async () => { fireEvent.click(within(cardBody('INTERMEDIATE_T2')).getByRole('button', { name: 'Add child entity' })) })
    await h.settle()
    expect(builder()).toMatchObject({ isOpen: true, parentUrn: 'INTERMEDIATE_T2' })
  }, 30000)

  it('keeps the header\'s Connect, and links from an entity\'s Connect To…', async () => {
    const h = await openBusiness()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })) })
    await h.settle()
    expect(screen.getByText(/click the entity a link starts from/)).toBeInTheDocument()

    await fromEntityMenu(h, 'tableau', 'Connect To…')
    expect(screen.getByText(/Connecting from/)).toHaveTextContent('tableau')
  }, 30000)

  it('View & Edit, then Edit, stages a business label', async () => {
    const h = await openBusiness()
    await fromEntityMenu(h, 'tableau', 'View & Edit')
    const drawer = document.querySelector<HTMLElement>('[data-panel="entity-drawer"]')!
    await act(async () => { fireEvent.mouseDown(within(drawer).getByRole('tab', { name: /^Edit/ })) })
    await h.settle()
    fireEvent.change(within(drawer).getByLabelText('Business label'), { target: { value: 'Dashboards' } })
    await act(async () => { fireEvent.click(within(drawer).getByRole('button', { name: /Stage changes/ })) })
    await h.settle()
    expect(staged()).toHaveLength(1)
    expect(staged()[0].after).toMatchObject({ label: 'tableau', businessLabel: 'Dashboards', properties: { businessLabel: 'Dashboards' } })
  }, 30000)

  it('a double-click renames the business label the row shows, not the name under it', async () => {
    const h = await openBusiness()
    act(() => useCanvasStore.getState().updateNode('tableau', { businessLabel: 'Dashboards', properties: { businessLabel: 'Dashboards' } }))
    await h.settle()
    await act(async () => { fireEvent.doubleClick(cardBody('tableau')) })
    await h.settle()
    const editor = screen.getByDisplayValue('Dashboards')
    fireEvent.change(editor, { target: { value: 'Reporting tools' } })
    await act(async () => { fireEvent.keyDown(editor, { key: 'Enter' }) })
    await h.settle()
    expect(staged()).toHaveLength(1)
    expect(staged()[0]).toMatchObject({
      type: 'update_entity',
      after: { label: 'tableau', businessLabel: 'Reporting tools', properties: { businessLabel: 'Reporting tools' } },
    })
  }, 30000)

  it('More → Select several picks two, and "Edit 2…" opens what they share', async () => {
    const h = await openBusiness()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'More tools' }))
    await user.click(await screen.findByRole('menuitem', { name: /Select several/ }))
    await h.settle()
    await act(async () => { fireEvent.click(cardBody('INTERMEDIATE_T2')) })
    await act(async () => { fireEvent.click(cardBody('REPORTING')) })
    await h.settle()
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['INTERMEDIATE_T2', 'REPORTING'])

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Edit 2…' })) })
    await h.settle()
    expect(screen.getByRole('heading', { name: '2 entities' })).toBeInTheDocument()
  }, 30000)

  it('Undo takes the last change back', async () => {
    const h = await openBusiness()
    await fromLayerMenu(h, 'warehouse', 'Delete layer')
    expect(columnIds()).toEqual(['report'])
    await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('[data-toolbar-item="undo"]')!) })
    await h.settle()
    expect(staged()).toEqual([])
    expect(columnIds()).toEqual(['warehouse', 'report'])
  }, 30000)

  it('Review & Save discards a change; Done keeps the draft open until nothing is pending', async () => {
    const h = await openBusiness()
    await fromLayerMenu(h, 'warehouse', 'Delete layer')
    await fromLayerMenu(h, 'report', 'Insert layer to the right')
    expect(staged()).toHaveLength(2)

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Review & Save/ })) })
    await h.settle()
    const review = () => screen.getByRole('dialog', { name: 'Review & Save Changes' })
    await act(async () => { fireEvent.click(within(review()).getAllByRole('button', { name: 'Discard change' })[0]) })
    await h.settle()
    expect(staged()).toHaveLength(1)
    await act(async () => { fireEvent.click(within(review()).getByRole('button', { name: 'Close' })) })
    await h.settle()

    // A change still pending: Done goes back to the review rather than leave it behind.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })) })
    await h.settle()
    expect(review()).toBeInTheDocument()
    expect(useBranchStore.getState().isDraftMode()).toBe(true)

    await act(async () => { fireEvent.click(within(review()).getByRole('button', { name: 'Discard change' })) })
    await h.settle()
    expect(staged()).toEqual([])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })) })
    await h.settle()
    expect(useBranchStore.getState().isDraftMode()).toBe(false)
  }, 30000)
})
