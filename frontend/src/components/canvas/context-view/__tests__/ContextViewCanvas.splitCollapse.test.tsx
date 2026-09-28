/**
 * COLLAPSING A CONTAINER TAKES ONLY WHAT IT DRAWS.
 *
 * P sits in one column; one child of it is placed in another column, and a
 * nested entity is the anchor of a third. Collapsing P pruned every store
 * descendant, so the child placed elsewhere and the whole anchored column
 * vanished from their own columns, with their lines.
 */
import { act, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { splitChildEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'
import { useCanvasStore } from '@/store/canvas'

beforeEach(() => {
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
})

describe('collapsing a container split across columns', () => {
  it('keeps the child placed in another column and the anchored column under it', async () => {
    const h = await renderCanvasWithTrace(splitChildEstate(), { focus: 'R' })
    expect(h.visibleCardIds().sort()).toEqual(['A.a1', 'P', 'P.C', 'R'])

    await h.toggle('P')
    expect(h.visibleCardIds().sort()).toEqual(['A.a1', 'P', 'P.C', 'P.c1', 'R'])

    await h.toggle('P')
    await h.settle()
    expect(h.visibleCardIds().sort()).toEqual(['A.a1', 'P', 'P.C', 'R'])
    // What P draws is gone from the store; what it does not is still there.
    const held = new Set(useCanvasStore.getState().nodes.map(n => n.id))
    expect(held.has('P.c1')).toBe(false)
    expect(['P.C', 'A', 'A.a1'].every(id => held.has(id))).toBe(true)

    // Opening it again brings back what it draws.
    await h.toggle('P')
    await h.settle()
    expect(h.visibleCardIds().sort()).toEqual(['A.a1', 'P', 'P.C', 'P.c1', 'R'])
  }, 20_000)
})

describe('a collapse clicked while the canvas has an update queued', () => {
  // The chevron's handler read expand-or-collapse from inside its state
  // updater, which React runs at once only when nothing else is queued for
  // the canvas. On a busy canvas (a store write, a page landing) the updater
  // waited for the next render, the handler read "was collapsed", and a
  // collapse ran the EXPAND path: the row closed, but nothing it drew was
  // pruned and no load in flight was cancelled.
  it('still prunes what the container draws', async () => {
    const h = await renderCanvasWithTrace(splitChildEstate(), { focus: 'R' })
    await h.toggle('P')
    expect(h.visibleCardIds()).toContain('P.c1')

    const chevron = document.getElementById('layer-node-P')!.querySelector('button')!
    act(() => {
      useCanvasStore.getState().selectNode('R')
      fireEvent.click(chevron)
    })
    await h.settle()

    expect(h.visibleCardIds()).not.toContain('P.c1')
    expect(useCanvasStore.getState().nodes.some(n => n.id === 'P.c1')).toBe(false)
  }, 20_000)
})
