/**
 * Editing workflows on the REAL Context View canvas, in a draft:
 *
 *   • the layer menu — right-click a column header, insert a layer beside it;
 *     it lands between the two, with its name open for editing, staged;
 *   • the Connect tool — click where a link starts, then where it goes, with
 *     no dragging; Escape backs out a step at a time;
 *   • Duplicate… — offered in an entity's menu, opening its dialog;
 *   • a draft edited end to end in the Business view, from its own menus —
 *     up to Review & Save and Done (the harness has no graph to save to);
 *   • where each way of adding from a layer puts the new entity — inside the
 *     entity a column is mapped to, inside the selection, at the top level with
 *     the column's entities one click away, or "where?" for a type that needs a
 *     parent — and what the rail and Build say about it.
 */
import { act, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderCanvasWithTrace, type TraceCanvasHarness } from '@/test/canvasHarness'
import { anchoredEstate, cfoEstate } from '@/test/fixtures/traceEstates'
import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import { usePersonaStore } from '@/store/persona'
import { useSchemaStore } from '@/store/schema'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useHierarchyBuilderStore } from '@/components/canvas/create/hierarchyBuilderStore'
import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'
import type { ViewLayerConfig } from '@/types/schema'

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

  it('clicking an entity while adding steps the builder aside for its details; the pill brings it back', async () => {
    const h = await openBusiness()
    await fromLayerMenu(h, 'warehouse', 'Add entity')
    expect(screen.getByText('Add entities')).toBeInTheDocument()
    await act(async () => { fireEvent.click(cardBody('INTERMEDIATE_T2')) })
    await h.settle()
    expect(builder()).toMatchObject({ isOpen: true, suspended: true })
    expect(useCanvasStore.getState().drawerNodeId).toBe('INTERMEDIATE_T2')
    const pill = screen.getByRole('group', { name: 'Adding entities' })
    // It can hold children: adding inside it is one step.
    await act(async () => { fireEvent.click(within(pill).getByRole('button', { name: /^Add inside / })) })
    await h.settle()
    expect(builder().suspended).toBe(false)
    expect(screen.queryByRole('group', { name: 'Adding entities' })).not.toBeInTheDocument()
    expect(screen.getByText(/Adding inside/)).toHaveTextContent(/INTERMEDIATE_T2|Intermediate/i)
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
    // Leaving the field stages it — there is no separate Stage step.
    const label = within(drawer).getByLabelText('Business label')
    fireEvent.change(label, { target: { value: 'Dashboards' } })
    await act(async () => { fireEvent.blur(label) })
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

  it('More → Select several picks two, and "Compare & edit 2" opens what they share', async () => {
    const h = await openBusiness()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'More tools' }))
    await user.click(await screen.findByRole('menuitem', { name: /Select several/ }))
    await h.settle()
    await act(async () => { fireEvent.click(cardBody('INTERMEDIATE_T2')) })
    await act(async () => { fireEvent.click(cardBody('REPORTING')) })
    await h.settle()
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['INTERMEDIATE_T2', 'REPORTING'])

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Compare & edit 2' })) })
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
    await act(async () => { fireEvent.click(within(review()).getAllByRole('button', { name: /^Discard (the change to|\d+ changes to)/ })[0]) })
    await h.settle()
    expect(staged()).toHaveLength(1)
    await act(async () => { fireEvent.click(within(review()).getByRole('button', { name: 'Close' })) })
    await h.settle()

    // A change still pending: Done goes back to the review rather than leave it behind.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })) })
    await h.settle()
    expect(review()).toBeInTheDocument()
    expect(useBranchStore.getState().isDraftMode()).toBe(true)

    await act(async () => { fireEvent.click(within(review()).getByRole('button', { name: /^Discard (the change to|\d+ changes to)/ })) })
    await h.settle()
    expect(staged()).toEqual([])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Done' })) })
    await h.settle()
    expect(useBranchStore.getState().isDraftMode()).toBe(false)
  }, 30000)
})

// ─── Where a layer's ways of adding put a new entity ─────────────────────────

