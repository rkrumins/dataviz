/**
 * Mapping a column to a top-level entity, on the REAL Context View canvas, in a draft. A mapped
 * column IS its entity: its rows are what is inside it, and adding or dropping there goes inside
 * it. Mapping is a view change — the column's `anchorUrn` and the entity's placement in it, always
 * together — staged as ONE change whose Undo takes back only what it touched:
 *
 *   • a hand-picked column of at most one entity maps from its card or its menu, through a picker
 *     of the top-level entities in the view; a mapped one shows its entity as a row again, or maps
 *     to another; a column of several roots, or of groups, is never offered it, and says why;
 *   • a top-level entity's row offers it a column of its own, right after the one it is in;
 *   • the first entity added to an empty hand-picked column is offered the column — one click,
 *     never automatic;
 *   • an empty mapped column says what is inside its entity, and how to fill it;
 *   • a column's title follows its entity's live name until someone renames it;
 *   • an entity new in this draft keeps its column through a save, and its column lets go of it
 *     when its create is discarded;
 *   • moving a mapped entity's placement to another column takes the mapping with it.
 */
import { act, fireEvent, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderCanvasWithTrace, type TraceCanvasHarness } from '@/test/canvasHarness'
import { useBranchStore } from '@/store/branchStore'
import { useCanvasStore } from '@/store/canvas'
import { usePersonaStore } from '@/store/persona'
import { useSchemaStore } from '@/store/schema'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useNotificationStore } from '@/components/ui/notifications'
import { useHierarchyBuilderStore } from '@/components/canvas/create/hierarchyBuilderStore'
import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'
import type { ViewLayerConfig } from '@/types/schema'
import { normalizeReferenceLayout } from '@/utils/referenceLayout'

// ── The estate ────────────────────────────────────────────────────────────────
//   Finance  ⊃ Billing, Ledger   ← column "Finance", mapped to it (named after it)
//   Sales    ⊃ CRM               ← column "Domains" (of the domain type)
//   Marketing ⊃ Campaigns        ← column "Domains"
//   Ops                          ← column "Picked", hand-picked: one entity
//   Lab, Glossary (a term)       ← column "Pair", hand-picked: two
//   Archive                      ← column "Grouped", in its group "Shelf"
//   Vault (3 inside, none loaded) ← column "Vault", mapped to it, drawn as a row until they load
const wn = (urn: string, type: string, childCount = 0): LensWalkNode => ({
  id: urn, type: 'default', position: { x: 0, y: 0 },
  data: { urn, label: urn, type, childCount }, urn, displayName: urn, entityType: type,
}) as unknown as LensWalkNode

function mappingEstate(extra: { vault?: boolean } = {}) {
  const nodes = [
    wn('Finance', 'domain', 2), wn('Billing', 'app'), wn('Ledger', 'app'),
    wn('Sales', 'domain', 1), wn('CRM', 'app'), wn('Marketing', 'domain', 1), wn('Campaigns', 'app'),
    wn('Ops', 'domain'), wn('Lab', 'domain'), wn('Glossary', 'term'), wn('Archive', 'domain'),
    ...(extra.vault ? [wn('Vault', 'domain', 3)] : []),
  ]
  const has = (p: string, c: string) => ({ sourceUrn: p, targetUrn: c })
  const model: LensWalkModel = {
    focusUrn: 'Ops', nodes, lineageEdges: [],
    containmentEdges: [has('Finance', 'Billing'), has('Finance', 'Ledger'), has('Sales', 'CRM'), has('Marketing', 'Campaigns')],
    upstreamUrns: new Set(), downstreamUrns: new Set(), frontierUp: [], frontierDown: [],
    truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
  }
  const layers: ViewLayerConfig[] = [
    { id: 'fin', name: 'Finance', order: 0, entityTypes: [], anchorUrn: 'Finance', nameFromAnchor: true },
    { id: 'domains', name: 'Domains', order: 1, entityTypes: ['domain'] },
    { id: 'picked', name: 'Picked', order: 2, entityTypes: [] },
    { id: 'pair', name: 'Pair', order: 3, entityTypes: [] },
    { id: 'grouped', name: 'Grouped', order: 4, entityTypes: [], logicalNodes: [{ id: 'shelf', name: 'Shelf', type: 'group' }] },
    ...(extra.vault ? [{ id: 'vault', name: 'Vault', order: 5, entityTypes: [], anchorUrn: 'Vault' }] : []),
  ]
  const assignments: Record<string, { layerId: string; logicalNodeId?: string }> = {
    Finance: { layerId: 'fin' }, Sales: { layerId: 'domains' }, Marketing: { layerId: 'domains' },
    Ops: { layerId: 'picked' }, Lab: { layerId: 'pair' }, Glossary: { layerId: 'pair' },
    Archive: { layerId: 'grouped', logicalNodeId: 'shelf' },
    ...(extra.vault ? { Vault: { layerId: 'vault' } } : {}),
  }
  return { model, layers, assignments }
}

