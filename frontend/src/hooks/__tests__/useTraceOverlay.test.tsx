/**
 * useTraceOverlay — the React glue between a walk model and the pure trace
 * view model. Everything it owns is EXPANSION: what the reader has opened.
 *
 * The seed is the whole point. A trace that lands with the focus buried
 * inside a closed lane root, or with its direct partners hidden inside one,
 * is a trace the reader has to go hunting through — so the seed opens the
 * focus's own chain AND, for every partner one hop from the focus, the hosts
 * between that partner and its lane root. The partners themselves stay
 * CLOSED: R1 says a trace opens the way TO things, never the things
 * themselves.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTraceOverlay, type UseTraceOverlayArgs } from '../useTraceOverlay'
import type { TraceView } from '../lib/traceViewModel'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { emptyWalkModel, type LensWalkModel } from '@/components/canvas/context-view/lens/closure-adapter'
import { countTest, expectTestsRan } from '@/test/canary'
import type { ViewLayerConfig } from '@/types/schema'

const estate = cfoEstate()

const args = (over: Partial<UseTraceOverlayArgs> = {}): UseTraceOverlayArgs => ({
  model: estate.model,
  focusUrn: 'cfo',
  layers: estate.layers,
  assignments: estate.assignments,
  viewIsCurated: true,
  showUpstream: true,
  showDownstream: true,
  depthUp: 25,
  depthDown: 25,
  ...over,
})

const visibleIds = (v: TraceView | null): string[] => [...(v?.visible ?? [])].sort()
const cardOf = (v: TraceView | null, id: string) => {
  for (const lane of v?.lanes ?? []) {
    const card = lane.cards.get(id)
    if (card) return card
  }
  return undefined
}

/** The same walk, one node further along — what a full walk's next wave
 *  looks like: same focus, a bigger model. */
const grownModel = (): LensWalkModel => {
  const base = estate.model
  const extra = {
    ...base.nodes[0],
    id: 'orders.extra', urn: 'orders.extra', displayName: 'orders.extra', entityType: 'schemaField',
    data: { urn: 'orders.extra', label: 'orders.extra', type: 'schemaField', childCount: 0 },
  } as (typeof base.nodes)[number]
  return {
    ...base,
    nodes: [...base.nodes, extra],
    containmentEdges: [...base.containmentEdges, { sourceUrn: 'orders', targetUrn: 'orders.extra' }],
    upstreamUrns: new Set([...base.upstreamUrns, 'orders.extra']),
  }
}

beforeEach(() => countTest())
afterAll(() => expectTestsRan(17))

