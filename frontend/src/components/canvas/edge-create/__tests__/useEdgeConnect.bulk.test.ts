/**
 * useEdgeConnect — a drag from a card that is part of a selection carries the
 * whole selection; one card dropped on a selected card links into the whole
 * selection. Both hand off to onBulkDrop. A drag between two unselected cards
 * is the plain one-to-one link it always was.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEdgeConnect } from '../useEdgeConnect'

const SELECTION = ['a', 'b', 'c']
const groupOf = (id: string) => (SELECTION.includes(id) ? SELECTION : null)

// The card under the pointer, as the DOM would report it.
let under: string | null = null
beforeEach(() => {
  under = null
  document.elementFromPoint = vi.fn(() => {
    if (!under) return null
    const el = document.createElement('div')
    el.id = `layer-node-${under}`
    return el
  }) as never
})
afterEach(() => vi.restoreAllMocks())

function setup() {
  const onConnect = vi.fn()
  const onBulkDrop = vi.fn()
  const hook = renderHook(() => useEdgeConnect({ onConnect, groupOf, onBulkDrop }))
  return { hook, onConnect, onBulkDrop }
}

const move = (id: string | null) => act(() => {
  under = id
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: 50, clientY: 60 }) as PointerEvent)
})
const release = (id: string | null) => act(() => {
  under = id
  window.dispatchEvent(new MouseEvent('pointerup', { clientX: 50, clientY: 60 }) as PointerEvent)
})

describe('useEdgeConnect — bulk', () => {
  it('a selected card drags the whole selection, and dropping it links them all into the card', () => {
    const { hook, onBulkDrop } = setup()
    act(() => hook.result.current.beginDrag('b', { x: 0, y: 0 }))
    expect(hook.result.current.state.sourceIds).toEqual(SELECTION)
    move('z')
    expect(hook.result.current.state.hoverId).toBe('z')
    release('z')
    expect(onBulkDrop).toHaveBeenCalledWith({ direction: 'selection-feeds', picked: ['z'], at: { x: 50, y: 60 } })
    expect(hook.result.current.state.mode).toBe('idle')
  })

  it('never hovers or drops onto a card it is carrying', () => {
    const { hook, onBulkDrop } = setup()
    act(() => hook.result.current.beginDrag('a', { x: 0, y: 0 }))
    move('c')
    expect(hook.result.current.state.hoverId).toBeNull()
    release('c')
    expect(onBulkDrop).not.toHaveBeenCalled()
    expect(hook.result.current.state.mode).toBe('idle')
  })

  it('one card dropped on a selected card feeds the whole selection', () => {
    const { hook, onBulkDrop } = setup()
    act(() => hook.result.current.beginDrag('z', { x: 0, y: 0 }))
    expect(hook.result.current.state.sourceIds).toEqual(['z'])
    release('b')
    expect(onBulkDrop).toHaveBeenCalledWith({ direction: 'feeds-selection', picked: ['z'], at: { x: 50, y: 60 } })
  })

  it('two unselected cards: the plain one-to-one picker, as before', () => {
    const { hook, onBulkDrop } = setup()
    act(() => hook.result.current.beginDrag('y', { x: 0, y: 0 }))
    release('z')
    expect(onBulkDrop).not.toHaveBeenCalled()
    expect(hook.result.current.state).toMatchObject({ mode: 'picking', sourceId: 'y', targetId: 'z' })
  })

  it('Escape cancels a drag', () => {
    const { hook } = setup()
    act(() => hook.result.current.beginDrag('a', { x: 0, y: 0 }))
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(hook.result.current.state.mode).toBe('idle')
  })
})
