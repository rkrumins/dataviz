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
 */
import { act, fireEvent, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { renderCanvasWithTrace, type TraceCanvasHarness } from '@/test/canvasHarness'
import { useCanvasStore } from '@/store/canvas'
import { usePersonaStore } from '@/store/persona'
import { useSchemaStore } from '@/store/schema'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { useNotificationStore } from '@/components/ui/notifications'
import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'
import type { ViewLayerConfig } from '@/types/schema'
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

const open = async (opts: { draft?: boolean } = {}) => {
  const h = await renderCanvasWithTrace(healthEstate(), {
    focus: 'Ops', draft: opts.draft ?? true, deferTrace: true, entityTypes: ONTOLOGY,
  })
  await h.settle()
  return h
}

/** A load of the view has finished: what it found missing is what it asked for and didn't get. */
const loaded = async (h: TraceCanvasHarness, notFound: string[] = ['Gone1', 'Gone2', 'Vanished']) => {
  act(() => {
    useCanvasStore.setState({ hydrationStatus: 'ready' })
    useCanvasStore.getState().setPlacementsNotFound({ viewId: 'harness-view', urns: notFound })
  })
  await h.settle()
}

// ── Reading the canvas ────────────────────────────────────────────────────────
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

  it('"Delete the column" takes its entity’s placement with it, and undoes', async () => {
    const h = await open()
    await loaded(h)
    await click(h, within(bodyOf('lost')).getByRole('button', { name: 'Delete the column' }))
    expect(layerOf('lost')).toBeUndefined()
    // Nothing is left to show of it: its placement is not moved into another column.
    expect(layout().assignments.Vanished).toBeUndefined()
    const done = notice(/^Deleted layer “Vanished”/)!
    expect(done.message).toBe('Deleted layer “Vanished”.')
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