describe('useTraceOverlay — the seed', () => {
  it('opens the focus chain and leaves the direct partners visible and CLOSED', () => {
    const { result } = renderHook(() => useTraceOverlay(args()))

    expect(result.current.active).toBe(true)
    // tableau ⊃ cfo ⊃ aov is open down to the focus's own contents; the two
    // warehouse containers are lane roots, so they are already on screen.
    expect(visibleIds(result.current.view)).toEqual(['INTERMEDIATE_T2', 'REPORTING', 'aov', 'cfo', 'tableau'])
    expect(cardOf(result.current.view, 'INTERMEDIATE_T2')!.expanded).toBe(false)
    expect(cardOf(result.current.view, 'REPORTING')!.expanded).toBe(false)
    // The partner's own contents stay shut — the chevron is the invitation.
    expect(result.current.view!.visible.has('orders')).toBe(false)
    expect([...result.current.traceExpansion].sort()).toEqual(['cfo', 'tableau'])
  })

  it('opens the HOSTS above a partner when the view anchors the lane above it', () => {
    // The platform is placed, so `snowflake` is the warehouse lane root and
    // the two containers are depth-1 children of a CLOSED root. Seeding only
    // the focus chain would hide both partners behind it.
    const withPlatform = { ...estate.assignments, snowflake: { layerId: 'warehouse' } }
    const { result } = renderHook(() => useTraceOverlay(args({ assignments: withPlatform })))

    expect(visibleIds(result.current.view)).toEqual(['INTERMEDIATE_T2', 'REPORTING', 'aov', 'cfo', 'snowflake', 'tableau'])
    expect(cardOf(result.current.view, 'snowflake')!.expanded).toBe(true)     // a host, opened
    expect(cardOf(result.current.view, 'INTERMEDIATE_T2')!.expanded).toBe(false)  // a partner, closed
    expect(result.current.view!.visible.has('orders')).toBe(false)
  })

  it('seeds the partner hosts of whatever the focus IS — refocusing re-seeds', () => {
    const { result, rerender } = renderHook((a: UseTraceOverlayArgs) => useTraceOverlay(a), { initialProps: args() })
    act(() => result.current.toggle('rpt'))
    expect(result.current.traceExpansion.has('rpt')).toBe(true)

    // Focus the chart inside the dashboard: its own hop-1 partners are the
    // two DATASETS, which live one level down inside the containers — so the
    // containers open and the datasets arrive closed.
    rerender(args({ focusUrn: 'aov' }))
    expect([...result.current.traceExpansion].sort()).toEqual(['INTERMEDIATE_T2', 'REPORTING', 'aov', 'cfo', 'tableau'])
    expect(result.current.traceExpansion.has('rpt')).toBe(false)   // the manual toggle did not survive
    expect(result.current.view!.visible.has('orders')).toBe(true)
    expect(cardOf(result.current.view, 'orders')!.expanded).toBe(false)
    expect(result.current.view!.visible.has('orders.channel')).toBe(false)
  })

  it('is inactive with no model or no focus', () => {
    const { result: noFocus } = renderHook(() => useTraceOverlay(args({ focusUrn: null })))
    expect(noFocus.current.active).toBe(false)
    expect(noFocus.current.view).toBeNull()
    expect(noFocus.current.traceExpansion.size).toBe(0)

    const { result: noModel } = renderHook(() => useTraceOverlay(args({ model: null })))
    expect(noModel.current.active).toBe(false)
    expect(noModel.current.view).toBeNull()
  })
})

describe('useTraceOverlay — expansion', () => {
  it('toggle flips one card and the view follows', () => {
    const { result } = renderHook(() => useTraceOverlay(args()))

    act(() => result.current.toggle('INTERMEDIATE_T2'))
    expect(result.current.view!.visible.has('orders')).toBe(true)
    expect(cardOf(result.current.view, 'INTERMEDIATE_T2')!.expanded).toBe(true)
    expect(result.current.view!.visible.has('orders.channel')).toBe(false)   // one level, closed

    act(() => result.current.toggle('INTERMEDIATE_T2'))
    expect(result.current.view!.visible.has('orders')).toBe(false)
  })

  it('expandPath opens a whole chain at once', () => {
    const { result } = renderHook(() => useTraceOverlay(args()))

    act(() => result.current.expandPath(['INTERMEDIATE_T2', 'orders']))
    expect(result.current.view!.visible.has('orders.channel')).toBe(true)
    expect(result.current.traceExpansion.has('cfo')).toBe(true)   // additive: the seed survives
  })

  it('keeps the reader’s expansion when unrelated args change', () => {
    const { result, rerender } = renderHook((a: UseTraceOverlayArgs) => useTraceOverlay(a), { initialProps: args() })
    act(() => result.current.toggle('INTERMEDIATE_T2'))

    rerender(args({ depthDown: 3, showDownstream: false }))
    expect(result.current.traceExpansion.has('INTERMEDIATE_T2')).toBe(true)
    expect(result.current.view!.visible.has('orders')).toBe(true)
  })

  it('exit clears the expansion', () => {
    const { result, rerender } = renderHook((a: UseTraceOverlayArgs) => useTraceOverlay(a), { initialProps: args() })
    act(() => result.current.toggle('INTERMEDIATE_T2'))

    act(() => result.current.exit())
    rerender(args({ focusUrn: null }))
    expect(result.current.active).toBe(false)
    expect(result.current.view).toBeNull()
    expect(result.current.traceExpansion.size).toBe(0)
  })
})

