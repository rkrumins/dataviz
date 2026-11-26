/**
 * A view's health, on the REAL Context View canvas: when the source changes under a view — an
 * ingestion, another draft published, a sync — the canvas says so once its load is complete, and
 * offers each repair. Nothing changes until the reader chooses:
 *
 *   • placements that point at entities no longer in this source are listed, and cleaned up as ONE
 *     staged change whose Undo puts back only them;
 *   • a column whose entity is gone offers exactly three ways on — map it to another entity, keep
 *     it as a hand-picked column, delete it — and, folded or scrolled out of sight, the status
 *     chips say so;
 *   • top-level entities of the types the view is about that it doesn't place are counted by one
 *     read per load, and offered: a column each, all into one column, or not now — remembered
 *     until the number changes. Never in an open view whose type layers load them anyway.
 *     Only a view meant to show everything (complete) is offered them; a specialised one is
 *     never asked about. One that says neither is asked once, by someone who can edit it, when
 *     it holds every one of them today: keep it complete, or only what's here.
 */
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderCanvasWithTrace, type TraceCanvasHarness } from '@/test/canvasHarness'
import { useCanvasStore } from '@/store/canvas'
import { useAuthStore } from '@/store/auth'
import { usePersonaStore } from '@/store/persona'
import { usePreferencesStore } from '@/store/preferences'
import { useSchemaStore } from '@/store/schema'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useNotificationStore } from '@/components/ui/notifications'
import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'
import type { ViewLayerConfig } from '@/types/schema'
import type { GraphDataProvider, GraphNode, UnplacedTopLevelRequest } from '@/providers/GraphDataProvider'
import { normalizeReferenceLayout } from '@/utils/referenceLayout'

// ── The estate ────────────────────────────────────────────────────────────────
//   Finance ⊃ Billing, Ledger   ← column "Finance", mapped to it
//   Sales, Marketing            ← column "Domains" (of the domain type)
//   Ops                         ← column "Picked", hand-picked
//   Gone1 (in Domains), Gone2 (in Picked) — placed, but not in this source
//   Vanished                    ← column "Vanished", mapped to it: gone from this source
//   a placement on a temp urn (a create discarded before a save) — never reported
const TEMP = 'urn:staged:domain:t1'
const wn = (urn: string, type: string, childCount = 0): LensWalkNode => ({
  id: urn, type: 'default', position: { x: 0, y: 0 },
  data: { urn, label: urn, type, childCount }, urn, displayName: urn, entityType: type,
}) as unknown as LensWalkNode

function healthEstate() {
  const nodes = [
    wn('Finance', 'domain', 2), wn('Billing', 'app'), wn('Ledger', 'app'),
    wn('Sales', 'domain'), wn('Marketing', 'domain'), wn('Ops', 'domain'),
  ]
  const has = (p: string, c: string) => ({ sourceUrn: p, targetUrn: c })
  const model: LensWalkModel = {
    focusUrn: 'Ops', nodes, lineageEdges: [],
    containmentEdges: [has('Finance', 'Billing'), has('Finance', 'Ledger')],
    upstreamUrns: new Set(), downstreamUrns: new Set(), frontierUp: [], frontierDown: [],
    truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
  }
  const layers: ViewLayerConfig[] = [
    { id: 'fin', name: 'Finance', order: 0, entityTypes: [], anchorUrn: 'Finance', nameFromAnchor: true },
    { id: 'domains', name: 'Domains', order: 1, entityTypes: ['domain'] },
    { id: 'picked', name: 'Picked', order: 2, entityTypes: [] },
    { id: 'lost', name: 'Vanished', order: 3, entityTypes: [], anchorUrn: 'Vanished', nameFromAnchor: true },
  ]
  const assignments: Record<string, { layerId: string }> = {
    Finance: { layerId: 'fin' }, Sales: { layerId: 'domains' }, Marketing: { layerId: 'domains' },
    Ops: { layerId: 'picked' }, Gone1: { layerId: 'domains' }, Gone2: { layerId: 'picked' },
    Vanished: { layerId: 'lost' }, [TEMP]: { layerId: 'domains' },
  }
  return { model, layers, assignments }
}

const ontologyType = (id: string, name: string, canContain: string[], canBeContainedBy: string[], level: number) => ({
  id, name, pluralName: `${name}s`, visual: {}, properties: [], fields: [], behavior: {},
  hierarchy: { level, canContain, canBeContainedBy, defaultExpanded: false, rollUpFields: [] },
})
const ONTOLOGY = [ontologyType('domain', 'Domain', ['app'], [], 0), ontologyType('app', 'App', [], ['domain'], 1)]