const ontologyType = (id: string, name: string, canContain: string[], canBeContainedBy: string[], level: number) => ({
  id, name, pluralName: `${name}s`, visual: {}, properties: [], fields: [], behavior: {},
  hierarchy: { level, canContain, canBeContainedBy, defaultExpanded: false, rollUpFields: [] },
})
/** The harness seeds no relationship types: one containment relationship, so things can nest. */
const allowNesting = () => act(() => {
  useSchemaStore.setState((s) => ({
    schema: { ...s.schema!, relationshipTypes: [{
      id: 'CONTAINS', name: 'Contains', sourceTypes: [], targetTypes: [], isContainment: true,
      visual: { strokeColor: '#94a3b8', strokeWidth: 1, strokeStyle: 'solid', animated: false, curveType: 'bezier' },
    }] },
  }) as never)
})

/**
 *   Domains (a column of the domain type): Finance ⊃ Billing, Sales, Ops
 *   Apps    (a column of the app type, which needs a domain)
 */
function domainsEstate() {
  const n = (urn: string, type: string, childCount = 0) => ({
    id: urn, type: 'default', position: { x: 0, y: 0 },
    data: { urn, label: urn, type, childCount }, urn, displayName: urn, entityType: type,
  }) as unknown as LensWalkNode
  const model: LensWalkModel = {
    focusUrn: 'Finance', nodes: [n('Finance', 'domain', 1), n('Sales', 'domain'), n('Ops', 'domain'), n('Billing', 'app')],
    lineageEdges: [], containmentEdges: [{ sourceUrn: 'Finance', targetUrn: 'Billing' }],
    upstreamUrns: new Set(), downstreamUrns: new Set(), frontierUp: [], frontierDown: [],
    truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
  }
  const layers: ViewLayerConfig[] = [
    { id: 'domains', name: 'Domains', order: 0, entityTypes: ['domain'] },
    { id: 'apps', name: 'Apps', order: 1, entityTypes: ['app'] },
  ]
  const assignments = { Finance: { layerId: 'domains' }, Sales: { layerId: 'domains' }, Ops: { layerId: 'domains' } }
  return { model, layers, assignments }
}