describe('useTraceOverlay — placement passthrough', () => {
  // An OPEN view with no explicit assignments: `report` claims dashboards by
  // rule, and everything else is placed only by the `showUnassigned` fallback
  // — which is exactly what `placement` carries.
  const openLayers: ViewLayerConfig[] = [
    { id: 'warehouse', name: 'Warehouse', order: 0, entityTypes: [] },
    { id: 'report', name: 'Report', order: 1, entityTypes: ['dashboard'] },
  ]
  const openArgs = (over: Partial<UseTraceOverlayArgs> = {}) =>
    args({ layers: openLayers, assignments: {}, viewIsCurated: false, ...over })

  it('without the fallback the warehouse chain has nowhere to go', () => {
    const { result } = renderHook(() => useTraceOverlay(openArgs()))
    expect(result.current.view!.lanes.map(l => l.layerId)).toEqual(['report'])
    expect(result.current.view!.outsideView).toBe(1)              // one unplaceable chain, under snowflake
    expect(result.current.view!.visible.has('INTERMEDIATE_T2')).toBe(false)
  })

  it('the showUnassigned fallback lands the warehouse containers on the fallback lane', () => {
    const { result } = renderHook(() => useTraceOverlay(openArgs({
      placement: { unassignedFallbackLayerId: 'warehouse' },
    })))
    const view = result.current.view!
    expect(view.outsideView).toBe(0)
    const warehouse = view.lanes.find(l => l.layerId === 'warehouse')!
    // Every chain now anchors at its graph root, both on the fallback lane.
    expect(warehouse.roots.map(r => r.id)).toEqual(['snowflake', 'tableau'])
    expect(warehouse.cards.get('INTERMEDIATE_T2')!.parentId).toBe('snowflake')
    // …and the seed still opens the hosts, so the partners are on screen.
    expect(view.visible.has('INTERMEDIATE_T2')).toBe(true)
    expect(view.visible.has('REPORTING')).toBe(true)
    expect(view.visible.has('cfo')).toBe(true)
  })
})

describe('useTraceOverlay — the seed waits for a model that holds the focus', () => {
  // The canvas sets the focus the instant Trace is pressed; the walk hook
  // answers with a LOADING entry whose model is empty but not null. Seeding
  // off that and latching is how a trace lands with every chain shut.
  it('seeds from the first model that contains the focus, not from the loading one', () => {
    const { result, rerender } = renderHook(
      (a: UseTraceOverlayArgs) => useTraceOverlay(a),
      { initialProps: args({ model: emptyWalkModel('cfo') }) },
    )
    // The loading frame draws NOTHING — the canvas keeps showing browse
    // until the focus lands (see "no blank canvas" below). The seed still
    // provisionally holds the focus, so the latch can tell this frame apart
    // from the real one.
    expect(result.current.active).toBe(false)
    expect(result.current.view).toBeNull()
    expect([...result.current.traceExpansion]).toEqual(['cfo'])

    rerender(args())
    expect(visibleIds(result.current.view)).toEqual(['INTERMEDIATE_T2', 'REPORTING', 'aov', 'cfo', 'tableau'])
    expect([...result.current.traceExpansion].sort()).toEqual(['cfo', 'tableau'])
  })

  it('seeds ONCE: a later wave of the same walk leaves the reader’s expansion alone', () => {
    const { result, rerender } = renderHook(
      (a: UseTraceOverlayArgs) => useTraceOverlay(a),
      { initialProps: args({ model: emptyWalkModel('cfo') }) },
    )
    rerender(args())
    act(() => result.current.toggle('INTERMEDIATE_T2'))
    expect(result.current.view!.visible.has('orders')).toBe(true)

    // The walk grows — same focus, bigger model. Nothing the reader opened
    // may close, and nothing they closed may re-open.
    rerender(args({ model: grownModel() }))
    expect([...result.current.traceExpansion].sort()).toEqual(['INTERMEDIATE_T2', 'cfo', 'tableau'])
    expect(result.current.view!.visible.has('orders')).toBe(true)
    // The wave DID land — the new node is a card, sitting closed inside the
    // dataset the reader has not opened.
    expect(cardOf(result.current.view, 'orders.extra')).toBeDefined()
    expect(result.current.view!.visible.has('orders.extra')).toBe(false)
  })
})