// The source's top-level Domains: those the view places, and three it doesn't.
const gn = (urn: string): GraphNode => ({ urn, displayName: urn, entityType: 'domain', childCount: 0, properties: {} }) as unknown as GraphNode
let sourceRoots: GraphNode[] = []
let asks: UnplacedTopLevelRequest[] = []
/** The server's answer to the health check's one read: the source's roots of the types asked, less
 *  the placed ones. */
const answeringUnplaced = (p: GraphDataProvider): GraphDataProvider => ({
  ...p,
  getUnplacedTopLevel: async (req: UnplacedTopLevelRequest) => {
    asks.push(req)
    const nodes = sourceRoots
      .filter((n) => req.entityTypes.includes(n.entityType) && !req.placedUrns.includes(n.urn))
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
    const byType: Record<string, number> = {}
    for (const n of nodes) byType[n.entityType] = (byType[n.entityType] ?? 0) + 1
    return { nodes: nodes.slice(0, req.limit ?? 50), byType, totalCount: nodes.length, complete: true }
  },
}) as GraphDataProvider

// What the view's settings saves sent (PUT /views/{id}), answered as the server stores them.
let viewSaves: Array<Record<string, unknown>> = []
const answeringSaves = (url: string, init?: RequestInit) => {
  if (init?.method !== 'PUT' || !/\/api\/v1\/views\/harness-view(\?|$)/.test(url)) return undefined
  const body = JSON.parse(String(init.body)) as Record<string, unknown>
  viewSaves.push(body)
  return { id: 'harness-view', name: 'Harness View', workspaceId: 'harness-ws', viewType: 'reference', visibility: 'private',
           config: { coverage: body.coverage } }
}

const openView = async (opts: { draft?: boolean; entityScope?: 'all' | 'curated'; coverage?: 'complete' | 'specialised' } = {}) => {
  const h = await renderCanvasWithTrace(healthEstate(), {
    focus: 'Ops', draft: opts.draft ?? true, deferTrace: true, entityTypes: ONTOLOGY,
    entityScope: opts.entityScope, wrapProvider: answeringUnplaced, answer: answeringSaves,
  })
  // The ontology's root type, and whether the view is meant to show everything.
  act(() => {
    useSchemaStore.setState((s) => ({ schema: { ...s.schema!, rootEntityTypes: ['domain'] } }) as never)
    if (opts.coverage) useSchemaStore.getState().updateView('harness-view', { coverage: opts.coverage })
  })
  await h.settle()
  return h
}
const open = openView
/** The reader may edit the view (its settings, not only its draft). */
const asEditor = () => act(() => {
  useAuthStore.setState({ permissions: { sid: 's', global: [], ws: { 'harness-ws': ['workspace:view:edit'] } } } as never)
})

/** A load of the view has finished: what it found missing is what it asked for and didn't get. */
const loaded = async (h: TraceCanvasHarness, notFound: string[] = ['Gone1', 'Gone2', 'Vanished']) => {
  act(() => {
    useCanvasStore.setState({ hydrationStatus: 'ready' })
    useCanvasStore.getState().setPlacementsNotFound({ viewId: 'harness-view', urns: notFound })
  })
  await h.settle()
}

// ── Reading the canvas ────────────────────────────────────────────────────────
const columnOfCard = (id: string) =>
  document.getElementById(`layer-node-${id}`)?.closest<HTMLElement>('[data-layer-id].group\\/column')?.dataset.layerId
const columnEl = (layerId: string) => document.querySelector<HTMLElement>(`[data-layer-id="${layerId}"].group\\/column`)!
const bodyOf = (layerId: string) => columnEl(layerId).querySelector<HTMLElement>('.custom-scrollbar')!
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
const picker = () => screen.getByRole('dialog', { name: /^Map the .+ column to (an|another) entity$/ })
const pick = async (h: TraceCanvasHarness, name: string) => {
  const option = within(picker()).getAllByRole('option').find((o) => o.querySelector('[data-option-label]')?.textContent === name)
  if (!option) throw new Error(`no option ${name}`)
  await act(async () => { fireEvent.mouseDown(option) })
  await h.settle()
}

