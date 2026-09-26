/**
 * The drawer's Jump-to, on the real canvas: it hears whether the entity was
 * drawn. An entity the store holds but no column draws is 'unavailable', so
 * the drawer says so (LineageNeighbors) instead of pointing at nothing.
 */
import { act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { anchoredPortsEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'
import { useCanvasStore } from '@/store/canvas'

// The drawer itself is not under test: only what the canvas hands it.
const drawer = vi.hoisted(() => ({ jumpTo: undefined as ((id: string) => unknown) | undefined }))
vi.mock('@/components/panels/EntityDrawer', () => {
  const EntityDrawer = (props: { onFocusNode?: (id: string) => unknown }) => {
    drawer.jumpTo = props.onFocusNode
    return null
  }
  return { EntityDrawer, default: EntityDrawer }
})

beforeEach(() => {
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
  drawer.jumpTo = undefined
})

describe('the drawer\'s Jump-to', () => {
  it('says whether the entity was drawn', async () => {
    // `far` is in the store and in no column; SRC.DB_A.t1 is inside a closed row.
    const h = await renderCanvasWithTrace(anchoredPortsEstate(), { focus: 'SRC.raw_orders' })
    act(() => { useCanvasStore.getState().openNodeDrawer('SRC.raw_orders') })
    await waitFor(() => expect(drawer.jumpTo).toBeDefined())

    // A synchronous act, so the rows it opens are drawn by the time the
    // reveal looks, as they are in the browser two frames later.
    const jumpTo = async (id: string): Promise<unknown> => {
      let pending: unknown
      act(() => { pending = drawer.jumpTo!(id) })
      let outcome: unknown
      void (pending as Promise<unknown>).then(o => { outcome = o })
      await waitFor(() => expect(outcome).toBeDefined())
      return outcome
    }

    expect(await jumpTo('far')).toBe('unavailable')
    expect(await jumpTo('SRC.DB_A.t1')).toBe('revealed')
    expect(h.visibleCardIds()).toContain('SRC.DB_A.t1')
  }, 20_000)

  it('brings in a row of an anchored column past its loaded page', async () => {
    // s9 is a row of Staging the view holds but has not loaded. A page walk
    // cannot reach it (it resumes the anchor's pager at its next page); its
    // path can.
    const estate = anchoredPortsEstate()
    const h = await renderCanvasWithTrace(estate, {
      focus: 'SRC.raw_orders',
      browseHolds: estate.model.nodes.map(n => n.urn).filter(urn => urn !== 's9' && urn !== 'far'),
      ancestorChains: true,
    })
    act(() => { useCanvasStore.getState().openNodeDrawer('s2') })
    await waitFor(() => expect(drawer.jumpTo).toBeDefined())
    expect(h.visibleCardIds()).not.toContain('s9')

    let outcome: unknown
    await act(async () => { outcome = await drawer.jumpTo!('s9') })

    expect(outcome).toBe('revealed')
    expect(h.visibleCardIds()).toContain('s9')
  }, 20_000)
})
