/**
 * ONE COLUMN PER ENTITY, AS THE STORE REALLY HOLDS IT — on the real canvas.
 *
 * The roll-up cells a source keeps are baked for every ancestor-or-self of
 * each end of a flow, so they include a column's own entity against its own
 * rows (snow → int_clean_orders_t2), and a schema against its own tables
 * (INTERMEDIATE_T1 → int_clean_orders_t2). The anchor is never a row, so every
 * row of the column read "1 flow arrives from / leads to entities that are not
 * on the canvas", and the click that should bring them in found nothing to
 * bring. Those cells are each entity summarised against itself: no line, no
 * stub, nothing counted outside. Only a flow whose far end no column holds
 * says so.
 *
 * jsdom gives every row the same box, so the overlay never has room to paint
 * a stub; what the canvas hands the overlay for its stubs is read instead.
 */
import { act, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OffCanvasLineage } from '@/hooks/useEdgeProjection'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { snowflakeColumnEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'
import { useCanvasStore } from '@/store/canvas'
import { usePreferencesStore } from '@/store/preferences'

const overlay = vi.hoisted(() => ({
  offCanvas: undefined as ReadonlyMap<string, OffCanvasLineage> | undefined,
}))
vi.mock('../LineageFlowOverlay', async (original) => {
  const real = await original<typeof import('../LineageFlowOverlay')>()
  return {
    ...real,
    LineageFlowOverlay: (props: Parameters<typeof real.LineageFlowOverlay>[0]) => {
      overlay.offCanvas = props.offCanvasLineage
      return <real.LineageFlowOverlay {...props} />
    },
  }
})

beforeEach(() => {
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
  usePreferencesStore.setState({ showMissingConnectionIndicators: true, externalLineagePreview: false, lineagePortSides: 'direction' } as never)
  overlay.offCanvas = undefined
})

const FLOWS: ReadonlyArray<readonly [string, string]> = [
  ['pg.raw_orders', 'int_clean_orders_t2'],
  ['pg.raw_items', 'int_clean_order_items_t2'],
  ['int_stg_orders_t2', 'int_clean_orders_t2'],     // a row past the schema's page
  ['int_clean_orders_t2', 'gold.fct_orders'],       // into a closed schema
  ['int_clean_order_items_t2', 'gold.dim_items'],
  ['ext', 'int_clean_orders_t2'],                   // held by no column
]

const estate = snowflakeColumnEstate()
const parentOf = new Map(estate.model.containmentEdges.map(c => [c.targetUrn, c.sourceUrn]))
const selfAndUp = (urn: string) => {
  const up = [urn]
  for (let p = parentOf.get(urn); p; p = parentOf.get(p)) up.push(p)
  return up
}

/** The cells a source keeps: one per ancestor-or-self of each end, the two
 *  ends distinct — an entity against its own descendants among them. */
function storedCells() {
  const count = new Map<string, number>()
  for (const [s, t] of FLOWS) {
    for (const sx of selfAndUp(s)) {
      for (const tx of selfAndUp(t)) {
        if (sx !== tx) count.set(`${sx}>${tx}`, (count.get(`${sx}>${tx}`) ?? 0) + 1)
      }
    }
  }
  return [...count].map(([pair, edgeCount]) => {
    const [sourceUrn, targetUrn] = pair.split('>')
    return { id: `agg:${pair}`, sourceUrn, targetUrn, edgeCount, edgeTypes: ['TRANSFORMS'], confidence: 1, sourceEdgeIds: [] }
  })
}

// What the view loaded: both anchors, the Snowflake schemas, and the first
// page of INTERMEDIATE_T1. GOLD is closed; int_stg_orders_t2 is past the page.
const LOADED = new Set(estate.model.nodes.map(n => n.urn)
  .filter(urn => !['int_stg_orders_t2', 'gold.fct_orders', 'gold.dim_items', 'ext'].includes(urn)))

const ROWS = ['GOLD', 'INTERMEDIATE_T1', 'int_clean_order_items_t2', 'int_clean_orders_t2', 'pg.raw_orders', 'pg.raw_items']

function degrees() {
  const out: Record<string, { in: number; out: number; rollupIn: number; rollupOut: number }> = {}
  const at = (urn: string) => (out[urn] ??= { in: 0, out: 0, rollupIn: 0, rollupOut: 0 })
  for (const [s, t] of FLOWS) { at(s).out++; at(t).in++ }
  for (const c of storedCells()) { at(c.sourceUrn).rollupOut = 1; at(c.targetUrn).rollupIn = 1 }
  return out
}

/** `kind:dir` of the card's port on each side, or null for no port. */
function ports(id: string): { left: string | null; right: string | null } {
  const at = (side: 'left' | 'right') => {
    const el = document.getElementById(`layer-node-${id}`)?.querySelector<HTMLElement>(`[data-lineage-port="${side}"]`)
    return el ? `${el.dataset.port}:${el.dataset.dir}` : null
  }
  return { left: at('left'), right: at('right') }
}

/** Flows the canvas placed outside the view, per row, both ways. */
function outside(): Record<string, string> {
  const out: Record<string, string> = {}
  overlay.offCanvas?.forEach((flows, id) => {
    if (flows.in > 0 || flows.out > 0) out[id] = `${flows.in} in, ${flows.out} out`
  })
  return out
}

/** The "N flows outside this view" chip's number, or null with no chip. */
function outsideChip(): string | null {
  const label = screen.queryByText('flows outside this view')
  return label ? label.previousElementSibling?.textContent ?? '' : null
}

async function openView() {
  const cells = storedCells()
  const h = await renderCanvasWithTrace(estate, {
    focus: 'int_clean_orders_t2',
    browseHolds: [...LOADED],
    ancestorChains: true,
    nodeDegrees: degrees(),
    aggregatedCells: cells,
    flows: FLOWS.map(([sourceUrn, targetUrn]) => ({ sourceUrn, targetUrn })),
    // The schema's next page is still out: its rows past the first page
    // stay unloaded, as behind a "10 more".
    holdChildren: ['INTERMEDIATE_T1'],
  })
  // What an untyped /edges/between left in the store: the flows between
  // loaded rows, and every stored cell between loaded entities.
  act(() => {
    useCanvasStore.getState().addGraph([], [
      ...FLOWS.filter(([s, t]) => LOADED.has(s) && LOADED.has(t)).map(([s, t]) => ({
        id: `f:${s}>${t}`, source: s, target: t, type: 'lineage',
        data: { edgeType: 'TRANSFORMS', relationship: 'TRANSFORMS' },
      })),
      ...cells.filter(c => LOADED.has(c.sourceUrn) && LOADED.has(c.targetUrn)).map(c => ({
        id: c.id, source: c.sourceUrn, target: c.targetUrn, type: 'lineage',
        data: { edgeType: 'AGGREGATED', relationship: 'AGGREGATED', isAggregated: true, sourceEdgeCount: c.edgeCount },
      })),
    ] as never)
  })
  await h.toggle('INTERMEDIATE_T1')
  await h.settle()
  await act(async () => { await new Promise(r => setTimeout(r, 2500)) })
  await h.settle()
  return h
}

describe('a Snowflake column whose store holds its own roll-up cells', () => {
  it('opens with no row of the column said to reach outside the view', async () => {
    await openView()

    // Every partner is in the column to the left or in the row's own column:
    // incoming on the left, outgoing on the right, both drawn.
    await waitFor(() => {
      expect(ports('int_clean_orders_t2')).toEqual({ left: 'here:in', right: 'here:out' })
      expect(ports('int_clean_order_items_t2')).toEqual({ left: 'here:in', right: 'here:out' })
      expect(ports('GOLD')).toEqual({ left: 'here:in', right: null })
    }, { timeout: 8000 })

    // Nothing the view opened with leads outside it: no stub, no chip.
    expect(outside()).toEqual({})
    expect(outsideChip()).toBeNull()
  }, 30_000)

  it('selected, a row reads its own flows: the one from no column is outside, and only that one', async () => {
    const h = await openView()

    act(() => { useCanvasStore.getState().selectNode('int_clean_orders_t2') })
    await h.settle()
    await act(async () => { await new Promise(r => setTimeout(r, 2500)) })
    await h.settle()

    for (const id of ROWS) expect(document.getElementById(`layer-node-${id}`), id).not.toBeNull()
    expect(outside()).toEqual({ int_clean_orders_t2: '1 in, 0 out' })
    expect(outsideChip()).toBe('1')
  }, 30_000)
})

describe('a sibling past an open schema\'s page', () => {
  it('selecting a row it flows into brings it in, where a line from the schema used to stand for it', async () => {
    // int_stg_orders_t2 is a child of INTERMEDIATE_T1 its page never
    // brought: named in the Snowflake column, not drawn as the open schema.
    const h = await openView()
    expect(h.visibleCardIds()).not.toContain('int_stg_orders_t2')

    act(() => { useCanvasStore.getState().selectNode('int_clean_orders_t2') })

    await waitFor(() => expect(h.visibleCardIds()).toContain('int_stg_orders_t2'), { timeout: 8000 })
    await h.settle()
    expect(outside()).toEqual({ int_clean_orders_t2: '1 in, 0 out' })
    expect(h.consoleErrors()).toEqual([])
  }, 30_000)
})