beforeEach(() => {
  sourceRoots = ['Finance', 'Sales', 'Marketing', 'Ops', 'Treasury', 'Legal', 'Research'].map(gn)
  asks = []
  viewSaves = []
  usePreferencesStore.setState({ unplacedRootsDismissed: {}, viewCoverageAsked: {} } as never)
  useAuthStore.setState({ permissions: { sid: '', global: [], ws: {} } } as never)
  // Each test mounts before its view's load has run.
  useCanvasStore.setState({ placementsNotFound: null, hydrationStatus: 'loading' })
  useStagedChangesStore.setState({ changes: [], redoStack: [], past: [], isReviewPanelOpen: false })
  useNotificationStore.setState({ notifications: [] })
  usePersonaStore.setState({ mode: 'technical' })
})

describe('placements that point at entities no longer in this source', () => {
  const chipName = '2 placements point at entities no longer in this source'

  it('says nothing until the load is complete', async () => {
    const h = await open()
    act(() => {
      useCanvasStore.setState({ hydrationStatus: 'loading' })
      useCanvasStore.getState().setPlacementsNotFound({ viewId: 'harness-view', urns: ['Gone1', 'Gone2'] })
    })
    await h.settle()
    expect(screen.queryByRole('button', { name: chipName })).toBeNull()
  }, 30000)

  it('lists them — never a temp urn, nor a column’s own entity — and cleans them up as ONE change whose Undo puts back only them', async () => {
    const h = await open()
    await loaded(h, ['Gone1', 'Gone2', 'Vanished', TEMP])
    await click(h, screen.getByRole('button', { name: chipName }))
    const sheet = screen.getByText('Placed here, but not in this source').parentElement!
    expect(within(sheet).getByText('Gone1')).toBeInTheDocument()
    expect(within(sheet).getByText('Gone2')).toBeInTheDocument()
    expect(within(sheet).queryByText('Vanished')).toBeNull()

    await click(h, screen.getByRole('button', { name: 'Clean them up' }))
    expect(layout().assignments.Gone1).toBeUndefined()
    expect(layout().assignments.Gone2).toBeUndefined()
    // The column whose entity is gone says so itself; a temp urn's placement is a save's to drop.
    expect(layout().assignments.Vanished).toMatchObject({ layerId: 'lost' })
    expect(layout().assignments[TEMP]).toMatchObject({ layerId: 'domains' })
    expect(staged()).toEqual([expect.objectContaining({
      type: 'layer_config', summary: 'Removed 2 placements that pointed at entities no longer in this source',
    })])
    const done = notice(/^Removed 2 placements/)!
    expect(done.message).toBe('Removed 2 placements that pointed at entities no longer in this source. Only this view — the data is unchanged.')
    expect(screen.queryByRole('button', { name: chipName })).toBeNull()

    // A later change stays when the clean-up is taken back.
    await click(h, within(bodyOf('lost')).getByRole('button', { name: 'Map to another entity…' }))
    await pick(h, 'Ops')
    expect(layerOf('lost')?.anchorUrn).toBe('Ops')
    await press(h, done, 'Undo')
    expect(layout().assignments.Gone1).toMatchObject({ layerId: 'domains' })
    expect(layout().assignments.Gone2).toMatchObject({ layerId: 'picked' })
    expect(layerOf('lost')?.anchorUrn).toBe('Ops')
    expect(staged().map((c) => c.summary)).toEqual(['Mapped “Vanished” to Ops'])
  }, 30000)

  it('outside a draft, cleaning up is not offered', async () => {
    const h = await open({ draft: false })
    await loaded(h)
    await click(h, screen.getByRole('button', { name: chipName }))
    expect(screen.queryByRole('button', { name: 'Clean them up' })).toBeNull()
  }, 30000)
})