const ontologyType = (id: string, name: string, canContain: string[], canBeContainedBy: string[], level: number) => ({
  id, name, pluralName: `${name}s`, visual: {}, properties: [], fields: [], behavior: {},
  hierarchy: { level, canContain, canBeContainedBy, defaultExpanded: false, rollUpFields: [] },
})
const ONTOLOGY = [
  ontologyType('domain', 'Domain', ['app'], [], 0),
  ontologyType('app', 'App', [], ['domain'], 1),
  ontologyType('term', 'Term', [], [], 0),
]
/** The harness seeds no relationship types: one containment relationship, so things can nest. */
const allowNesting = () => act(() => {
  useSchemaStore.setState((s) => ({
    schema: { ...s.schema!, relationshipTypes: [{
      id: 'CONTAINS', name: 'Contains', sourceTypes: [], targetTypes: [], isContainment: true,
      visual: { strokeColor: '#94a3b8', strokeWidth: 1, strokeStyle: 'solid', animated: false, curveType: 'bezier' },
    }] },
  }) as never)
})

const open = async (opts: {
  persona?: 'business'; vault?: boolean; draft?: boolean; dataSourceId?: string; answer?: (url: string) => unknown
  entityTypes?: unknown[]
} = {}) => {
  const h = await renderCanvasWithTrace(mappingEstate({ vault: opts.vault }), {
    focus: 'Ops', draft: opts.draft ?? true, deferTrace: true, persona: opts.persona, entityTypes: opts.entityTypes ?? ONTOLOGY,
    dataSourceId: opts.dataSourceId, answer: opts.answer,
  })
  allowNesting()
  await h.settle()
  return h
}

// ── Reading the canvas ────────────────────────────────────────────────────────
const columnIds = () =>
  [...document.querySelectorAll<HTMLElement>('[data-layer-id].group\\/column')].map((el) => el.dataset.layerId)
const columnEl = (layerId: string) => document.querySelector<HTMLElement>(`[data-layer-id="${layerId}"].group\\/column`)!
/** A column's body: its rows, or what it says when it has none. */
const bodyOf = (layerId: string) => columnEl(layerId).querySelector<HTMLElement>('.custom-scrollbar')!
const headerOf = (layerId: string) => columnEl(layerId).querySelector<HTMLElement>('.sticky.top-0')!
const titleOf = (layerId: string) => within(headerOf(layerId)).getByRole('heading').textContent
const columnOfCard = (id: string) =>
  document.getElementById(`layer-node-${id}`)?.closest<HTMLElement>('[data-layer-id].group\\/column')?.dataset.layerId
const cardBody = (id: string) => {
  const card = document.getElementById(`layer-node-${id}`)
  if (!card) throw new Error(`no card ${id}`)
  return card
}
/** The view's layout as the canvas holds it. */
const layout = () => normalizeReferenceLayout(useSchemaStore.getState().getActiveView()!.layout!.referenceLayout)
const layerOf = (id: string) => layout().layers.find((l) => l.id === id)
const staged = () => useStagedChangesStore.getState().changes
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

