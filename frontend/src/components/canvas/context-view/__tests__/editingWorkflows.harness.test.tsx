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
import { act, createEvent, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderCanvasWithTrace, type TraceCanvasHarness } from '@/test/canvasHarness'
import { anchoredEstate, cfoEstate, movesEstate } from '@/test/fixtures/traceEstates'
import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import { usePersonaStore } from '@/store/persona'
import { useSchemaStore } from '@/store/schema'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useFeaturesStore } from '@/store/features'
import { useNotificationStore } from '@/components/ui/notifications'
import { useHierarchyBuilderStore } from '@/components/canvas/create/hierarchyBuilderStore'
import { useBuildRowsStore } from '@/components/canvas/create/buildmode/buildRowsStore'
import { makeRow } from '@/components/canvas/create/buildmode/buildRow'
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
  /** The entity just added: inside `parent` by exactly ONE containment link, drawn in `column`. */
  const landed = (name: string, parent: string, column: string) => {
    const c = staged().find((x) => x.type === 'create_entity' && (x.after as { displayName?: string }).displayName === name)
    if (!c) throw new Error(`nothing named ${name} was added`)
    const temp = c.targetUrn!
    const links = useCanvasStore.getState().edges.filter((e) => e.target === temp && e.type === 'containment')
    expect(links.map((e) => e.source)).toEqual([parent])
    expect(document.getElementById(`layer-node-${temp}`)?.closest<HTMLElement>('[data-layer-id].group\\/column')?.dataset.layerId).toBe(column)
  }
  /** Build's grid, given rows (its grid is a keyboard surface of its own), then Apply. */
  const buildRows = async (h: TraceCanvasHarness, rows: Array<{ id: string; name: string; typeId: string }>) => {
    act(() => useBuildRowsStore.getState().setRows(rows.map((r) => makeRow(r))))
    await h.settle()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Apply' })) })
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
    landed('events', 'SRC', 'src')
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
    await buildRows(h, [{ id: 'b1', name: 'payments', typeId: 'dataset' }])
    landed('payments', 'SRC', 'src')
    act(() => builder().close())
    await h.settle()

    await act(async () => { fireEvent.contextMenu(headerOf('dst')) })
    await h.settle()
    await click(h, screen.getByText('Add inside DST'))
    expect(builder()).toMatchObject({ isOpen: true, parentUrn: 'DST', layerId: 'dst' })
    await addNamed(h, 'margin')
    landed('margin', 'DST', 'dst')
    act(() => builder().close())
    await h.settle()

    const empty = document.querySelector<HTMLElement>('[data-layer-id="dst"].group\\/column .custom-scrollbar')!
    await act(async () => { fireEvent.contextMenu(empty) })
    await h.settle()
    await click(h, screen.getByText('Add inside DST'))
    expect(builder()).toMatchObject({ isOpen: true, parentUrn: 'DST', layerId: 'dst' })
    await addNamed(h, 'churn')
    landed('churn', 'DST', 'dst')
    act(() => builder().close())
    await h.settle()

    // N, with something in the column selected: inside the column's entity.
    act(() => useCanvasStore.getState().setSelection(['SRC.customers']))
    await act(async () => { fireEvent.keyDown(document, { key: 'n' }) })
    await h.settle()
    expect(builder()).toMatchObject({ isOpen: true, parentUrn: 'SRC', layerId: 'src' })
    await addNamed(h, 'refunds')
    landed('refunds', 'SRC', 'src')
  }, 30000)

  it('asked where a type goes, the columns\' own entities are among the parents offered, by name', async () => {
    const h = await openAnchored()
    await act(async () => { fireEvent.keyDown(document, { key: 'p', metaKey: true, shiftKey: true }) })
    await h.settle()
    await click(h, screen.getByText('Create Dataset'))
    expect(builder()).toMatchObject({ isOpen: true, parentUrn: null, initialTypeId: 'dataset', askParent: true })
    // Neither is drawn as a row — each IS its column — yet both can hold a dataset.
    expect(builder().choices.map((c) => c.urn)).toEqual(['DST', 'SRC'])
    await click(h, within(screen.getByRole('listbox', { name: 'Where to add' })).getByRole('option', { name: /^DST/ }))
    await addNamed(h, 'forecast')
    landed('forecast', 'DST', 'dst')
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
    landed('Payroll', 'Sales', 'domains')
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
    await addNamed(h, 'Pipeline')
    landed('Pipeline', 'Sales', 'domains')

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
    landed('Ledger', 'Finance', 'apps')
  }, 30000)

  it('an App added from the Apps column lands in the Apps column, though its parent is in Domains', async () => {
    const h = await openDomains()
    await click(h, within(headerOf('apps')).getByRole('button', { name: 'Add entity to Apps' }))
    await click(h, within(screen.getByRole('listbox', { name: 'Where to add' })).getByRole('option', { name: /^Sales/ }))
    await addNamed(h, 'Quotes')
    expect(createdAfter()).toEqual([expect.objectContaining({ displayName: 'Quotes', entityType: 'app', parentUrn: 'Sales' })])
    // The view is curated: left to containment, the App would follow Sales into Domains.
    const column = (id: string) => document.querySelector<HTMLElement>(`[data-layer-id="${id}"]`)!
    expect(within(column('apps')).getByText('Quotes')).toBeTruthy()
    expect(within(column('domains')).queryByText('Quotes')).toBeNull()
  }, 30000)

  it('an App added with a Domain\'s row "+" stays under its Domain, as before', async () => {
    const h = await openDomains()
    await click(h, within(cardBody('Sales')).getByRole('button', { name: 'Add child entity' }))
    await addNamed(h, 'Forecast')
    landed('Forecast', 'Sales', 'domains')
    const column = (id: string) => document.querySelector<HTMLElement>(`[data-layer-id="${id}"]`)!
    expect(within(column('domains')).getByText('Forecast')).toBeTruthy()
    expect(within(column('apps')).queryByText('Forecast')).toBeNull()
  }, 30000)

  it('an entity\'s Add Child Entity adds inside it, in its column', async () => {
    const h = await openDomains()
    await act(async () => { fireEvent.contextMenu(cardBody('Ops')) })
    await h.settle()
    await click(h, screen.getByText('Add Child Entity'))
    expect(builder()).toMatchObject({ isOpen: true, parentUrn: 'Ops' })
    await addNamed(h, 'Rostering')
    landed('Rostering', 'Ops', 'domains')
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
    await addNamed(h, 'Rota')
    landed('Rota', 'Ops', 'domains')
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

// ─── Moving an entity (a data change) — and arranging the view (a view change) ─

describe('moving an entity: a data change, said as one — and the view\'s own arranging', () => {
  const staged = () => useStagedChangesStore.getState().changes
  const moves = () => staged().filter((c) => c.type === 'move_entity')
  const links = (child: string) => useCanvasStore.getState().edges.filter((e) =>
    e.target === child && String(e.data?.edgeType ?? '').toUpperCase() === 'CONTAINS')
  const count = (id: string) => useCanvasStore.getState().nodes.find((n) => n.id === id)?.data?.childCount
  const columnOfCard = (id: string) =>
    document.getElementById(`layer-node-${id}`)?.closest<HTMLElement>('[data-layer-id].group\\/column')?.dataset.layerId
  const bodyOf = (layerId: string) =>
    document.querySelector<HTMLElement>(`[data-layer-id="${layerId}"].group\\/column .custom-scrollbar`)!
  const notices = () => useNotificationStore.getState().notifications.map((n) => n.message)
  const LINEAGE = [
    { id: 'l:leads>invoices', source: 'leads', target: 'invoices', type: 'lineage', data: { edgeType: 'TRANSFORMS' } },
    { id: 'l:journal>invoices', source: 'journal', target: 'invoices', type: 'lineage', data: { edgeType: 'TRANSFORMS' } },
  ] as never[]

  /** A row drag, as the browser gives it: what is carried is readable only on the drop. */
  const carrying = (id: string) => ({
    types: ['text/x-entity-id', 'text/x-entity-name'],
    getData: (k: string) => (k === 'text/x-entity-id' || k === 'text/x-entity-name' ? id : ''),
    setData: () => {}, setDragImage: () => {}, dropEffect: 'move', effectAllowed: 'move',
  })
  /** Pick up `id`'s row and hold it over `target` (clientY 20 of a 40px row: its middle band). */
  const dragOver = async (h: TraceCanvasHarness, id: string, target: HTMLElement) => {
    const dataTransfer = carrying(id)
    await act(async () => { fireEvent.dragStart(cardBody(id), { dataTransfer }) })
    await act(async () => { fireEvent.dragOver(target, { dataTransfer, clientY: 20 }) })
    await h.settle()
  }
  const dropOn = async (h: TraceCanvasHarness, id: string, target: HTMLElement) => {
    await act(async () => { fireEvent.drop(target, { dataTransfer: carrying(id), clientY: 20 }) })
    await act(async () => { if (document.getElementById(`layer-node-${id}`)) fireEvent.dragEnd(cardBody(id)) })
    await h.settle()
  }
  /** A drag event at a height on a 40px row — jsdom has no DragEvent, so the event is given the
   *  pointer's height itself (an edge band is the top or bottom 30%). */
  const at = (kind: 'dragOver' | 'drop', target: HTMLElement, id: string, clientY: number) => {
    const ev = createEvent[kind](target, { dataTransfer: carrying(id) })
    Object.defineProperty(ev, 'clientY', { value: clientY })
    fireEvent(target, ev)
  }
  /** Open a row (in a draft its first button is the connect handle, so not `h.toggle`). */
  const expand = async (h: TraceCanvasHarness, id: string) => {
    const chevron = cardBody(id).querySelector('svg.lucide-chevron-right')?.closest('button')
    if (!chevron) throw new Error(`no chevron on ${id}`)
    await act(async () => { fireEvent.click(chevron) })
    await h.settle()
  }
  const hint = (within: ParentNode = document) => {
    const el = within.querySelector<HTMLElement>('[data-drop-hint]')
    return el ? { kind: el.dataset.dropHint, text: el.textContent } : null
  }

  const openMoves = async (opts: { persona?: 'business'; rootApps?: boolean } = {}) => {
    const h = await renderCanvasWithTrace(movesEstate(), {
      focus: 'CRM', draft: true, deferTrace: true, persona: opts.persona,
      entityTypes: [
        ontologyType('domain', 'Domain', ['app'], [], 0),
        ontologyType('app', 'App', ['dataset'], ['domain'], 1),
        ontologyType('dataset', 'Dataset', [], ['app'], 2),
      ],
    })
    allowNesting()
    if (opts.rootApps) {
      act(() => useSchemaStore.setState((s) => ({ schema: { ...s.schema!, rootEntityTypes: ['domain', 'app'] } }) as never))
    }
    act(() => useCanvasStore.getState().addEdges(LINEAGE))
    await h.settle()
    return h
  }

  beforeEach(() => {
    useStagedChangesStore.setState({ changes: [], redoStack: [], past: [], isReviewPanelOpen: false })
    useNotificationStore.setState({ notifications: [] })
    useHierarchyBuilderStore.getState().close()
  })

  it('A — dropped on the body of the column mapped to Finance: one move inside Finance, subtree and lineage intact', async () => {
    const h = await openMoves()
    await expand(h, 'Sales')
    expect(columnOfCard('CRM')).toBe('domains')

    await dragOver(h, 'CRM', bodyOf('fin'))
    expect(document.querySelector('[data-body-drop]')?.getAttribute('data-body-drop')).toBe('data')
    expect(hint()).toEqual({ kind: 'data', text: 'Move inside Finance·changes the data' })
    await dropOn(h, 'CRM', bodyOf('fin'))

    expect(moves()).toHaveLength(1)
    expect(staged()).toHaveLength(1)
    expect(moves()[0].after).toMatchObject({ childId: 'CRM', parentId: 'Finance', edgeType: 'CONTAINS' })
    expect((moves()[0].before as { removedLinks: Array<{ id: string }> }).removedLinks.map((e) => e.id)).toEqual(['c:Sales>CRM'])
    expect(links('CRM').map((e) => [e.source, e.data?.isPending])).toEqual([['Finance', 'create']])
    // Its subtree follows; its lineage is untouched.
    expect(links('leads').map((e) => e.id)).toEqual(['c:CRM>leads'])
    expect(useCanvasStore.getState().edges.some((e) => e.id === 'l:leads>invoices')).toBe(true)
    // Drawn where its new parent is: a row of the column mapped to Finance — which stays a column,
    // counting the child it gained and the one Sales lost.
    expect(columnOfCard('CRM')).toBe('fin')
    expect([count('Finance'), count('Sales')]).toEqual([3, 1])
    expect(within(bodyOf('fin')).queryByText(/^Load /)).toBeNull()
  }, 30000)

  it('A — dropped on a row of the mapped column that cannot hold it: it goes inside the column\'s entity', async () => {
    const h = await openMoves()
    await expand(h, 'Sales')
    // An App holds Datasets, not Apps — but the column it sits in IS Finance, which holds Apps.
    await act(async () => { fireEvent.dragStart(cardBody('CRM'), { dataTransfer: carrying('CRM') }) })
    for (const clientY of [2, 20, 38]) {
      await act(async () => { at('dragOver', cardBody('Billing'), 'CRM', clientY) })
      await h.settle()
      expect(hint(), `at y ${clientY}`).toEqual({ kind: 'data', text: 'Move inside Finance·changes the data' })
      await act(async () => { fireEvent.dragLeave(cardBody('Billing')) })
    }
    await act(async () => { at('drop', cardBody('Billing'), 'CRM', 38) })
    await act(async () => { fireEvent.dragEnd(cardBody('CRM')) })
    await h.settle()

    expect(moves().map((c) => c.after)).toEqual([expect.objectContaining({ childId: 'CRM', parentId: 'Finance' })])
    expect(columnOfCard('CRM')).toBe('fin')
  }, 30000)

  it('B — a row from another set gets no reorder band at a row\'s edge: the drop there is the move it says', async () => {
    const h = await openMoves()
    await expand(h, 'Sales')
    // CRM is Sales's; Marketing is a root of Domains — not CRM's siblings, so nothing to reorder.
    await act(async () => { fireEvent.dragStart(cardBody('CRM'), { dataTransfer: carrying('CRM') }) })
    await act(async () => { at('dragOver', cardBody('Marketing'), 'CRM', 2) })
    await h.settle()
    expect(hint()).toEqual({ kind: 'data', text: 'Move inside Marketing·changes the data' })
    await act(async () => { at('drop', cardBody('Marketing'), 'CRM', 2) })
    await act(async () => { fireEvent.dragEnd(cardBody('CRM')) })
    await h.settle()
    expect(moves().map((c) => c.after)).toEqual([expect.objectContaining({ childId: 'CRM', parentId: 'Marketing' })])

    // Its siblings still arrange at the edge — a view change, no move.
    useStagedChangesStore.setState({ changes: [], redoStack: [], past: [] })
    await act(async () => { fireEvent.dragStart(cardBody('Sales'), { dataTransfer: carrying('Sales') }) })
    await act(async () => { at('dragOver', cardBody('Marketing'), 'Sales', 2) })
    await h.settle()
    expect(hint()).toEqual({ kind: 'view', text: 'Before Marketing·only this view' })
    await act(async () => { at('drop', cardBody('Marketing'), 'Sales', 2) })
    await act(async () => { fireEvent.dragEnd(cardBody('Sales')) })
    await h.settle()
    expect(moves()).toHaveLength(0)
  }, 30000)

  it('A — the only child moved out of a mapped column: it stays a column, with no page left to load', async () => {
    const h = await renderCanvasWithTrace(anchoredEstate(), {
      focus: 'SRC.orders', draft: true, deferTrace: true,
      entityTypes: [
        ontologyType('dataPlatform', 'Data Platform', ['dataset'], [], 0),
        ontologyType('dataset', 'Dataset', [], ['dataPlatform'], 1),
      ],
    })
    allowNesting()
    await h.settle()
    expect(columnOfCard('DST.revenue')).toBe('dst')
    await dragOver(h, 'DST.revenue', bodyOf('src'))
    expect(hint()).toEqual({ kind: 'data', text: 'Move inside SRC·changes the data' })
    await dropOn(h, 'DST.revenue', bodyOf('src'))
    expect(moves().map((c) => c.after)).toEqual([expect.objectContaining({ childId: 'DST.revenue', parentId: 'SRC' })])
    expect(columnOfCard('DST.revenue')).toBe('src')
    expect(count('DST')).toBe(0)
    expect(document.getElementById('layer-node-DST')).toBeNull()     // still the column, not a row
    expect(within(bodyOf('dst')).queryByText(/^Load /)).toBeNull()
  }, 30000)

  it('A — a row moved out of the mapped column leaves no phantom page behind it', async () => {
    const h = await openMoves()
    await dragOver(h, 'Billing', cardBody('Sales'))
    await dropOn(h, 'Billing', cardBody('Sales'))
    expect(moves().map((c) => c.after)).toEqual([expect.objectContaining({ childId: 'Billing', parentId: 'Sales' })])
    expect(columnOfCard('Billing')).toBe('domains')
    expect(count('Finance')).toBe(1)
    expect(within(bodyOf('fin')).queryByText(/^Load /)).toBeNull()
  }, 30000)

  it('B — a row dropped on another row: one move inside it, its new parent opened to show it', async () => {
    const h = await openMoves()
    await expand(h, 'Sales')
    await dragOver(h, 'CRM', cardBody('Marketing'))
    expect(hint()).toEqual({ kind: 'data', text: 'Move inside Marketing·changes the data' })
    await dropOn(h, 'CRM', cardBody('Marketing'))

    expect(moves().map((c) => c.after)).toEqual([expect.objectContaining({ childId: 'CRM', parentId: 'Marketing' })])
    expect(links('CRM').map((e) => e.source)).toEqual(['Marketing'])
    expect(links('leads').map((e) => e.source)).toEqual(['CRM'])
    // Marketing was closed: it opens, so the moved App is in sight under it.
    expect(columnOfCard('CRM')).toBe('domains')
    expect([count('Sales'), count('Marketing')]).toEqual([1, 2])
  }, 30000)

  it('B — an App placed by hand in the Apps column stays there when it moves to another Domain', async () => {
    const h = await openMoves()
    expect(columnOfCard('Quotes')).toBe('apps')
    await dragOver(h, 'Quotes', cardBody('Marketing'))
    await dropOn(h, 'Quotes', cardBody('Marketing'))
    expect(moves().map((c) => c.after)).toEqual([expect.objectContaining({ childId: 'Quotes', parentId: 'Marketing' })])
    expect(columnOfCard('Quotes')).toBe('apps')
    expect(notices()).toContain('Moved under Marketing. It stays in Apps, the column that holds its type.')
  }, 30000)

  it('onto its own parent while placed elsewhere: back under it — only this view', async () => {
    const h = await openMoves()
    await dragOver(h, 'Quotes', cardBody('Sales'))
    expect(hint()).toEqual({ kind: 'view', text: 'Back under Sales·only this view' })
    await dropOn(h, 'Quotes', cardBody('Sales'))
    expect(moves()).toHaveLength(0)
    expect(staged().map((c) => c.type)).toEqual(['assign_layer'])
    expect(links('Quotes').map((e) => e.id)).toEqual(['c:Sales>Quotes'])
  }, 30000)

  it('the header only arranges the view: "Show in this column · only this view", and no data changes', async () => {
    const h = await openMoves()
    await expand(h, 'Sales')
    await dragOver(h, 'CRM', headerOf('apps'))
    expect(hint()).toEqual({ kind: 'view', text: 'Show in this column·only this view' })
    expect(headerOf('apps').style.outline).toMatch(/dashed/)
    await dropOn(h, 'CRM', headerOf('apps'))
    expect(staged().map((c) => c.type)).toEqual(['assign_layer'])
    expect(links('CRM').map((e) => e.id)).toEqual(['c:Sales>CRM'])
    expect(columnOfCard('CRM')).toBe('apps')
  }, 30000)

  it('the Business view names the entity as it reads there', async () => {
    const h = await openMoves({ persona: 'business' })
    act(() => useCanvasStore.getState().updateNode('Finance', { businessLabel: 'Money', properties: { businessLabel: 'Money' } }))
    await expand(h, 'Sales')
    await dragOver(h, 'CRM', bodyOf('fin'))
    expect(hint()).toEqual({ kind: 'data', text: 'Move inside Money·changes the data' })
  }, 30000)

  it('refuses where the canvas refuses edits — and says why: in a trace', async () => {
    const h = await openMoves()
    await h.startTrace('CRM')
    await dropOn(h, 'CRM', bodyOf('fin'))
    expect(staged()).toHaveLength(0)
    expect(notices()).toContain('A trace is read-only — leave it to move an entity to a different parent.')
  }, 30000)

  it('refuses where the canvas refuses edits — and says why: with editing off', async () => {
    const h = await openMoves()
    act(() => useFeaturesStore.setState((s) => ({ values: { ...s.values, editModeEnabled: false } }) as never))
    await h.settle()
    await expand(h, 'Sales')
    await dragOver(h, 'CRM', cardBody('Marketing'))
    expect(hint()).toEqual({ kind: 'blocked', text: 'Editing is turned off' })
    await dropOn(h, 'CRM', cardBody('Marketing'))
    expect(staged()).toHaveLength(0)
    expect(notices()).toContain('Editing is turned off for this workspace, so entities can’t be moved. An administrator can turn it back on.')
  }, 30000)

  it('the drawer\'s "Choose a new parent…" offers what this view draws, and moves there', async () => {
    const h = await openMoves()
    // Loaded, but this curated view places it nowhere: not offered.
    act(() => useCanvasStore.getState().addNodes([{ id: 'Elsewhere', type: 'generic', position: { x: 0, y: 0 }, data: { label: 'Elsewhere', urn: 'Elsewhere', type: 'domain' } }]))
    await h.openDrawer('Billing')
    const drawer = document.querySelector<HTMLElement>('[data-panel="entity-drawer"]')!
    await act(async () => { fireEvent.mouseDown(within(drawer).getByRole('tab', { name: /^Edit/ })) })
    await h.settle()
    await act(async () => { fireEvent.click(within(drawer).getByRole('button', { name: 'Choose a new parent…' })) })
    await h.settle()
    const options = within(drawer).getByRole('listbox', { name: 'Possible parents' })
    expect(within(options).getAllByRole('option').map((o) => o.textContent)).toEqual(['Marketingdomain', 'Salesdomain'])
    await act(async () => { fireEvent.mouseDown(within(options).getByRole('option', { name: /Sales/ })) })
    await h.settle()
    expect(moves().map((c) => c.after)).toEqual([expect.objectContaining({ childId: 'Billing', parentId: 'Sales' })])
    expect(links('Billing').map((e) => e.source)).toEqual(['Sales'])
    expect(links('invoices').map((e) => e.source)).toEqual(['Billing'])
    expect(columnOfCard('Billing')).toBe('domains')   // Sales opened to show it
  }, 30000)

  it('to the top level, where the ontology lets an App stand alone: shown in the Apps column', async () => {
    const h = await openMoves({ rootApps: true })
    await h.openDrawer('Billing')
    const drawer = document.querySelector<HTMLElement>('[data-panel="entity-drawer"]')!
    await act(async () => { fireEvent.mouseDown(within(drawer).getByRole('tab', { name: /^Edit/ })) })
    await h.settle()
    await act(async () => { fireEvent.click(within(drawer).getByRole('button', { name: 'Choose a new parent…' })) })
    await h.settle()
    const top = within(drawer).getByRole('option', { name: /On its own, at the top/ })
    await act(async () => { fireEvent.mouseDown(top) })
    await h.settle()
    expect(moves().map((c) => c.after)).toEqual([expect.objectContaining({ childId: 'Billing', parentId: null, edgeId: null })])
    expect(links('Billing')).toHaveLength(0)
    expect(links('invoices').map((e) => e.source)).toEqual(['Billing'])
    expect(columnOfCard('Billing')).toBe('apps')
    expect(count('Finance')).toBe(1)
  }, 30000)

  it('is not offered for a type that needs a parent', async () => {
    const h = await openMoves()
    await h.openDrawer('Billing')
    const drawer = document.querySelector<HTMLElement>('[data-panel="entity-drawer"]')!
    await act(async () => { fireEvent.mouseDown(within(drawer).getByRole('tab', { name: /^Edit/ })) })
    await h.settle()
    await act(async () => { fireEvent.click(within(drawer).getByRole('button', { name: 'Choose a new parent…' })) })
    await h.settle()
    expect(within(drawer).queryByRole('option', { name: /On its own, at the top/ })).toBeNull()
  }, 30000)

  it('an App new in this draft moves too: its create goes under the new parent — one link, no move', async () => {
    const h = await openMoves()
    await act(async () => { fireEvent.click(within(cardBody('Sales')).getByRole('button', { name: 'Add child entity' })) })
    await h.settle()
    const input = screen.getByPlaceholderText('Enter display name...')
    await act(async () => { fireEvent.change(input, { target: { value: 'Payroll' } }) })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    await h.settle()
    act(() => useHierarchyBuilderStore.getState().close())
    await h.settle()
    const create = staged().find((c) => c.type === 'create_entity')!
    const temp = create.targetUrn!
    await dragOver(h, temp, cardBody('Marketing'))
    await dropOn(h, temp, cardBody('Marketing'))
    expect(moves()).toHaveLength(0)
    expect(staged().find((c) => c.id === create.id)!.after).toMatchObject({ parentUrn: 'Marketing', parentLabel: 'Marketing' })
    expect(links(temp).map((e) => [e.source, e.data?.isPending])).toEqual([['Marketing', 'create']])
    expect(columnOfCard(temp)).toBe('domains')
  }, 30000)

  it('discarding a new parent sends what was moved into it back; discarding a move keeps a later layout edit', async () => {
    const h = await openMoves()
    await expand(h, 'Sales')
    // A new Domain, then CRM moved into it.
    await act(async () => { fireEvent.click(within(headerOf('domains')).getByRole('button', { name: 'Add entity to Domains' })) })
    await h.settle()
    const input = screen.getByPlaceholderText('Enter display name...')
    await act(async () => { fireEvent.change(input, { target: { value: 'Ventures' } }) })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    await h.settle()
    act(() => useHierarchyBuilderStore.getState().close())
    await h.settle()
    const ventures = staged().find((c) => c.type === 'create_entity')!
    await dragOver(h, 'CRM', cardBody(ventures.targetUrn!))
    await dropOn(h, 'CRM', cardBody(ventures.targetUrn!))
    expect(links('CRM').map((e) => e.source)).toEqual([ventures.targetUrn])
    act(() => useStagedChangesStore.getState().discard(ventures.id))
    await h.settle()
    expect(staged()).toHaveLength(0)
    expect(links('CRM').map((e) => e.id)).toEqual(['c:Sales>CRM'])

    // A move, then a layout edit (Campaigns shown in the Apps column), then the move discarded.
    await expand(h, 'Marketing')
    await dragOver(h, 'CRM', cardBody('Marketing'))
    await dropOn(h, 'CRM', cardBody('Marketing'))
    await dragOver(h, 'Campaigns', headerOf('apps'))
    await dropOn(h, 'Campaigns', headerOf('apps'))
    expect(columnOfCard('Campaigns')).toBe('apps')
    act(() => useStagedChangesStore.getState().discard(moves()[0].id))
    await h.settle()
    expect(links('CRM').map((e) => e.id)).toEqual(['c:Sales>CRM'])
    expect(columnOfCard('Campaigns')).toBe('apps')
  }, 30000)
})