describe('a column whose entity is no longer in this source', () => {
  const actions = (layerId: string) => within(bodyOf(layerId)).queryAllByRole('button').map((b) => b.textContent)

  it('says so, and offers exactly: map to another entity, show as a hand-picked column, delete the column', async () => {
    const h = await open()
    await loaded(h)
    const body = within(bodyOf('lost'))
    expect(body.getByText('This column’s entity is gone')).toBeInTheDocument()
    expect(body.getByText(
      'This source doesn’t hold it now, so there is nothing to show here. Map the column to another entity, keep it as a hand-picked column, or delete it.',
    )).toBeInTheDocument()
    expect(actions('lost')).toEqual(['Map to another entity…', 'Show as a hand-picked column', 'Delete the column'])
  }, 30000)

  it('"Show as a hand-picked column" lets go of the entity, keeping the column’s name — one change', async () => {
    const h = await open()
    await loaded(h)
    await click(h, within(bodyOf('lost')).getByRole('button', { name: 'Show as a hand-picked column' }))
    expect(layerOf('lost')?.anchorUrn).toBeUndefined()
    expect(layerOf('lost')?.name).toBe('Vanished')
    // Its entity's placement stays — now listed with the others that point at nothing here.
    expect(layout().assignments.Vanished).toMatchObject({ layerId: 'lost' })
    expect(screen.getByRole('button', { name: '3 placements point at entities no longer in this source' })).toBeInTheDocument()
    expect(staged()).toEqual([expect.objectContaining({ type: 'layer_config', summary: 'Made “Vanished” a hand-picked column' })])
    const done = notice(/^“Vanished” is a hand-picked column now/)!
    expect(done.message).toBe('“Vanished” is a hand-picked column now. Only this view — the data is unchanged.')
    await press(h, done, 'Undo')
    expect(layerOf('lost')?.anchorUrn).toBe('Vanished')
  }, 30000)

  it('"Delete the column" asks first — there is nothing in it — and takes its entity’s placement with it, and undoes', async () => {
    const h = await open()
    await loaded(h)
    await click(h, within(bodyOf('lost')).getByRole('button', { name: 'Delete the column' }))
    // The same dialog as every column's delete: its gone entity is not counted as a hand placement.
    const dialog = screen.getByRole('dialog', { name: /Delete the Vanished column/ })
    expect(dialog).toHaveTextContent('Nothing is in it — only the column goes.')
    await click(h, within(dialog).getByRole('button', { name: 'Delete column' }))
    expect(layerOf('lost')).toBeUndefined()
    // Nothing is left to show of it: its placement is not moved into another column.
    expect(layout().assignments.Vanished).toBeUndefined()
    const done = notice(/^Removed the Vanished column/)!
    await press(h, done, 'Undo')
    expect(layerOf('lost')?.anchorUrn).toBe('Vanished')
    expect(layout().assignments.Vanished).toMatchObject({ layerId: 'lost' })
  }, 30000)

  it('outside a draft it offers nothing to do', async () => {
    const h = await open({ draft: false })
    await loaded(h)
    expect(within(bodyOf('lost')).getByText('This column’s entity is gone')).toBeInTheDocument()
    expect(actions('lost')).toEqual([])
  }, 30000)

  it('scrolled out of sight, the status chips say so — and "Show" brings it into view', async () => {
    const h = await open()
    await loaded(h)
    const chip = () => screen.queryByText('The Vanished column’s entity is gone')
    // On screen, its own column says it.
    expect(chip()).toBeNull()
    // Off to the right of the canvas.
    const real = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const r = real.call(this)
      return (this as HTMLElement).dataset?.layerId === 'lost' && this.classList.contains('group/column')
        ? { ...r, left: 5000, right: 5420, x: 5000, toJSON: () => ({}) } as DOMRect
        : r
    }
    try {
      const scroller = columnEl('lost').closest<HTMLElement>('.overflow-auto') ?? columnEl('lost').parentElement!
      await act(async () => { fireEvent.scroll(scroller) })
      await h.settle()
      expect(chip()).toBeInTheDocument()
      let revealed = false
      const into = Element.prototype.scrollIntoView
      Element.prototype.scrollIntoView = function (this: Element) { if (this === columnEl('lost')) revealed = true }
      try {
        await click(h, screen.getByRole('button', { name: 'Show the Vanished column' }))
      } finally {
        Element.prototype.scrollIntoView = into
      }
      expect(revealed).toBe(true)
    } finally {
      Element.prototype.getBoundingClientRect = real
    }
  }, 30000)
})