/** The card the column's name opens: what kind of column it is, and what mapping it offers. */
const openCard = async (h: TraceCanvasHarness, layerId: string) => {
  await act(async () => { fireEvent.mouseEnter(within(headerOf(layerId)).getByRole('heading').parentElement!) })
  await h.settle()
  const card = await screen.findByRole('tooltip')
  return card
}
const closeCard = async (h: TraceCanvasHarness, layerId: string) => {
  await act(async () => { fireEvent.mouseLeave(within(headerOf(layerId)).getByRole('heading').parentElement!) })
  await h.settle()
}

const menu = () => document.querySelector<HTMLElement>('[data-canvas-context-menu]')
const menuItem = (label: string) => [...(menu()?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  .find((b) => b.querySelector('span.block')?.textContent?.trim() === label)
const menuLabels = () => [...(menu()?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  .map((b) => b.querySelector('span.block')?.textContent?.trim()).filter(Boolean)
const openLayerMenu = async (h: TraceCanvasHarness, layerId: string) => {
  await act(async () => { fireEvent.contextMenu(headerOf(layerId)) })
  await h.settle()
}
const closeMenu = async (h: TraceCanvasHarness) => {
  await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
  await h.settle()
}
const openRowMenu = async (h: TraceCanvasHarness, id: string) => {
  await act(async () => { fireEvent.contextMenu(cardBody(id)) })
  await h.settle()
}

/** The picker the map dialog opens: its options, by name, and picking one. */
const picker = () => screen.getByRole('dialog', { name: /^Map the .+ column to (an|another) entity$/ })
const options = () => within(picker()).getAllByRole('option').map((o) => o.textContent)
const pick = async (h: TraceCanvasHarness, name: string) => {
  const option = within(picker()).getAllByRole('option').find((o) => o.querySelector('[data-option-label]')?.textContent === name)
  if (!option) throw new Error(`no option ${name} (there are ${options().join(' | ')})`)
  await act(async () => { fireEvent.mouseDown(option) })
  await h.settle()
}

const toolbarUndo = async (h: TraceCanvasHarness) => {
  await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('[data-toolbar-item="undo"]')!) })
  await h.settle()
}

beforeEach(() => {
  useStagedChangesStore.setState({ changes: [], redoStack: [], past: [], isReviewPanelOpen: false })
  useNotificationStore.setState({ notifications: [] })
  useHierarchyBuilderStore.getState().close()
  usePersonaStore.setState({ mode: 'technical' })
})

describe('mapping a column to an entity — from its card and its menu', () => {
  it('a hand-picked column of one entity: "Map this column to…", only this view — the picker maps it in ONE staged change', async () => {
    const h = await open()
    const card = await openCard(h, 'picked')
    expect(card).toHaveTextContent('Only this view')
    await click(h, within(card).getByRole('button', { name: 'Map this column to…' }))

    // The top-level entities in the view, the one in this column first; nothing inside another.
    expect(options()[0]).toMatch(/^Ops.*In this column/)
    expect(options().map((o) => o!.split(/In |Has /)[0].replace(/(Domain|Term)$/, ''))).toEqual(
      expect.arrayContaining(['Ops', 'Sales', 'Marketing', 'Lab', 'Glossary', 'Archive', 'Finance']))
    expect(options().some((o) => /^(Billing|CRM|Campaigns)/.test(o!))).toBe(false)
    expect(within(picker()).getByText(/its rows are what’s inside it/)).toBeInTheDocument()

    await pick(h, 'Sales')
    expect(layerOf('picked')).toMatchObject({ anchorUrn: 'Sales', name: 'Picked' })
    expect(layout().assignments.Sales).toMatchObject({ layerId: 'picked', inheritsChildren: true })
    expect(staged()).toEqual([expect.objectContaining({ type: 'layer_config', summary: 'Mapped “Picked” to Sales' })])
    // The column is Sales: its rows are what is inside it (Ops stays, placed there by hand).
    expect(document.getElementById('layer-node-Sales')).toBeNull()
    expect(columnOfCard('CRM')).toBe('picked')
    expect(columnOfCard('Ops')).toBe('picked')
    const done = notice(/^Mapped “Picked” to Sales/)!
    expect(done.message).toBe('Mapped “Picked” to Sales — its rows are what’s inside Sales. Only this view — the data is unchanged.')

    // Undo takes back just that.
    await press(h, done, 'Undo')
    expect(layerOf('picked')?.anchorUrn).toBeUndefined()
    expect(layout().assignments.Sales).toMatchObject({ layerId: 'domains' })
    expect(columnOfCard('Sales')).toBe('domains')
    expect(staged()).toEqual([])
  }, 30000)

  it('a mapped column shows its entity as a row, maps again, and maps to another — each one change, each Undo only itself', async () => {
    const h = await open()
    let card = await openCard(h, 'fin')
    expect(within(card).getByRole('button', { name: 'Map to another entity…' })).toBeInTheDocument()
    await click(h, within(card).getByRole('button', { name: 'Show Finance as a row' }))
    expect(layerOf('fin')?.anchorUrn).toBeUndefined()
    expect(layout().assignments.Finance).toMatchObject({ layerId: 'fin' })
    expect(columnOfCard('Finance')).toBe('fin')
    expect(notice(/^Finance shows as a row now/)?.message)
      .toBe('Finance shows as a row now — the column is no longer mapped to it. Only this view — the data is unchanged.')
    await closeCard(h, 'fin')

    // Its one entity is first in the picker: mapped again.
    card = await openCard(h, 'fin')
    await click(h, within(card).getByRole('button', { name: 'Map this column to…' }))
    expect(options()[0]).toMatch(/^Finance.*In this column/)
    await pick(h, 'Finance')
    expect(layerOf('fin')?.anchorUrn).toBe('Finance')
    expect(document.getElementById('layer-node-Finance')).toBeNull()
    await closeCard(h, 'fin')

    // To another: from the layer menu this time. The entity it was stays in it, as a row.
    await openLayerMenu(h, 'fin')
    expect(menuItem('Show Finance as a row')).toBeTruthy()
    await click(h, menuItem('Map to another entity…')!)
    expect(options().some((o) => /^Finance/.test(o!))).toBe(false)
    await pick(h, 'Marketing')
    expect(layerOf('fin')).toMatchObject({ anchorUrn: 'Marketing', name: 'Marketing', nameFromAnchor: true })
    expect(columnOfCard('Campaigns')).toBe('fin')
    expect(columnOfCard('Finance')).toBe('fin')
    expect(notice(/^Mapped “Finance” to Marketing/)?.message).toBe(
      'Mapped “Finance” to Marketing — its rows are what’s inside Marketing. Finance stays in it as a row. Only this view — the data is unchanged.')
    expect(staged().map((c) => c.type)).toEqual(['layer_config', 'layer_config', 'layer_config'])

    // Undo steps back one mapping at a time.
    await toolbarUndo(h)
    expect(layerOf('fin')).toMatchObject({ anchorUrn: 'Finance', name: 'Finance' })
    expect(columnOfCard('Marketing')).toBe('domains')
    await toolbarUndo(h)
    expect(layerOf('fin')?.anchorUrn).toBeUndefined()
  }, 30000)

  it('is never offered on a column of several entities, or of groups — its card says why; nor on a column of a type', async () => {
    const h = await open()
    let card = await openCard(h, 'pair')
    expect(card).toHaveTextContent('Holds several top-level entities')
    expect(within(card).queryByRole('button', { name: /^Map / })).toBeNull()
    await closeCard(h, 'pair')
    await openLayerMenu(h, 'pair')
    const refused = menuItem('Map this column to…')!
    expect(refused.disabled).toBe(true)
    expect(refused).toHaveTextContent('Holds several top-level entities')
    await closeMenu(h)

    card = await openCard(h, 'grouped')
    expect(card).toHaveTextContent('Holds groups')
    expect(within(card).queryByRole('button', { name: /^Map / })).toBeNull()
    await closeCard(h, 'grouped')

    card = await openCard(h, 'domains')
    expect(within(card).queryByRole('button', { name: /^Map / })).toBeNull()
    await closeCard(h, 'domains')
    await openLayerMenu(h, 'domains')
    expect(menuLabels().some((l) => /^Map /.test(l!))).toBe(false)
  }, 30000)

  it('is not offered outside a draft', async () => {
    const h = await open({ draft: false })
    const card = await openCard(h, 'picked')
    expect(within(card).queryByRole('button', { name: /^Map / })).toBeNull()
    await closeCard(h, 'picked')
    await openLayerMenu(h, 'picked')
    expect(menuLabels().some((l) => /^Map /.test(l!))).toBe(false)
  }, 30000)
})

describe('a column\'s title follows its entity\'s name, until someone names the column', () => {
  it('shows the entity\'s live name, in the reader\'s view — and keeps a name someone chose', async () => {
    const h = await open({ persona: 'business' })
    expect(titleOf('fin')).toBe('Finance')
    act(() => useCanvasStore.getState().updateNode('Finance', { businessLabel: 'Money', properties: { businessLabel: 'Money' } }))
    await h.settle()
    expect(titleOf('fin')).toBe('Money')
    // Mapped to an entity, a column someone named keeps its name.
    expect(titleOf('picked')).toBe('Picked')

    // Renamed, it keeps the name it was given.
    await act(async () => { fireEvent.contextMenu(headerOf('fin')) })
    await h.settle()
    await click(h, menuItem('Rename')!)
    const input = within(headerOf('fin')).getByRole('textbox', { name: 'Rename Money' })
    await act(async () => { fireEvent.change(input, { target: { value: 'Treasury' } }) })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    await h.settle()
    expect(layerOf('fin')).toMatchObject({ name: 'Treasury' })
    expect(layerOf('fin')?.nameFromAnchor).toBeUndefined()
    act(() => useCanvasStore.getState().updateNode('Finance', { businessLabel: 'Cash', properties: { businessLabel: 'Cash' } }))
    await h.settle()
    expect(titleOf('fin')).toBe('Treasury')
  }, 30000)

  it('opening the name and leaving it as it shows changes nothing', async () => {
    const h = await open({ persona: 'business' })
    act(() => useCanvasStore.getState().updateNode('Finance', { businessLabel: 'Money', properties: { businessLabel: 'Money' } }))
    await h.settle()
    await openLayerMenu(h, 'fin')
    await click(h, menuItem('Rename')!)
    await act(async () => { fireEvent.blur(within(headerOf('fin')).getByRole('textbox', { name: 'Rename Money' })) })
    await h.settle()
    expect(staged()).toEqual([])
    expect(layerOf('fin')?.nameFromAnchor).toBe(true)
  }, 30000)
})

describe('a top-level entity\'s own column, from its row', () => {
  it('"Give Sales its own column": a mapped column right after the one it is in — one change, one Undo', async () => {
    const h = await open()
    await openRowMenu(h, 'Sales')
    const item = menuItem('Give Sales its own column')!
    expect(item).toHaveTextContent('Only this view')
    await click(h, item)

    const ids = columnIds()
    expect(ids.slice(0, 2)).toEqual(['fin', 'domains'])
    const added = ids[2]!
    expect(ids.slice(3)).toEqual(['picked', 'pair', 'grouped'])
    expect(layerOf(added)).toMatchObject({ name: 'Sales', anchorUrn: 'Sales', nameFromAnchor: true, entityTypes: [] })
    expect(layout().assignments.Sales).toMatchObject({ layerId: added, inheritsChildren: true })
    expect(columnOfCard('CRM')).toBe(added)
    expect(titleOf(added)).toBe('Sales')
    expect(staged()).toEqual([expect.objectContaining({ type: 'layer_config', summary: 'Gave Sales its own column' })])
    const done = notice(/^Sales has its own column now/)!
    expect(done.message).toBe('Sales has its own column now, next to Domains. Only this view — the data is unchanged.')

    await press(h, done, 'Undo')
    expect(columnIds()).toEqual(['fin', 'domains', 'picked', 'pair', 'grouped'])
    expect(columnOfCard('Sales')).toBe('domains')
    expect(staged()).toEqual([])
  }, 30000)

  it('is offered only for a top-level entity, and only in a draft', async () => {
    const h = await open()
    await openRowMenu(h, 'Billing')
    expect(menuLabels().some((l) => /its own column$/.test(l!))).toBe(false)
    await closeMenu(h)
  }, 30000)
})

describe('an empty mapped column says what is inside its entity, and how to fill it', () => {
  it('"Nothing inside Ops yet", with "+ Add inside Ops" — the header naming it', async () => {
    const h = await open()
    const card = await openCard(h, 'picked')
    await click(h, within(card).getByRole('button', { name: 'Map this column to…' }))
    await pick(h, 'Ops')
    const body = within(bodyOf('picked'))
    expect(body.getByText('Nothing inside Ops yet')).toBeInTheDocument()
    expect(titleOf('picked')).toBe('Picked')
    await click(h, body.getByRole('button', { name: 'Add inside Ops' }))
    expect(useHierarchyBuilderStore.getState()).toMatchObject({ isOpen: true, parentUrn: 'Ops', layerId: 'picked' })
  }, 30000)

  it('one whose type holds nothing says so, and offers the entity as a row instead', async () => {
    const h = await open()
    await openRowMenu(h, 'Glossary')
    await click(h, menuItem('Give Glossary its own column')!)
    const added = columnIds()[4]!
    const body = within(bodyOf(added))
    expect(body.getByText('Nothing inside Glossary')).toBeInTheDocument()
    expect(body.getByText('A Term holds nothing, so this column stays empty.')).toBeInTheDocument()
    expect(body.queryByRole('button', { name: /^Add inside/ })).toBeNull()
    expect(titleOf(added)).toBe('Glossary')
    await click(h, body.getByRole('button', { name: 'Show Glossary as a row' }))
    expect(layerOf(added)?.anchorUrn).toBeUndefined()
    expect(columnOfCard('Glossary')).toBe(added)
  }, 30000)

  it('a column whose entity is gone says to delete it or map it to another — and maps from there', async () => {
    const h = await open()
    // An entity gone is only said once the canvas has finished loading.
    act(() => useCanvasStore.setState({ hydrationStatus: 'ready' }))
    act(() => useCanvasStore.getState().removeNode('Ops'))
    await h.settle()
    const card = await openCard(h, 'picked')
    await click(h, within(card).getByRole('button', { name: 'Map this column to…' }))
    await pick(h, 'Lab')
    act(() => useCanvasStore.getState().removeNode('Lab'))
    await h.settle()
    await closeCard(h, 'picked')
    const body = within(bodyOf('picked'))
    expect(body.getByText('This column’s entity is gone')).toBeInTheDocument()
    expect(body.getByText(/Delete the column, or map it to another entity\./)).toBeInTheDocument()
    await click(h, body.getByRole('button', { name: 'Map to another entity…' }))
    await pick(h, 'Marketing')
    expect(layerOf('picked')?.anchorUrn).toBe('Marketing')
  }, 30000)
})

describe('the first entity added to an empty hand-picked column is offered the column', () => {
  const addNamed = async (h: TraceCanvasHarness, name: string) => {
    const input = screen.getByPlaceholderText('Enter display name...')
    await act(async () => { fireEvent.change(input, { target: { value: name } }) })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })
    await h.settle()
  }
  /** A new, empty, hand-picked column after Grouped, and the builder open on it. */
  const emptyColumn = async (h: TraceCanvasHarness) => {
    await openLayerMenu(h, 'grouped')
    await click(h, menuItem('Insert layer to the right')!)
    const id = columnIds()[5]!
    await act(async () => { fireEvent.keyDown(within(headerOf(id)).getByRole('textbox'), { key: 'Escape' }) })
    await h.settle()
    await click(h, within(headerOf(id)).getByRole('button', { name: /^Add entity to / }))
    return id
  }
  const createOf = (name: string) =>
    staged().find((c) => c.type === 'create_entity' && (c.after as { displayName?: string }).displayName === name)!

  it('"Make this column Treasury" — one click, never automatic; the column then names it and is empty', async () => {
    const h = await open()
    const id = await emptyColumn(h)
    await addNamed(h, 'Treasury')
    const temp = createOf('Treasury').targetUrn!
    // Nothing is mapped until the reader says so.
    expect(layerOf(id)?.anchorUrn).toBeUndefined()
    const offer = notice(/^Added Treasury to /)!
    expect(offer.message).toBe('Added Treasury to New layer — the column can be Treasury itself, showing what’s inside it.')
    expect(offer.detail).toBe('Only this view — the data is unchanged.')
    expect([offer.action?.label, offer.secondaryAction?.label]).toEqual(['Make this column Treasury', 'Keep it a row'])

    await press(h, offer, 'Make this column Treasury')
    expect(layerOf(id)).toMatchObject({ anchorUrn: temp, name: 'Treasury', nameFromAnchor: true })
    expect(titleOf(id)).toBe('Treasury')
    expect(within(bodyOf(id)).getByText('Nothing inside Treasury yet')).toBeInTheDocument()
    // A second entity in that column is not offered it.
    act(() => useHierarchyBuilderStore.getState().close())
    await h.settle()
    useNotificationStore.setState({ notifications: [] })
    await click(h, within(headerOf('picked')).getByRole('button', { name: /^Add entity to / }))
    await addNamed(h, 'Reserve')
    expect(notice(/^Added Reserve to /)).toBeUndefined()
  }, 30000)

  it('a column mapped to a new entity lets go of it when the create is discarded — with it', async () => {
    const h = await open()
    const id = await emptyColumn(h)
    await addNamed(h, 'Treasury')
    await press(h, notice(/^Added Treasury to /), 'Make this column Treasury')
    act(() => useStagedChangesStore.getState().discard(createOf('Treasury').id))
    await h.settle()
    expect(layerOf(id)?.anchorUrn).toBeUndefined()
    expect(layerOf(id)?.name).toBe('New layer')
    // The mapping went with the create: only the column's own insert is left.
    expect(staged().map((c) => c.summary)).toEqual(['Inserted layer “New layer”'])
    expect(within(bodyOf(id)).queryByText(/entity is gone/)).toBeNull()
  }, 30000)

  it('a column mapped to a new entity is mapped to its saved urn after Save', async () => {
    // A draft of a data source's graph, which gives a new entity its urn when it is saved.
    let temp = ''
    const h = await open({
      dataSourceId: 'harness-ds',
      answer: (url) => url.includes('/drafts-policy') ? { effective: { selfMerge: true } }
        : url.includes('/graph/changes') ? { commitId: 'c1', assigned: { [temp]: 'urn:li:domain:treasury' } }
          : undefined,
    })
    act(() => useBranchStore.setState({ graphId: 'harness-graph' } as never))
    await h.settle()
    const id = await emptyColumn(h)
    await addNamed(h, 'Treasury')
    temp = createOf('Treasury').targetUrn!
    await press(h, notice(/^Added Treasury to /), 'Make this column Treasury')
    act(() => useHierarchyBuilderStore.getState().close())
    await h.settle()

    // The harness's server keeps no layout — the canvas reads the view back from it after a save —
    // so what the save made of the view's layout is read as it was written.
    const written: Array<ReturnType<typeof layout>> = []
    const unsubscribe = useSchemaStore.subscribe(() => { written.push(layout()) })
    try {
      await click(h, screen.getByRole('button', { name: /^Review & Save/ }))
      await click(h, screen.getByRole('button', { name: /^Save \d+ changes?$/ }))
    } finally {
      unsubscribe()
    }
    expect(notice(/^Saved to draft\.$/)).toBeTruthy()
    const saved = written.find((l) => l.layers.some((x) => x.id === id && x.anchorUrn !== temp))
    expect(saved?.layers.find((l) => l.id === id)?.anchorUrn).toBe('urn:li:domain:treasury')
    expect(saved?.assignments['urn:li:domain:treasury']).toMatchObject({ layerId: id })
    expect(saved?.assignments[temp]).toBeUndefined()
  }, 30000)
})