describe('useTraceOverlay — no blank canvas while the walk runs', () => {
  // The walk hook hands back a LOADING entry carrying an EMPTY model, so an
  // overlay that went live on `!!model` would blank every column for the
  // length of the walk and fill them back in when it landed. It goes live
  // only once the model actually CONTAINS the focus.
  it('an empty model is not active and draws nothing', () => {
    const { result } = renderHook(() => useTraceOverlay(args({ model: emptyWalkModel('cfo') })))
    expect(result.current.active).toBe(false)
    expect(result.current.view).toBeNull()
  })

  it('a model that does not hold the focus is not active either', () => {
    // A stale wave for a DIFFERENT focus is not this trace's picture.
    const { result } = renderHook(() => useTraceOverlay(args({ focusUrn: 'nobody' })))
    expect(result.current.active).toBe(false)
    expect(result.current.view).toBeNull()
  })

  it('goes live on the wave that brings the focus, and seeds then', () => {
    const { result, rerender } = renderHook(
      (a: UseTraceOverlayArgs) => useTraceOverlay(a),
      { initialProps: args({ model: emptyWalkModel('cfo') }) },
    )
    expect(result.current.active).toBe(false)

    rerender(args())
    expect(result.current.active).toBe(true)
    expect(result.current.view).not.toBeNull()
    // The seed ran against the REAL model, not the empty one it latched on.
    expect([...result.current.traceExpansion].sort()).toEqual(['cfo', 'tableau'])
  })

  it('no focus at all: inactive', () => {
    const { result } = renderHook(() => useTraceOverlay(args({ focusUrn: null })))
    expect(result.current.active).toBe(false)
    expect(result.current.view).toBeNull()
  })
})

describe('useTraceOverlay — revealPath', () => {
  it('returns the containment chain to a buried card, nearest first, excluding itself', () => {
    const { result } = renderHook(() => useTraceOverlay(args()))
    // orders.channel sits INTERMEDIATE_T2 ⊃ orders ⊃ orders.channel.
    expect(result.current.revealPath('orders.channel')).toEqual(['orders', 'INTERMEDIATE_T2'])
  })

  it('a lane root, an unknown urn and an inactive overlay all open nothing', () => {
    const { result } = renderHook(() => useTraceOverlay(args()))
    expect(result.current.revealPath('INTERMEDIATE_T2')).toEqual([])
    expect(result.current.revealPath('not-in-this-trace')).toEqual([])

    const idle = renderHook(() => useTraceOverlay(args({ model: emptyWalkModel('cfo') })))
    expect(idle.result.current.revealPath('orders.channel')).toEqual([])
  })

  it('feeding it to expandPath is what puts the card on screen', () => {
    const { result } = renderHook(() => useTraceOverlay(args()))
    expect(result.current.view!.visible.has('orders.channel')).toBe(false)
    act(() => result.current.expandPath(result.current.revealPath('orders.channel')))
    expect(result.current.view!.visible.has('orders.channel')).toBe(true)
  })
})

describe('useTraceOverlay — identity', () => {
  it('a fresh args object with identical fields rebuilds nothing', () => {
    const { result, rerender } = renderHook((a: UseTraceOverlayArgs) => useTraceOverlay(a), { initialProps: args() })
    const first = result.current
    // A NEW object every time — exactly what a canvas passes on every render.
    rerender(args())
    expect(result.current.view).toBe(first.view)
    rerender(args())
    expect(result.current.view).toBe(first.view)
    // The callbacks are stable too: a canvas hands them straight to every row,
    // and a new identity there re-renders the whole tree.
    expect(result.current.toggle).toBe(first.toggle)
    expect(result.current.expandPath).toBe(first.expandPath)
    expect(result.current.exit).toBe(first.exit)
    expect(result.current.revealPath).toBe(first.revealPath)
  })
})