describe('top-level entities this view doesn’t place', () => {
  const chip = (n = 3) => screen.queryByRole('button', { name: `${n} Domains aren’t in this view` })
  // A view meant to show everything: the one that is offered them.
  const open = (opts: Parameters<typeof openView>[0] = {}) => openView({ coverage: 'complete', ...opts })

  it('a curated view: ONE read per load, of the root types it is about and the entities it places of them', async () => {
    const h = await open()
    await loaded(h)
    expect(asks).toEqual([{ entityTypes: ['domain'], placedUrns: ['Finance', 'Marketing', 'Ops', 'Sales'], limit: 200 }])
    expect(chip()).toBeInTheDocument()
    // Nothing on the canvas asks again — not a render, not an edit.
    await click(h, within(bodyOf('lost')).getByRole('button', { name: 'Show as a hand-picked column' }))
    expect(asks).toHaveLength(1)
    // The next load does.
    await loaded(h)
    expect(asks).toHaveLength(2)
  }, 30000)

  it('says nothing, and asks nothing, while the load is incomplete', async () => {
    const h = await open()
    act(() => {
      useCanvasStore.setState({ hydrationStatus: 'loading' })
      useCanvasStore.getState().setPlacementsNotFound({ viewId: 'harness-view', urns: [] })
    })
    await h.settle()
    expect(asks).toHaveLength(0)
    expect(chip()).toBeNull()
  }, 30000)

  it('an open view whose type layers load every Domain asks nothing, and says nothing', async () => {
    const h = await open({ entityScope: 'all' })
    await loaded(h)
    expect(asks).toHaveLength(0)
    expect(chip()).toBeNull()
  }, 30000)

  it('"Add each as a column": a column mapped to each, as ONE change — undone in one step', async () => {
    const h = await open()
    await loaded(h)
    await click(h, chip()!)
    await click(h, screen.getByRole('button', { name: 'Add each as a column' }))
    const added = layout().layers.filter((l) => ['Legal', 'Research', 'Treasury'].includes(l.anchorUrn ?? ''))
    expect(added.map((l) => [l.anchorUrn, l.name, l.nameFromAnchor])).toEqual([
      ['Legal', 'Legal', true], ['Research', 'Research', true], ['Treasury', 'Treasury', true],
    ])
    for (const l of added) {
      expect(layout().assignments[l.anchorUrn!]).toMatchObject({ layerId: l.id, inheritsChildren: true })
      // Its entity is on the canvas: the column is it, not a column whose entity is gone.
      expect(within(bodyOf(l.id)).queryByText(/entity is gone/)).toBeNull()
    }
    expect(staged()).toEqual([expect.objectContaining({ type: 'layer_config', summary: 'Added 3 Domains as columns' })])
    const done = notice(/^Added 3 Domains as columns/)!
    expect(done.message).toBe('Added 3 Domains as columns — each shows what’s inside it. Only this view — the data is unchanged.')
    expect(chip()).toBeNull()

    await press(h, done, 'Undo')
    expect(layout().layers.some((l) => ['Legal', 'Research', 'Treasury'].includes(l.anchorUrn ?? ''))).toBe(false)
    expect(layout().assignments.Treasury).toBeUndefined()
    expect(chip()).toBeInTheDocument()
  }, 30000)

  it('"Add them to ‹column›": placed in the column chosen, the one for their type first — as ONE change', async () => {
    const h = await open()
    await loaded(h)
    await click(h, chip()!)
    expect(within(screen.getByRole('combobox', { name: 'Column' })).getAllByRole('option').map((o) => o.textContent))
      .toEqual(['Domains', 'Picked'])
    await click(h, screen.getByRole('button', { name: 'Add them to Domains' }))
    for (const urn of ['Legal', 'Research', 'Treasury']) {
      expect(layout().assignments[urn]).toMatchObject({ layerId: 'domains' })
      expect(columnOfCard(urn)).toBe('domains')
    }
    expect(staged()).toEqual([expect.objectContaining({ type: 'layer_config', summary: 'Added 3 Domains to “Domains”' })])
    expect(notice(/^Added 3 Domains to “Domains”/)!.message).toBe('Added 3 Domains to “Domains”. Only this view — the data is unchanged.')
    expect(chip()).toBeNull()
  }, 30000)

  it('"Not now" is remembered for this view until the number changes', async () => {
    const h = await open()
    await loaded(h)
    await click(h, chip()!)
    await click(h, screen.getByRole('button', { name: 'Not now' }))
    expect(chip()).toBeNull()
    expect(usePreferencesStore.getState().unplacedRootsDismissed).toEqual({ 'harness-view': 3 })
    expect(staged()).toEqual([])
    // The next load finds the same three: still not now.
    await loaded(h)
    expect(asks).toHaveLength(2)
    expect(chip()).toBeNull()
    // A fourth arrives: said again.
    sourceRoots.push(gn('Audit'))
    await loaded(h)
    expect(chip(4)).toBeInTheDocument()
  }, 30000)

  it('outside a draft, to a reader who could not open one, it says nothing', async () => {
    const h = await open({ draft: false })
    await loaded(h)
    expect(chip()).toBeNull()
  }, 30000)
})

