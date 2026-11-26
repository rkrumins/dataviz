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
import { anchoredEstate, cfoEstate, columnsEstate, movesEstate } from '@/test/fixtures/traceEstates'
import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import { usePersonaStore } from '@/store/persona'
import { useSchemaStore } from '@/store/schema'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useFeaturesStore } from '@/store/features'
import { useWorkspacesStore } from '@/store/workspaces'
import { useNotificationStore } from '@/components/ui/notifications'
import { useHierarchyBuilderStore } from '@/components/canvas/create/hierarchyBuilderStore'
import { useBuildRowsStore } from '@/components/canvas/create/buildmode/buildRowsStore'
import { makeRow } from '@/components/canvas/create/buildmode/buildRow'
import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'
import type { ViewLayerConfig } from '@/types/schema'
import { normalizeReferenceLayout } from '@/utils/referenceLayout'

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

  /** A layer's ⋯ → Delete layer…, and the dialog's default: remove the column, keep its entities. */
  const deleteLayer = async (h: TraceCanvasHarness, layerId: string) => {
    await fromLayerMenu(h, layerId, 'Delete layer…')
    await act(async () => { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove column' })) })
    await h.settle()
  }

  it('a layer\'s ⋯ deletes it, staged', async () => {
    const h = await openBusiness()
    await deleteLayer(h, 'warehouse')
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
    await deleteLayer(h, 'warehouse')
    expect(columnIds()).toEqual(['report'])
    await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('[data-toolbar-item="undo"]')!) })
    await h.settle()
    expect(staged()).toEqual([])
    expect(columnIds()).toEqual(['warehouse', 'report'])
  }, 30000)

  it('Review & Save discards a change; Done keeps the draft open until nothing is pending', async () => {
    const h = await openBusiness()
    await deleteLayer(h, 'warehouse')
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

  const openMoves = async (opts: { persona?: 'business'; rootApps?: boolean; draft?: boolean; dataSourceId?: string; viewCounts?: Record<string, number> } = {}) => {
    const h = await renderCanvasWithTrace(movesEstate(), {
      focus: 'CRM', draft: opts.draft ?? true, deferTrace: true, persona: opts.persona,
      dataSourceId: opts.dataSourceId,
      viewCounts: opts.viewCounts && { total: 0, byWorkspace: {}, byDataSource: opts.viewCounts },
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
    expect(notices()).toContain('Moved Quotes inside Marketing. A data change — every view that shows it, once published. It stays in Apps, the column that holds its type.')
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

  // ── The entity menu: where this view shows it (a view change), and where it is (a data change) ──

  /** Right-click an entity and open its Move to Layer. */
  const openMoveToLayer = async (h: TraceCanvasHarness, id: string) => {
    await act(async () => { fireEvent.contextMenu(cardBody(id)) })
    await h.settle()
    await act(async () => { fireEvent.click(menuItem('Move to Layer')!) })
    await h.settle()
  }
  const menu = () => document.querySelector<HTMLElement>('[data-canvas-context-menu]')
  const menuItem = (label: string) => [...(menu()?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .find((b) => b.querySelector('span.block')?.textContent?.trim() === label)
  const menuLabels = () => [...(menu()?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    .map((b) => b.querySelector('span.block')?.textContent?.trim())
  /** Move to Layer's rows: what each does, its kind's tag, and why it can't be chosen. */
  const choices = () => [...document.querySelectorAll<HTMLButtonElement>('[data-move-choice]')].map((b) => ({
    label: b.querySelector('span.block')?.textContent,
    tag: b.querySelector('[data-change-tag]')?.textContent,
    kind: b.dataset.moveChoice,
    off: b.disabled,
    why: b.querySelector('[data-change-tag] + span')?.textContent ?? null,
  }))
  const choose = async (h: TraceCanvasHarness, label: string) => {
    const b = [...document.querySelectorAll<HTMLButtonElement>('[data-move-choice]')].find((x) => x.querySelector('span.block')?.textContent === label)
    if (!b) throw new Error(`no choice ${label} (there are ${choices().map((c) => c.label).join(', ')})`)
    await act(async () => { fireEvent.click(b) })
    await h.settle()
  }
  const DATA = 'Changes the data · every view'
  const VIEW = 'Only this view'
  const notice = (match: RegExp) => useNotificationStore.getState().notifications.find((n) => match.test(n.message))
  const press = async (h: TraceCanvasHarness, n: ReturnType<typeof notice>, label: string) => {
    const action = [n?.action, n?.secondaryAction].find((a) => a?.label === label)
    if (!action) throw new Error(`the notice offers no ${label}`)
    await act(async () => { action.onClick() })
    await h.settle()
  }

  it('Move to Layer is guided: every column says what it changes — a mapped one offers both', async () => {
    const h = await openMoves()
    await expand(h, 'Sales')
    await act(async () => { fireEvent.contextMenu(cardBody('CRM')) })
    await h.settle()
    expect(menuItem('Move to Layer')).toHaveTextContent('Where this view shows it')
    expect(menuItem('Move to another parent…')).toHaveTextContent('Changes the data · every view')
    await act(async () => { fireEvent.click(menuItem('Move to Layer')!) })
    await h.settle()

    expect(screen.getByText('Where should CRM go?')).toBeInTheDocument()
    expect(choices()).toEqual([
      { label: 'Move inside Finance', tag: DATA, kind: 'data', off: false, why: null },
      { label: 'Show in Finance column', tag: VIEW, kind: 'view', off: false, why: null },
      { label: 'Show in Domains', tag: VIEW, kind: 'view', off: true, why: 'Shown here' },
      { label: 'Show in Apps', tag: VIEW, kind: 'view', off: false, why: null },
    ])
    expect(menu()).toHaveTextContent('Only this view: the data doesn’t change. Changes the data: it moves in every view once published.')
  }, 30000)

  it('Move to Layer names entities as the Business view reads them', async () => {
    const h = await openMoves({ persona: 'business' })
    act(() => useCanvasStore.getState().updateNode('Finance', { businessLabel: 'Money', properties: { businessLabel: 'Money' } }))
    act(() => useCanvasStore.getState().updateNode('CRM', { businessLabel: 'Customers', properties: { businessLabel: 'Customers' } }))
    await expand(h, 'Sales')
    await openMoveToLayer(h, 'CRM')
    expect(screen.getByText('Where should Customers go?')).toBeInTheDocument()
    expect(choices()[0]).toMatchObject({ label: 'Move inside Money', kind: 'data' })
  }, 30000)

  it('"Move inside Finance" is one data move — and no layout change', async () => {
    const h = await openMoves()
    await expand(h, 'Sales')
    await openMoveToLayer(h, 'CRM')
    await choose(h, 'Move inside Finance')
    expect(staged().map((c) => c.type)).toEqual(['move_entity'])
    expect(moves()[0].after).toMatchObject({ childId: 'CRM', parentId: 'Finance' })
    expect(columnOfCard('CRM')).toBe('fin')
  }, 30000)

  it('"Show in Finance column" is only a view change — the data is untouched', async () => {
    const h = await openMoves()
    await expand(h, 'Sales')
    await openMoveToLayer(h, 'CRM')
    await choose(h, 'Show in Finance column')
    expect(staged().map((c) => c.type)).toEqual(['move_to_layer'])
    expect(links('CRM').map((e) => e.id)).toEqual(['c:Sales>CRM'])
    expect(columnOfCard('CRM')).toBe('fin')
  }, 30000)

  it('a data choice the canvas refuses is offered disabled, saying why', async () => {
    const h = await openMoves()
    act(() => useFeaturesStore.setState((s) => ({ values: { ...s.values, editModeEnabled: false } }) as never))
    await h.settle()
    await expand(h, 'Sales')
    await openMoveToLayer(h, 'CRM')
    expect(choices()[0]).toEqual({ label: 'Move inside Finance', tag: DATA, kind: 'data', off: true, why: 'Editing is turned off' })
    expect(choices()[1]).toMatchObject({ label: 'Show in Finance column', off: false })
  }, 30000)

  it('one already inside the column\'s entity is told so', async () => {
    const h = await openMoves()
    await openMoveToLayer(h, 'Billing')
    expect(choices().slice(0, 2)).toEqual([
      { label: 'Move inside Finance', tag: DATA, kind: 'data', off: true, why: 'Already inside Finance' },
      { label: 'Show in Finance column', tag: VIEW, kind: 'view', off: true, why: 'Shown here' },
    ])
  }, 30000)

  it('Move to another parent…: a guided dialog that stages one move', async () => {
    const h = await openMoves()
    await act(async () => { fireEvent.contextMenu(cardBody('Billing')) })
    await h.settle()
    await act(async () => { fireEvent.click(menuItem('Move to another parent…')!) })
    await h.settle()
    const dialog = screen.getByRole('dialog', { name: 'Move Billing to another parent' })
    expect(dialog).toHaveTextContent('This changes the data: Billing and everything inside it move under the parent you pick — in every view that shows it, once published. Its lineage stays as it is.')
    expect(dialog).toHaveTextContent('Now inside Finance')
    expect(within(dialog).getByText('Changes the data').closest('[data-change-tag]')).toHaveTextContent(DATA)
    const options = within(dialog).getByRole('listbox', { name: 'Possible parents' })
    await act(async () => { fireEvent.mouseDown(within(options).getByRole('option', { name: /Sales/ })) })
    await h.settle()
    expect(moves().map((c) => c.after)).toEqual([expect.objectContaining({ childId: 'Billing', parentId: 'Sales' })])
    expect(staged()).toHaveLength(1)
    expect(screen.queryByRole('dialog', { name: 'Move Billing to another parent' })).toBeNull()
  }, 30000)

  it('Move to another parent…: to the top level, where its type may stand alone', async () => {
    const h = await openMoves({ rootApps: true })
    await act(async () => { fireEvent.contextMenu(cardBody('Billing')) })
    await h.settle()
    await act(async () => { fireEvent.click(menuItem('Move to another parent…')!) })
    await h.settle()
    const dialog = screen.getByRole('dialog', { name: 'Move Billing to another parent' })
    await act(async () => { fireEvent.mouseDown(within(dialog).getByRole('option', { name: /On its own, at the top/ })) })
    await h.settle()
    expect(moves().map((c) => c.after)).toEqual([expect.objectContaining({ childId: 'Billing', parentId: null })])
  }, 30000)

  // Nor during a trace: traceMenu.harness.test.tsx.
  it('Move to another parent… is not offered outside a draft', async () => {
    const h = await openMoves({ draft: false })
    await act(async () => { fireEvent.contextMenu(cardBody('Billing')) })
    await h.settle()
    expect(menuLabels()).toContain('View details')
    expect(menuLabels()).not.toContain('Move to another parent…')
  }, 30000)

  it('a data move\'s notice says so, with Undo and Review & Save — Undo takes back that move alone', async () => {
    const h = await openMoves()
    await expand(h, 'Sales')
    await expand(h, 'Marketing')
    await dragOver(h, 'CRM', cardBody('Marketing'))
    await dropOn(h, 'CRM', cardBody('Marketing'))
    const moved = notice(/^Moved CRM inside Marketing\./)!
    expect(moved.message).toBe('Moved CRM inside Marketing. A data change — every view that shows it, once published.')
    expect([moved.action?.label, moved.secondaryAction?.label]).toEqual(['Undo', 'Review & Save'])

    // A later layout edit: Campaigns shown in the Apps column.
    await dragOver(h, 'Campaigns', headerOf('apps'))
    await dropOn(h, 'Campaigns', headerOf('apps'))
    await press(h, moved, 'Undo')
    expect(moves()).toHaveLength(0)
    expect(links('CRM').map((e) => e.id)).toEqual(['c:Sales>CRM'])
    expect(staged().map((c) => c.type)).toEqual(['assign_layer'])
    expect(columnOfCard('Campaigns')).toBe('apps')
  }, 30000)

  it('a view move\'s notice says only this view changed, with Undo — Undo takes back that one alone', async () => {
    const h = await openMoves()
    await expand(h, 'Sales')
    await openMoveToLayer(h, 'CRM')
    await choose(h, 'Show in Apps')
    const shown = notice(/^CRM now shows in Apps\./)!
    expect(shown.message).toBe('CRM now shows in Apps. Only this view — the data is unchanged.')
    expect(shown.action?.label).toBe('Undo')

    // The header drop says it too — and a later layout edit survives the first one's Undo.
    await expand(h, 'Marketing')
    await dragOver(h, 'Campaigns', headerOf('apps'))
    await dropOn(h, 'Campaigns', headerOf('apps'))
    expect(notice(/^Campaigns now shows in Apps\. Only this view — the data is unchanged\.$/)?.action?.label).toBe('Undo')
    await press(h, shown, 'Undo')
    expect(staged().map((c) => c.targetId)).toEqual(['Campaigns'])
    expect(columnOfCard('CRM')).toBe('domains')
    expect(columnOfCard('Campaigns')).toBe('apps')
    expect(moves()).toHaveLength(0)
  }, 30000)

  it('a view move that takes along what was placed inside it says so', async () => {
    const h = await openMoves()
    // Quotes is placed in Apps by hand; Sales, its parent, moves to Apps — Quotes follows it.
    await openMoveToLayer(h, 'Sales')
    await choose(h, 'Show in Apps')
    expect(notices()).toContain('Sales now shows in Apps. Only this view — the data is unchanged. 1 placed inside it now follows it.')
  }, 30000)

  it('Review & Save says how many changes are to the data and how many only to this view', async () => {
    const h = await openMoves()
    await expand(h, 'Sales')
    await dragOver(h, 'CRM', cardBody('Marketing'))
    await dropOn(h, 'CRM', cardBody('Marketing'))
    await dragOver(h, 'Quotes', headerOf('domains'))
    await dropOn(h, 'Quotes', headerOf('domains'))
    act(() => useStagedChangesStore.getState().openReviewPanel())
    await h.settle()
    const review = screen.getByRole('dialog', { name: /Review & Save Changes/ })
    expect(review).toHaveTextContent('You’re making 1 data change (every view) and 1 view change (only this view). Nothing is saved until you choose below.')
    // Each run of changes says which kind it is.
    expect([...review.querySelectorAll('[data-change-tag]')].map((t) => t.textContent)).toEqual([DATA, VIEW])
  }, 30000)

  it('names the other views on the data source a data move reaches — counted from those the reader can see', async () => {
    useWorkspacesStore.setState({ workspaces: [{ id: 'harness-ws', name: 'Harness', dataSources: [{ id: 'ds-retail', label: 'Retail data pipeline' }] }] } as never)
    const h = await openMoves({ dataSourceId: 'ds-retail', viewCounts: { 'ds-retail': 4 } })
    await expand(h, 'Sales')
    await dragOver(h, 'CRM', cardBody('Marketing'))
    await dropOn(h, 'CRM', cardBody('Marketing'))
    const moved = notice(/^Moved CRM inside Marketing\./)!
    expect(moved.message).toBe('Moved CRM inside Marketing. A data change — this view now, and 3 other views on Retail data pipeline once published.')
    expect(moved.detail).toBe('Counted from the views you can see — others’ private views follow too. Data source: ds-retail')

    await act(async () => { fireEvent.contextMenu(cardBody('Billing')) })
    await h.settle()
    expect(menuItem('Move to another parent…')).toHaveTextContent('Changes the data · this view and 3 others on Retail data pipeline')
    await act(async () => { fireEvent.click(menuItem('Move to another parent…')!) })
    await h.settle()
    expect(screen.getByRole('dialog', { name: 'Move Billing to another parent' }))
      .toHaveTextContent('Retail data pipeline has 3 other views. Each one that shows Billing will show it under the new parent once published.')
  }, 30000)
})

// ─── Deleting a column, and taking an entity out: what it changes, said first ──────────────────
//
// The graph is the truth and a view is a lens. Deleting a column is a VIEW change — its entities
// show where their parent or a type column puts them, or leave the view — unless the reader also
// deletes them from the DATA: staged in the draft, with what is inside them, reviewed on save.
// The dialog says which, and exactly what happens, before anything does.

const staged = () => useStagedChangesStore.getState().changes
const layout = () => normalizeReferenceLayout(useSchemaStore.getState().getActiveView()!.layout!.referenceLayout)
const columnOfCard = (id: string) =>
  document.getElementById(`layer-node-${id}`)?.closest<HTMLElement>('[data-layer-id].group\\/column')?.dataset.layerId
const notice = (match: RegExp) => useNotificationStore.getState().notifications.find((n) => match.test(n.message))
const press = async (h: TraceCanvasHarness, n: ReturnType<typeof notice>, label: string) => {
  const action = [n?.action, n?.secondaryAction].find((a) => a?.label === label)
  if (!action) throw new Error(`the notice offers no ${label}`)
  await act(async () => { action.onClick() })
  await h.settle()
}
const click = async (h: TraceCanvasHarness, el: HTMLElement) => {
  await act(async () => { fireEvent.click(el) })
  await h.settle()
}
const menu = () => document.querySelector<HTMLElement>('[data-canvas-context-menu]')
const menuItem = (label: string) => [...(menu()?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  .find((b) => b.querySelector('span.block')?.textContent?.trim() === label)
const menuLabels = () => [...(menu()?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  .map((b) => b.querySelector('span.block')?.textContent?.trim()).filter(Boolean)

/** Right-click a column's header and choose Delete layer…: the dialog it opens. */
const askToDelete = async (h: TraceCanvasHarness, layerId: string, name: string) => {
  await act(async () => { fireEvent.contextMenu(headerOf(layerId)) })
  await h.settle()
  await click(h, menuItem('Delete layer…')!)
  return screen.getByRole('dialog', { name: `Delete the ${name} column` })
}
/** A choice in the dialog: its tag, and what it says will happen, line by line. */
const option = (kind: 'view' | 'data') => {
  const el = document.querySelector<HTMLElement>(`[data-delete-choice="${kind}"]`)
  if (!el) throw new Error(`the dialog offers no ${kind} choice`)
  return {
    el,
    radio: el.querySelector<HTMLInputElement>('input[type="radio"]')!,
    tag: el.querySelector('[data-change-tag]')?.textContent,
    lines: [...el.querySelectorAll('li')].map((li) => li.textContent),
  }
}
const confirm = (dialog: HTMLElement) => within(dialog).getAllByRole('button').at(-1)!

/** What the delete-impact read answers, per entity: everything inside it, and its relationships. */
const IMPACT: Record<string, { inside: string[]; edges: string[] }> = {
  Ops: { inside: ['ops.a', 'ops.b', 'ops.c'], edges: ['e1', 'e2', 'e3', 'e4', 'shared'] },
  Lab: { inside: [], edges: ['e5', 'shared'] },
  Sales: { inside: ['CRM', 'leads', 'Quotes'], edges: ['c1', 'c2', 'c3', 'l1'] },
  Marketing: { inside: ['Campaigns'], edges: ['c4'] },
}
const answerImpact = (url: string) => {
  const m = /\/graph\/nodes\/([^/]+)\/delete-impact/.exec(url)
  if (!m) return undefined
  const urn = decodeURIComponent(m[1])
  const i = IMPACT[urn] ?? { inside: [], edges: [] }
  return {
    nodes: [urn, ...i.inside].map((u) => ({ entityId: u, urn: u })),
    edges: i.edges.map((e) => ({ entityId: e })),
    nodeTotal: 1 + i.inside.length, edgeTotal: i.edges.length,
  }
}

const openColumns = async (opts: { scope?: 'all' | 'curated'; persona?: 'business'; counted?: boolean; draft?: boolean } = {}) => {
  if (opts.counted) {
    useWorkspacesStore.setState({ workspaces: [{ id: 'harness-ws', name: 'Harness', dataSources: [{ id: 'ds-retail', label: 'Retail' }] }] } as never)
  }
  const h = await renderCanvasWithTrace(columnsEstate(), {
    focus: 'Ops', draft: opts.draft ?? true, deferTrace: true, persona: opts.persona, entityScope: opts.scope,
    entityTypes: [
      ontologyType('domain', 'Domain', ['app'], [], 0),
      ontologyType('app', 'App', ['dataset'], ['domain'], 1),
      ontologyType('dataset', 'Dataset', [], ['app'], 2),
    ],
    ...(opts.counted ? {
      dataSourceId: 'ds-retail',
      viewCounts: { total: 0, byWorkspace: {}, byDataSource: { 'ds-retail': 3 } },
      answer: answerImpact,
    } : {}),
  })
  // The delete-impact read needs the draft's graph.
  if (opts.counted) act(() => useBranchStore.setState({ graphId: 'harness-graph' } as never))
  allowNesting()
  await h.settle()
  return h
}

const resetColumns = () => {
  useStagedChangesStore.setState({ changes: [], redoStack: [], past: [], isReviewPanelOpen: false })
  useNotificationStore.setState({ notifications: [] })
  useHierarchyBuilderStore.getState().close()
  useBranchStore.setState({ graphId: null } as never)
  useWorkspacesStore.setState({ workspaces: [] } as never)
}

describe('deleting a column: a guided choice that says what happens to what it shows', () => {
  beforeEach(resetColumns)

  it('an empty column: a simple confirm — only the column goes, only this view', async () => {
    const h = await openColumns()
    const dialog = await askToDelete(h, 'spare', 'Spare')
    expect(dialog).toHaveTextContent('Nothing is in it — only the column goes.')
    expect(dialog.querySelector('[data-change-tag]')?.textContent).toBe('Only this view')
    expect(document.querySelector('[data-delete-choice]')).toBeNull()
    expect(confirm(dialog)).toHaveTextContent('Delete column')
    await click(h, confirm(dialog))
    expect(columnIds()).not.toContain('spare')
    expect(staged()).toEqual([expect.objectContaining({ type: 'layer_config', summary: 'Deleted layer “Spare”' })])
    const done = notice(/^Removed the Spare column\./)!
    expect(done.message).toBe('Removed the Spare column. Only this view — the data is unchanged.')
    await press(h, done, 'Undo')
    expect(columnIds()).toEqual(['fin', 'domains', 'apps', 'picked', 'shelf', 'spare'])
    expect(staged()).toEqual([])
  }, 30000)

  it('by default it removes only the column, saying where its entities go — here, out of the view (curated)', async () => {
    const h = await openColumns()
    const dialog = await askToDelete(h, 'picked', 'Picked')
    expect(dialog).toHaveTextContent('Choose what happens to the 2 entities it shows.')
    const keep = option('view')
    expect(keep.radio.checked).toBe(true)
    expect(keep.el).toHaveTextContent('Remove the column — keep its entities')
    expect(keep.tag).toBe('Only this view')
    expect(keep.lines).toEqual([
      'Lab and Ops won’t be in this view.',
      'The 2 entities placed here by hand lose that place.',
    ])
    expect(option('data').el).toHaveTextContent('Also delete its entities from the data')
    expect(option('data').radio.checked).toBe(false)
    expect(confirm(dialog)).toHaveTextContent('Remove column')

    await click(h, confirm(dialog))
    expect(columnIds()).toEqual(['fin', 'domains', 'apps', 'shelf', 'spare'])
    expect(document.getElementById('layer-node-Ops')).toBeNull()
    expect(layout().assignments).not.toHaveProperty('Ops')
    expect(layout().assignments).not.toHaveProperty('Lab')
    expect(staged()).toEqual([expect.objectContaining({ type: 'layer_config', summary: 'Deleted layer “Picked”' })])
    expect(staged().some((c) => c.type === 'delete_entity')).toBe(false)
    const done = notice(/^Removed the Picked column\./)!
    expect(done.message).toBe('Removed the Picked column. Lab and Ops are no longer in this view. Only this view — the data is unchanged.')

    // Undo puts back the column where it stood, and what was placed in it.
    await press(h, done, 'Undo')
    expect(columnIds()).toEqual(['fin', 'domains', 'apps', 'picked', 'shelf', 'spare'])
    expect(columnOfCard('Ops')).toBe('picked')
    expect(layout().assignments).toHaveProperty('Lab')
    expect(staged()).toEqual([])
  }, 30000)

  it('in a view open to its data source, they fall to the column of their type', async () => {
    const h = await openColumns({ scope: 'all' })
    await askToDelete(h, 'picked', 'Picked')
    expect(option('view').lines).toEqual([
      'Lab and Ops will show in Domains, by their type.',
      'The 2 entities placed here by hand lose that place.',
    ])
    await click(h, confirm(screen.getByRole('dialog')))
    expect(columnOfCard('Ops')).toBe('domains')
    expect(columnOfCard('Lab')).toBe('domains')
  }, 30000)

  it('one placed apart from its parent goes back under it, in its parent\'s column', async () => {
    const h = await openColumns()
    await askToDelete(h, 'apps', 'Apps')
    expect(option('view').lines).toEqual([
      'Quotes will go back under its parent, Sales, in Domains.',
      'The one entity placed here by hand loses that place.',
    ])
    await click(h, confirm(screen.getByRole('dialog')))
    const chevron = cardBody('Sales').querySelector('svg.lucide-chevron-right')?.closest('button')
    if (chevron) await click(h, chevron as HTMLElement)
    expect(columnOfCard('Quotes')).toBe('domains')
  }, 30000)

  it('groups and the groups inside them go with the column', async () => {
    const h = await openColumns()
    await askToDelete(h, 'shelf', 'Shelf')
    expect(option('view').lines).toEqual([
      'Archive and Vault won’t be in this view.',
      'The 2 entities placed here by hand lose that place.',
      'Its groups Shelf and Deep go with it.',
    ])
    await click(h, confirm(screen.getByRole('dialog')))
    expect(columnIds()).not.toContain('shelf')
    await press(h, notice(/^Removed the Shelf column\./), 'Undo')
    const shelf = layout().layers.find((l) => l.id === 'shelf')!
    expect(shelf.logicalNodes).toEqual([{ id: 'g-shelf', name: 'Shelf', type: 'group', children: [{ id: 'g-deep', name: 'Deep', type: 'group' }] }])
    expect(layout().assignments.Vault).toMatchObject({ layerId: 'shelf', logicalNodeId: 'g-deep' })
  }, 30000)

  it('also deleting its entities from the data says how much, and who it reaches, first — and stages it as data changes', async () => {
    const h = await openColumns({ counted: true })
    const dialog = await askToDelete(h, 'picked', 'Picked')
    await click(h, option('data').radio)
    const data = option('data')
    expect(data.tag).toBe('Changes the data · this view and 2 others on Retail')
    expect(data.lines).toEqual([
      '2 entities and 3 inside them; 6 relationships.',
      'Staged in this draft — nothing is deleted until you save it; the other views follow once it’s published.',
    ])
    expect(confirm(dialog)).toHaveTextContent('Delete 2 entities')

    await click(h, confirm(dialog))
    expect(staged().map((c) => c.type).sort()).toEqual(['delete_entity', 'delete_entity', 'layer_config'])
    expect(staged().filter((c) => c.type === 'delete_entity').map((c) => c.targetUrn).sort()).toEqual(['Lab', 'Ops'])
    // The impact it showed is the one each delete carries to Review & Save — read once.
    expect(staged().find((c) => c.targetUrn === 'Ops')!.summary).toBe("Delete 'Ops' — also removes 3 contained entities, 5 relationships")
    expect(columnIds()).not.toContain('picked')
    const done = notice(/^Removed the Picked column and staged deleting/)!
    expect(done.message).toBe('Removed the Picked column and staged deleting its 2 entities, with everything inside them. A data change — this view now, and 2 other views on Retail once published.')
    expect([done.action?.label, done.secondaryAction?.label]).toEqual(['Undo', 'Review & Save'])

    // Undo takes the whole choice back: the deletes and the column.
    await press(h, done, 'Undo')
    expect(staged()).toEqual([])
    expect(columnOfCard('Ops')).toBe('picked')
    expect(useCanvasStore.getState().nodes.find((n) => n.id === 'Ops')?.data?.isPending).toBeUndefined()
  }, 30000)

  it('a staged delete is discarded from Review & Save like any other — the column stays removed', async () => {
    const h = await openColumns({ counted: true })
    await askToDelete(h, 'picked', 'Picked')
    await click(h, option('data').radio)
    await click(h, confirm(screen.getByRole('dialog')))
    const ops = staged().find((c) => c.type === 'delete_entity' && c.targetUrn === 'Ops')!
    act(() => useStagedChangesStore.getState().discard(ops.id))
    await h.settle()
    expect(staged().map((c) => c.type).sort()).toEqual(['delete_entity', 'layer_config'])
    expect(useCanvasStore.getState().nodes.find((n) => n.id === 'Ops')?.data?.isPending).toBeUndefined()
    expect(columnIds()).not.toContain('picked')
  }, 30000)

  it('names what is inside them but shown in another column — it goes too', async () => {
    const h = await openColumns({ counted: true })
    await askToDelete(h, 'domains', 'Domains')
    expect(option('view').lines).toEqual([
      'Marketing and Sales won’t be in this view.',
      'The 2 entities placed here by hand lose that place.',
    ])
    await click(h, option('data').radio)
    expect(option('data').lines).toEqual([
      '2 entities and 4 inside them; 5 relationships.',
      'Also deletes Quotes, inside them but shown in Apps.',
      'Staged in this draft — nothing is deleted until you save it; the other views follow once it’s published.',
    ])
  }, 30000)

  it('entities new in this draft have their creates discarded, not deletes staged — and Undo brings them back', async () => {
    const h = await openColumns()
    await click(h, within(headerOf('picked')).getByRole('button', { name: 'Add entity to Picked' }))
    const input = screen.getByPlaceholderText('Enter display name...')
    await act(async () => { fireEvent.change(input, { target: { value: 'Payroll' } }) })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    await h.settle()
    act(() => useHierarchyBuilderStore.getState().close())
    await h.settle()
    const create = staged().find((c) => c.type === 'create_entity')!
    const temp = create.targetUrn!
    expect(columnOfCard(temp)).toBe('picked')

    const dialog = await askToDelete(h, 'picked', 'Picked')
    await click(h, option('data').radio)
    expect(option('data').lines).toEqual([
      '3 entities, with everything inside them.',
      '1 is new in this draft — its create is discarded instead.',
      'Staged in this draft — nothing is deleted until you save it; every view follows once it’s published.',
    ])
    await click(h, confirm(dialog))
    expect(staged().some((c) => c.id === create.id)).toBe(false)
    expect(staged().filter((c) => c.type === 'delete_entity').map((c) => c.targetUrn).sort()).toEqual(['Lab', 'Ops'])
    expect(useCanvasStore.getState().nodes.some((n) => n.id === temp)).toBe(false)

    await press(h, notice(/^Removed the Picked column and staged deleting/), 'Undo')
    expect(staged().map((c) => c.id)).toEqual([create.id])
    expect(columnOfCard(temp)).toBe('picked')
  }, 30000)

  it('where the draft takes no data edits, the data choice is offered disabled, saying why', async () => {
    const h = await openColumns()
    act(() => useFeaturesStore.setState({ values: { ...useFeaturesStore.getState().values, editModeEnabled: false } } as never))
    await h.settle()
    const dialog = await askToDelete(h, 'picked', 'Picked')
    expect(option('data').radio.disabled).toBe(true)
    expect(option('data').lines).toEqual(['Editing is turned off for this workspace, so nothing can be deleted from the data.'])
    expect(option('view').radio.checked).toBe(true)
    await click(h, confirm(dialog))
    expect(staged()).toEqual([expect.objectContaining({ type: 'layer_config' })])
  }, 30000)

  it('in a trace, nothing is deleted: the layer menu offers no Delete', async () => {
    const h = await openColumns()
    await h.startTrace('Ops')
    await act(async () => { fireEvent.contextMenu(headerOf('picked')) })
    await h.settle()
    expect(menuLabels().some((l) => /^Delete/.test(l!))).toBe(false)
  }, 30000)

  it('the column\'s own trash, in the Technical header, opens the same dialog', async () => {
    const h = await openColumns()
    await click(h, within(headerOf('picked')).getByRole('button', { name: 'Delete Picked' }))
    expect(screen.getByRole('dialog', { name: 'Delete the Picked column' })).toBeInTheDocument()
  }, 30000)
})

describe('taking an entity out: from this view, or from the data — its menu says which', () => {
  beforeEach(resetColumns)

  /** An item of the menu on screen: its label's state, what it says under it, and its kind's tag. */
  const item = (label: string) => {
    const b = menuItem(label)
    if (!b) throw new Error(`the menu offers no "${label}" (it has ${menuLabels().join(', ')})`)
    return { el: b, off: b.disabled, hint: b.querySelector('span.block + span:not([data-change-tag])')?.textContent ?? null, tag: b.querySelector('[data-change-tag]')?.textContent }
  }
  const rightClick = async (h: TraceCanvasHarness, id: string) => {
    await act(async () => { fireEvent.contextMenu(cardBody(id)) })
    await h.settle()
  }
  const expand = async (h: TraceCanvasHarness, id: string) => {
    const chevron = cardBody(id).querySelector('svg.lucide-chevron-right')?.closest('button')
    if (!chevron) throw new Error(`no chevron on ${id}`)
    await click(h, chevron as HTMLElement)
  }
  const toolbarUndo = (h: TraceCanvasHarness) => click(h, document.querySelector<HTMLElement>('[data-toolbar-item="undo"]')!)

  it('"Remove from this view": a hand-placed entity leaves the view — only this view, with Undo', async () => {
    const h = await openColumns()
    await rightClick(h, 'Ops')
    expect(item('Remove from this view')).toMatchObject({ off: false, tag: 'Only this view' })
    expect(item('Delete from data')).toMatchObject({ off: false, tag: 'Changes the data · every view' })
    await click(h, item('Remove from this view').el)

    expect(document.getElementById('layer-node-Ops')).toBeNull()
    expect(layout().assignments).not.toHaveProperty('Ops')
    expect(staged()).toEqual([expect.objectContaining({ type: 'layer_config', summary: "Remove 'Ops' from this view" })])
    const done = notice(/^Ops is no longer in this view\./)!
    expect(done.message).toBe('Ops is no longer in this view. Only this view — the data is unchanged.')
    await press(h, done, 'Undo')
    expect(columnOfCard('Ops')).toBe('picked')
    expect(staged()).toEqual([])
  }, 30000)

  it('is no removal where its parent or a column\'s type shows it — it says why, and does nothing', async () => {
    const h = await openColumns()
    await expand(h, 'Sales')
    await rightClick(h, 'CRM')
    expect(item('Remove from this view')).toMatchObject({ off: true, hint: 'Shown because it’s inside Sales', tag: 'Only this view' })
    await click(h, item('Remove from this view').el)
    expect(staged()).toEqual([])
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    await h.settle()

    // Placed apart from its parent: taking the placement away puts it back under Sales — not out.
    await rightClick(h, 'Quotes')
    expect(item('Remove from this view')).toMatchObject({ off: true, hint: 'Shown because it’s inside Sales' })
  }, 30000)

  it('in a view open to its data source, a type column holds it all the same', async () => {
    const h = await openColumns({ scope: 'all' })
    await rightClick(h, 'Sales')
    expect(item('Remove from this view')).toMatchObject({ off: true, hint: 'Shown because Domains holds every Domain' })
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    await h.settle()
    await rightClick(h, 'Ops')
    expect(item('Remove from this view')).toMatchObject({ off: true, hint: 'Shown because Domains holds every Domain' })
  }, 30000)

  it('"Delete from data": the delete, said as a data change with who it reaches — staged, with Undo', async () => {
    const h = await openColumns({ counted: true })
    await rightClick(h, 'Ops')
    expect(item('Delete from data').tag).toBe('Changes the data · this view and 2 others on Retail')
    await click(h, item('Delete from data').el)
    expect(staged().map((c) => [c.type, c.targetUrn])).toEqual([['delete_entity', 'Ops']])
    expect(useCanvasStore.getState().nodes.find((n) => n.id === 'Ops')?.data?.isPending).toBe('delete')
    const done = notice(/^Ops will be deleted from the data/)!
    expect(done.message).toBe('Ops will be deleted from the data, with everything inside it. A data change — this view now, and 2 other views on Retail once published.')
    expect([done.action?.label, done.secondaryAction?.label]).toEqual(['Undo', 'Review & Save'])
    await press(h, done, 'Undo')
    expect(staged()).toEqual([])
    expect(useCanvasStore.getState().nodes.find((n) => n.id === 'Ops')?.data?.isPending).toBeUndefined()
  }, 30000)

  it('a new entity is discarded rather than deleted — and Undo brings it back', async () => {
    const h = await openColumns()
    await click(h, within(headerOf('picked')).getByRole('button', { name: 'Add entity to Picked' }))
    const input = screen.getByPlaceholderText('Enter display name...')
    await act(async () => { fireEvent.change(input, { target: { value: 'Payroll' } }) })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    await h.settle()
    act(() => useHierarchyBuilderStore.getState().close())
    await h.settle()
    const create = staged().find((c) => c.type === 'create_entity')!
    await rightClick(h, create.targetUrn!)
    await click(h, item('Delete from data').el)
    expect(staged()).toEqual([])
    const done = notice(/^Payroll was new in this draft/)!
    expect(done.message).toBe('Payroll was new in this draft — it’s discarded.')
    await press(h, done, 'Undo')
    expect(staged().map((c) => c.id)).toEqual([create.id])
    expect(columnOfCard(create.targetUrn!)).toBe('picked')
  }, 30000)

  it('a selection acts as one: both out of the view, or both deleted — one notice, one Undo', async () => {
    const h = await openColumns()
    act(() => { useCanvasStore.getState().selectNode('Ops'); useCanvasStore.getState().selectNode('Lab', true) })
    await h.settle()
    await rightClick(h, 'Ops')
    await click(h, item('Remove 2 from this view').el)
    expect(document.getElementById('layer-node-Ops')).toBeNull()
    expect(document.getElementById('layer-node-Lab')).toBeNull()
    expect(useNotificationStore.getState().notifications.map((n) => n.message))
      .toEqual(['2 entities are no longer in this view. Only this view — the data is unchanged.'])
    await toolbarUndo(h)
    expect(columnOfCard('Ops')).toBe('picked')
    expect(columnOfCard('Lab')).toBe('picked')
    expect(staged()).toEqual([])

    useNotificationStore.setState({ notifications: [] })
    act(() => { useCanvasStore.getState().selectNode('Ops'); useCanvasStore.getState().selectNode('Lab', true) })
    await h.settle()
    await rightClick(h, 'Lab')
    await click(h, item('Delete 2 from data').el)
    expect(staged().map((c) => c.targetUrn).sort()).toEqual(['Lab', 'Ops'])
    expect(useNotificationStore.getState().notifications.map((n) => n.message))
      .toEqual(['2 entities will be deleted from the data, with everything inside them. A data change — every view that shows it, once published.'])
    await press(h, notice(/^2 entities will be deleted/), 'Undo')
    expect(staged()).toEqual([])
  }, 30000)

  it('a selection takes out what it can, and says what stays', async () => {
    const h = await openColumns()
    await expand(h, 'Sales')
    act(() => { useCanvasStore.getState().selectNode('Ops'); useCanvasStore.getState().selectNode('CRM', true) })
    await h.settle()
    await rightClick(h, 'CRM')
    await click(h, item('Remove 2 from this view').el)
    expect(document.getElementById('layer-node-Ops')).toBeNull()
    expect(columnOfCard('CRM')).toBe('domains')
    expect(notice(/^Ops is no longer in this view\./)?.message)
      .toBe('Ops is no longer in this view. CRM still shows, where this view puts it. Only this view — the data is unchanged.')
  }, 30000)

  it('where the draft takes no data edits, "Delete from data" says why — this view can still change', async () => {
    const h = await openColumns()
    act(() => useFeaturesStore.setState({ values: { ...useFeaturesStore.getState().values, editModeEnabled: false } } as never))
    await h.settle()
    await rightClick(h, 'Ops')
    expect(item('Delete from data')).toMatchObject({ off: true, hint: 'Editing is turned off' })
    expect(item('Remove from this view').off).toBe(false)
  }, 30000)

  it('outside a draft, both are offered to one who can start editing — disabled, saying how', async () => {
    const h = await openColumns({ draft: false })
    act(() => useBranchStore.setState({ graphId: 'harness-graph' } as never))
    await h.settle()
    await rightClick(h, 'Ops')
    expect(item('Remove from this view')).toMatchObject({ off: true, hint: 'Start editing to change this view' })
    expect(item('Delete from data')).toMatchObject({ off: true, hint: 'Start editing to change the data' })
  }, 30000)

  it('in a trace, neither is offered', async () => {
    const h = await openColumns()
    await h.startTrace('Ops')
    await rightClick(h, 'Ops')
    expect(menuLabels()).not.toContain('Remove from this view')
    expect(menuLabels()).not.toContain('Delete from data')
  }, 30000)
})
