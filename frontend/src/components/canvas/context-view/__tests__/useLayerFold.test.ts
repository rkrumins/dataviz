/**
 * The fold window follows the reader: an explicit move re-anchors it, a
 * reveal opens the layer it goes into, and the selected row's layer is not
 * folded away under them. The arithmetic is layerFold.test.ts's; these are
 * about which inputs move the window, and when.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useLayerFold, type UseLayerFoldArgs } from '../useLayerFold'

// Six default-width layers on a 1,200px run: two fit open (layerFold.test).
const LAYERS = Array.from({ length: 6 }, (_, i) => ({ id: `l${i}` }))
const layerOfNode = (nodeId: string) => `l${nodeId.slice(1)}`   // 'n4' lives in 'l4'

function canvas(width = 1200) {
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => width })
  return { current: el }
}

function setup(over: Partial<UseLayerFoldArgs> = {}) {
  const base: UseLayerFoldArgs = {
    layers: LAYERS,
    scrollRef: canvas(),
    zoom: 1,
    reservedWidth: 0,
    enabled: true,
    layerOf: layerOfNode,
    revealTarget: null,
    selectedNodeId: null,
    ...over,
  }
  const hook = renderHook((props: UseLayerFoldArgs) => useLayerFold(props), { initialProps: base })
  const open = () => LAYERS.map(l => l.id).filter(id => !hook.result.current.folded.has(id))
  return { ...hook, open, with: (more: Partial<UseLayerFoldArgs>) => hook.rerender({ ...base, ...more }) }
}

beforeEach(() => { localStorage.removeItem('nx-layer-widths') })
afterEach(() => { localStorage.removeItem('nx-layer-widths') })

describe('useLayerFold', () => {
  it('opens the first layers that fit and folds the rest', () => {
    const { open, result } = setup()
    expect(open()).toEqual(['l0', 'l1'])
    expect(result.current.active).toBe(true)
    expect(result.current.canStep).toEqual({ back: false, forward: true })
  })

  it('folds nothing while the canvas has not been measured', () => {
    const { result } = setup({ scrollRef: { current: null } })
    expect(result.current.folded.size).toBe(0)
    expect(result.current.active).toBe(false)
  })

  it('opens a layer asked for by name, centred', () => {
    const { open, result } = setup()
    act(() => result.current.focusLayer('l4'))
    expect(open()).toEqual(['l4', 'l5'])
  })

  it('opens the layer a reveal goes into', () => {
    const s = setup()
    s.with({ revealTarget: { id: 'n4', pulse: 1 } })
    expect(s.open()).toContain('l4')
  })

  it('waits for a revealed row whose layer is not known yet', () => {
    let known = false
    const s = setup({ layerOf: (id) => (known ? layerOfNode(id) : undefined) })
    s.with({ layerOf: (id) => (known ? layerOfNode(id) : undefined), revealTarget: { id: 'n4', pulse: 1 } })
    expect(s.open()).not.toContain('l4')
    known = true
    s.with({ layerOf: (id) => (known ? layerOfNode(id) : undefined), revealTarget: { id: 'n4', pulse: 1 } })
    expect(s.open()).toContain('l4')
  })

  it('keeps the selected row’s layer open, sliding the least', () => {
    const s = setup()
    s.with({ selectedNodeId: 'n3' })
    expect(s.open()).toEqual(['l2', 'l3'])
  })

  it('keeps it open when the canvas narrows — the drawer opening', () => {
    const s = setup({ selectedNodeId: 'n1' })
    s.with({ selectedNodeId: 'n1', scrollRef: canvas(900) })
    expect(s.open()).toContain('l1')
  })

  it('slides one layer per step, and a step lets go of the selected row’s layer', () => {
    const s = setup({ selectedNodeId: 'n1' })
    act(() => s.result.current.step(1))
    expect(s.open()).toEqual(['l1', 'l2'])
    act(() => s.result.current.step(1))
    expect(s.open()).toEqual(['l2', 'l3'])
    act(() => s.result.current.step(-1))
    expect(s.open()).toEqual(['l1', 'l2'])
  })

  it('keeps a layer folded by hand a spine, and opens it again when asked', () => {
    const { open, result } = setup()
    act(() => result.current.setLayerFolded('l1', true))
    expect(open()).toEqual(['l0', 'l2'])
    act(() => result.current.setLayerFolded('l1', false))
    expect(open()).toContain('l1')
  })

  it('folds only what the reader folded when folding is off', () => {
    const { result, open } = setup({ enabled: false })
    expect(result.current.folded.size).toBe(0)
    expect(result.current.overflows).toBe(true)
    expect(result.current.active).toBe(false)
    act(() => result.current.setLayerFolded('l2', true))
    expect(open()).toEqual(['l0', 'l1', 'l3', 'l4', 'l5'])
  })

  it('counts a column the reader widened at its own width', () => {
    localStorage.setItem('nx-layer-widths', JSON.stringify({ l0: 900 }))
    const { open } = setup()
    expect(open()).toEqual(['l0'])
  })
})