describe('whether the view is offered new top-level entities', () => {
  const offer = () => screen.queryByRole('button', { name: /Domains? (aren’t|isn’t) in this view/ })
  const question = () => screen.queryByRole('button', { name: 'Keep this view complete?' })
  const SHOWS_EVERYTHING = 'This view shows everything in this source.'
  /** The source holds only the Domains the view places: it shows every one of them today. */
  const holdsEveryRoot = () => { sourceRoots = ['Finance', 'Sales', 'Marketing', 'Ops'].map(gn) }

  it('a specialised view: no read, and nothing said', async () => {
    asEditor()
    const h = await open({ coverage: 'specialised' })
    await loaded(h)
    expect(asks).toHaveLength(0)
    expect(offer()).toBeNull()
    expect(question()).toBeNull()
  }, 30000)

  it('a view that never said, to a reader who cannot edit it: no read, and nothing said', async () => {
    const h = await open()
    await loaded(h)
    expect(asks).toHaveLength(0)
    expect(offer()).toBeNull()
    expect(question()).toBeNull()
  }, 30000)

  it('a view that never said, to an editor, leaving some out: one read, and nothing said — it is specialised', async () => {
    asEditor()
    const h = await open()
    await loaded(h)
    expect(asks).toHaveLength(1)
    expect(offer()).toBeNull()
    expect(question()).toBeNull()
    expect(viewSaves).toEqual([])
  }, 30000)

  it('a view that never said, to an editor, holding every one: asked once — “Keep it complete” says so on the view', async () => {
    holdsEveryRoot()
    asEditor()
    const h = await open()
    await loaded(h)
    expect(asks).toHaveLength(1)
    expect(offer()).toBeNull()
    await click(h, question()!)
    expect(screen.getByText(SHOWS_EVERYTHING)).toBeInTheDocument()
    expect(screen.getByText('Keep it complete as new top-level entities arrive?')).toBeInTheDocument()
    // Nothing is written until a choice is made.
    expect(viewSaves).toEqual([])

    await click(h, screen.getByRole('button', { name: 'Keep it complete' }))
    expect(viewSaves).toEqual([{ coverage: 'complete' }])
    expect(useSchemaStore.getState().getActiveView()?.coverage).toBe('complete')
    expect(question()).toBeNull()
    expect(staged()).toEqual([])

    // The next load: a complete view, holding every one — nothing to offer, and nothing to ask.
    await loaded(h)
    expect(asks).toHaveLength(2)
    expect(question()).toBeNull()
    expect(offer()).toBeNull()
  }, 30000)

  it('“No, only what’s here” makes it specialised: never read for again', async () => {
    holdsEveryRoot()
    asEditor()
    const h = await open()
    await loaded(h)
    await click(h, question()!)
    await click(h, screen.getByRole('button', { name: 'No, only what’s here' }))
    expect(viewSaves).toEqual([{ coverage: 'specialised' }])
    expect(useSchemaStore.getState().getActiveView()?.coverage).toBe('specialised')
    expect(question()).toBeNull()

    sourceRoots.push(gn('Treasury'))
    await loaded(h)
    expect(asks).toHaveLength(1)
    expect(offer()).toBeNull()
  }, 30000)

  it('is asked once in this browser: opened again, answered or not, it is not asked again', async () => {
    holdsEveryRoot()
    asEditor()
    let h = await open()
    await loaded(h)
    expect(question()).toBeInTheDocument()
    expect(usePreferencesStore.getState().viewCoverageAsked).toEqual({ 'harness-view': true })

    // The page is opened again, onto the view still saying nothing: the question was asked.
    cleanup()
    h = await open()
    await loaded(h)
    expect(question()).toBeNull()
    expect(offer()).toBeNull()

    // Answered before the page is opened again — onto a view that, read from anywhere that
    // dropped it, still says nothing: not asked either.
    cleanup()
    usePreferencesStore.setState({ viewCoverageAsked: {} } as never)
    h = await open()
    await loaded(h)
    await click(h, question()!)
    await click(h, screen.getByRole('button', { name: 'Keep it complete' }))
    cleanup()
    h = await open()
    await loaded(h)
    expect(question()).toBeNull()
    expect(viewSaves).toEqual([{ coverage: 'complete' }])
  }, 30000)
})