describe('moving a mapped column\'s entity to another column takes the mapping with it', () => {
  // Vault has 3 entities inside it that the canvas has not loaded: its column draws it as a row.
  it('a header drop: the column lets go of it in the same change — no "another column holds it"', async () => {
    const h = await open({ vault: true })
    expect(columnOfCard('Vault')).toBe('vault')
    const carrying = {
      types: ['text/x-entity-id', 'text/x-entity-name'],
      getData: (k: string) => (k === 'text/x-entity-id' || k === 'text/x-entity-name' ? 'Vault' : ''),
      setData: () => {}, setDragImage: () => {}, dropEffect: 'move', effectAllowed: 'move',
    }
    await act(async () => { fireEvent.dragStart(cardBody('Vault'), { dataTransfer: carrying }) })
    await act(async () => { fireEvent.dragOver(headerOf('picked'), { dataTransfer: carrying, clientY: 20 }) })
    await act(async () => { fireEvent.drop(headerOf('picked'), { dataTransfer: carrying, clientY: 20 }) })
    await act(async () => { if (document.getElementById('layer-node-Vault')) fireEvent.dragEnd(cardBody('Vault')) })
    await h.settle()

    expect(columnOfCard('Vault')).toBe('picked')
    expect(layerOf('vault')?.anchorUrn).toBeUndefined()
    expect(within(bodyOf('vault')).queryByText('Another column holds this entity')).toBeNull()
    expect(staged()).toEqual([expect.objectContaining({ type: 'assign_layer' })])
    const moved = notice(/^Vault now shows in Picked/)!
    expect(moved.message).toBe('Vault now shows in Picked. The Vault column is no longer mapped to it. Only this view — the data is unchanged.')

    await press(h, moved, 'Undo')
    expect(layerOf('vault')?.anchorUrn).toBe('Vault')
    expect(layout().assignments.Vault).toMatchObject({ layerId: 'vault' })
  }, 30000)

  it('moved under another parent — a data change — it stays its column\'s, and the column stays mapped', async () => {
    // Here a Domain may sit inside another.
    const h = await open({ vault: true, entityTypes: [ontologyType('domain', 'Domain', ['app', 'domain'], [], 0), ...ONTOLOGY.slice(1)] })
    const carrying = {
      types: ['text/x-entity-id', 'text/x-entity-name'],
      getData: (k: string) => (k === 'text/x-entity-id' || k === 'text/x-entity-name' ? 'Vault' : ''),
      setData: () => {}, setDragImage: () => {}, dropEffect: 'move', effectAllowed: 'move',
    }
    await act(async () => { fireEvent.dragStart(cardBody('Vault'), { dataTransfer: carrying }) })
    await act(async () => { fireEvent.dragOver(cardBody('Sales'), { dataTransfer: carrying, clientY: 20 }) })
    await act(async () => { fireEvent.drop(cardBody('Sales'), { dataTransfer: carrying, clientY: 20 }) })
    await act(async () => { if (document.getElementById('layer-node-Vault')) fireEvent.dragEnd(cardBody('Vault')) })
    await h.settle()

    expect(staged().map((c) => c.type)).toEqual(['move_entity'])
    expect(layout().assignments.Vault).toMatchObject({ layerId: 'vault' })
    expect(layerOf('vault')?.anchorUrn).toBe('Vault')
    expect(columnOfCard('Vault')).toBe('vault')
    expect(notice(/^Moved Vault inside Sales\./)?.message).toBe(
      'Moved Vault inside Sales. A data change — every view that shows it, once published. It keeps its own column, Vault.')
  }, 30000)

  it('Move to Layer does the same', async () => {
    const h = await open({ vault: true })
    await openRowMenu(h, 'Vault')
    await click(h, menuItem('Move to Layer')!)
    const choice = [...document.querySelectorAll<HTMLButtonElement>('[data-move-choice]')]
      .find((b) => b.querySelector('span.block')?.textContent === 'Show in Picked')!
    await click(h, choice)
    expect(columnOfCard('Vault')).toBe('picked')
    expect(layerOf('vault')?.anchorUrn).toBeUndefined()
    await toolbarUndo(h)
    expect(layerOf('vault')?.anchorUrn).toBe('Vault')
    expect(columnOfCard('Vault')).toBe('vault')
  }, 30000)
})