describe('where a layer\'s ways of adding put a new entity', () => {
  const builder = () => useHierarchyBuilderStore.getState()
  const scope = () => screen.getByTestId('builder-scope')
  const staged = () => useStagedChangesStore.getState().changes
  const createdAfter = () => staged().filter((c) => c.type === 'create_entity')
    .map((c) => c.after as { entityType?: string; parentUrn?: string; displayName?: string })

  const openAnchored = async (persona?: 'business') => {
    const h = await renderCanvasWithTrace(anchoredEstate(), {
      focus: 'SRC.orders', draft: true, deferTrace: true, persona,
      entityTypes: [
        ontologyType('dataPlatform', 'Data Platform', ['dataset'], [], 0),
        ontologyType('dataset', 'Dataset', [], ['dataPlatform'], 1),
      ],
    })
    allowNesting()
    await h.settle()
    return h
  }
  const openDomains = async (persona?: 'business') => {
    const h = await renderCanvasWithTrace(domainsEstate(), {
      focus: 'Finance', draft: true, deferTrace: true, persona,
      entityTypes: [
        ontologyType('domain', 'Domain', ['app'], [], 0),
        ontologyType('app', 'App', [], ['domain'], 1),
      ],
    })
    allowNesting()
    await h.settle()
    return h
  }
  const click = async (h: TraceCanvasHarness, el: HTMLElement) => {
    await act(async () => { fireEvent.click(el) })
    await h.settle()
  }
  const addNamed = async (h: TraceCanvasHarness, name: string) => {
    const input = screen.getByPlaceholderText('Enter display name...')
    await act(async () => { fireEvent.change(input, { target: { value: name } }) })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    await h.settle()
  }

  beforeEach(() => {
    useStagedChangesStore.setState({ changes: [], redoStack: [], isReviewPanelOpen: false })
    useHierarchyBuilderStore.getState().close()
    useHierarchyBuilderStore.setState({ lastTypeIn: {} })
  })

  it('a column mapped to an entity: its "+" adds inside it, as what it holds, and the rail says so', async () => {
    const h = await openAnchored()
    await click(h, within(headerOf('src')).getByRole('button', { name: 'Add inside SRC' }))
    expect(builder()).toMatchObject({ isOpen: true, surface: 'rail', layerId: 'src', parentUrn: 'SRC', initialTypeId: 'dataset', askParent: false })
    expect(builder().choices.map((c) => c.urn)).toEqual(['SRC'])
    expect(scope()).toHaveTextContent('Adding inside SRC · Data Platform')

    await addNamed(h, 'events')
    expect(createdAfter()).toEqual([expect.objectContaining({ displayName: 'events', entityType: 'dataset', parentUrn: 'SRC' })])
    // A child follows its parent's column: nothing is pinned for it.
    expect(staged().some((c) => c.type === 'layer_config')).toBe(false)

    // One click to a new top-level entity instead.
    await click(h, within(scope()).getByRole('button', { name: 'Change' }))
    await click(h, screen.getByRole('option', { name: /New top-level Data Platform/ }))
    expect(scope()).toHaveTextContent('Adding at the top level')
    // …and the column's own entity is one click back.
    await click(h, within(screen.getByRole('group', { name: 'Or add inside' })).getByRole('button', { name: /SRC/ }))
    expect(scope()).toHaveTextContent('Adding inside SRC')
  }, 30000)

  it('a column mapped to an entity: Build, its menu, its empty space and N add inside it too', async () => {
    const h = await openAnchored()
    await click(h, within(headerOf('src')).getByRole('button', { name: 'Build a lot at once in Source' }))
    expect(builder()).toMatchObject({ isOpen: true, surface: 'build', parentUrn: 'SRC', layerId: 'src' })
    expect(screen.getByTestId('build-scope')).toHaveTextContent('Adding inside SRC · Data Platform')
    act(() => builder().close())
    await h.settle()

    await act(async () => { fireEvent.contextMenu(headerOf('dst')) })
    await h.settle()
    await click(h, screen.getByText('Add inside DST'))
    expect(builder()).toMatchObject({ isOpen: true, parentUrn: 'DST', layerId: 'dst' })
    act(() => builder().close())
    await h.settle()

    const empty = document.querySelector<HTMLElement>('[data-layer-id="dst"].group\\/column .custom-scrollbar')!
    await act(async () => { fireEvent.contextMenu(empty) })
    await h.settle()
    await click(h, screen.getByText('Add inside DST'))
    expect(builder()).toMatchObject({ isOpen: true, parentUrn: 'DST', layerId: 'dst' })
    act(() => builder().close())
    await h.settle()

    // N, with something in the column selected: inside the column's entity.
    act(() => useCanvasStore.getState().setSelection(['SRC.customers']))
    await act(async () => { fireEvent.keyDown(document, { key: 'n' }) })
    await h.settle()
    expect(builder()).toMatchObject({ isOpen: true, parentUrn: 'SRC', layerId: 'src' })
  }, 30000)

  it('asked where a type goes, the columns\' own entities are among the parents offered, by name', async () => {
    const h = await openAnchored()
    await act(async () => { fireEvent.keyDown(document, { key: 'p', metaKey: true, shiftKey: true }) })
    await h.settle()
    await click(h, screen.getByText('Create Dataset'))
    expect(builder()).toMatchObject({ isOpen: true, parentUrn: null, initialTypeId: 'dataset', askParent: true })
    // Neither is drawn as a row — each IS its column — yet both can hold a dataset.
    expect(builder().choices.map((c) => c.urn)).toEqual(['DST', 'SRC'])
  }, 30000)

  it('a column of several top-level entities adds at the top level, as before — inside one of them one click away', async () => {
    const h = await openDomains()
    await click(h, within(headerOf('domains')).getByRole('button', { name: 'Add entity to Domains' }))
    expect(builder()).toMatchObject({ isOpen: true, parentUrn: null, initialTypeId: 'domain', askParent: false, topLevelTypeId: 'domain' })
    expect(scope()).toHaveTextContent('Adding at the top level')
    const quick = screen.getByRole('group', { name: 'Or add inside' })
    expect(within(quick).getAllByRole('button').map((b) => b.textContent)).toEqual(['Finance', 'Ops', 'Sales'])

    await click(h, within(quick).getByRole('button', { name: /Sales/ }))
    expect(scope()).toHaveTextContent('Adding inside Sales')
    await addNamed(h, 'Payroll')
    expect(createdAfter()).toEqual([expect.objectContaining({ entityType: 'app', parentUrn: 'Sales' })])
  }, 30000)

  it('with one of a column\'s entities selected, its "+" (and N) adds inside it', async () => {
    const h = await openDomains()
    act(() => useCanvasStore.getState().setSelection(['Ops']))
    await click(h, within(headerOf('domains')).getByRole('button', { name: 'Add entity to Domains' }))
    expect(builder()).toMatchObject({ parentUrn: 'Ops', layerId: 'domains' })
    expect(scope()).toHaveTextContent('Adding inside Ops')
    act(() => builder().close())
    await h.settle()

    act(() => useCanvasStore.getState().setSelection(['Sales']))
    await act(async () => { fireEvent.keyDown(document, { key: 'n' }) })
    await h.settle()
    expect(builder()).toMatchObject({ isOpen: true, parentUrn: 'Sales', layerId: 'domains' })

    // Nothing selected, N opens at the top level as it always did.
    act(() => builder().close())
    act(() => useCanvasStore.getState().setSelection([]))
    await act(async () => { fireEvent.keyDown(document, { key: 'n' }) })
    await h.settle()
    expect(builder()).toMatchObject({ isOpen: true, parentUrn: null, layerId: null })
  }, 30000)

  it('a column whose type needs a parent asks where first — and adds that type there', async () => {
    const h = await openDomains()
    await click(h, within(headerOf('apps')).getByRole('button', { name: 'Add entity to Apps' }))
    expect(builder()).toMatchObject({ isOpen: true, parentUrn: null, initialTypeId: 'app', askParent: true })
    expect(scope()).toHaveTextContent('Choose a parent for an App')
    const picker = screen.getByRole('listbox', { name: 'Where to add' })
    expect(picker).toHaveTextContent('Can hold an App')
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Finance/), expect.stringMatching(/^Sales/), expect.stringMatching(/^Ops/)]))
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()

    await click(h, within(picker).getByRole('option', { name: /^Finance/ }))
    expect(scope()).toHaveTextContent('Adding inside Finance')
    await addNamed(h, 'Ledger')
    expect(createdAfter()).toEqual([expect.objectContaining({ displayName: 'Ledger', entityType: 'app', parentUrn: 'Finance' })])
  }, 30000)

  it('the palette\'s Create App: inside the selection when it can hold one, else it asks', async () => {
    const h = await openDomains()
    const createApp = async () => {
      await act(async () => { fireEvent.keyDown(document, { key: 'p', metaKey: true, shiftKey: true }) })
      await h.settle()
      await click(h, screen.getByText('Create App'))
    }
    act(() => useCanvasStore.getState().setSelection(['Ops']))
    await createApp()
    expect(builder()).toMatchObject({ isOpen: true, parentUrn: 'Ops', initialTypeId: 'app', askParent: false })
    act(() => builder().close())
    await h.settle()

    act(() => useCanvasStore.getState().setSelection([]))
    await createApp()
    expect(builder()).toMatchObject({ isOpen: true, parentUrn: null, initialTypeId: 'app', askParent: true })
  }, 30000)

  it('in the Business view it asks in plain words, from the layer\'s ⋯', async () => {
    const h = await openDomains('business')
    await act(async () => { fireEvent.click(within(headerOf('apps')).getByRole('button', { name: /: layer actions$/ })) })
    await h.settle()
    await click(h, screen.getByText('Add entity'))
    expect(scope()).toHaveTextContent('Where does an App go?')
  }, 30000)
})
