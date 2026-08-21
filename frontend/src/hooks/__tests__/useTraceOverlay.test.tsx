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

beforeEach(() => countTest())
afterAll(() => expectTestsRan(10))

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

describe('useTraceOverlay — identity', () => {
  it('re-rendering with identical inputs does not rebuild the view', () => {
    const stable = args()
    const { result, rerender } = renderHook((a: UseTraceOverlayArgs) => useTraceOverlay(a), { initialProps: stable })
    const first = result.current.view
    rerender(stable)
    expect(result.current.view).toBe(first)
    // The callbacks are stable too — a canvas passes them straight to rows.
    rerender(stable)
    expect(result.current.view).toBe(first)
  })
})
