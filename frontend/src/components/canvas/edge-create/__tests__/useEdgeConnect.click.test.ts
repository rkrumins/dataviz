/**
 * useEdgeConnect — connecting without holding the mouse down.
 *
 * A click on the handle arms a connection; the next click on a card's body picks
 * the target. Nothing else is swallowed: a card's own controls, the strip, the
 * search box and empty canvas keep their clicks, and a stray click only nudges
 * the reminder. ⌘/Ctrl-click collects several targets. The Connect tool keeps
 * going after each link, and Escape backs out one step at a time.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLICK_SLOP_PX, useEdgeConnect, type UseEdgeConnectOptions } from '../useEdgeConnect'

/** Cards as the canvas renders them: `layer-node-<id>`, a body and a control. */
function mountCards(ids: string[]) {
  const root = document.createElement('div')
  root.id = 'canvas'
  for (const id of ids) {
    const card = document.createElement('div')
    card.id = `layer-node-${id}`
    const body = document.createElement('span')
    body.className = 'body'
    body.textContent = id
    const chevron = document.createElement('button')
    chevron.className = 'chevron'
    card.append(body, chevron)
    root.append(card)
  }
  const empty = document.createElement('div')
  empty.className = 'empty'
  root.append(empty)
  document.body.append(root)
  return root
}

const body = (id: string) => document.querySelector(`#layer-node-${id} .body`) as HTMLElement
const chevron = (id: string) => document.querySelector(`#layer-node-${id} .chevron`) as HTMLElement

/** The listeners for an armed connection bind on the next tick. */
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

const click = (el: Element, init: MouseEventInit = {}) =>
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 40, clientY: 50, ...init })) })

const key = (k: string) => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) })

function setup(over: Partial<UseEdgeConnectOptions> = {}) {
  const onConnect = vi.fn()
  const onMultiTarget = vi.fn()
  const hook = renderHook(() => useEdgeConnect({ onConnect, onMultiTarget, ...over }))
  return { hook, onConnect, onMultiTarget }
}

let root: HTMLElement
beforeEach(() => {
  root = mountCards(['a', 'b', 'c', 'd'])
  document.elementFromPoint = vi.fn(() => null) as never
})
afterEach(() => {
  root.remove()
  vi.restoreAllMocks()
})

describe('useEdgeConnect — click to connect', () => {
  it('a click on the handle arms the connection instead of cancelling it', () => {
    const { hook } = setup()
    act(() => hook.result.current.beginDrag('a', { x: 100, y: 100 }))
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', { clientX: 100 + CLICK_SLOP_PX - 1, clientY: 100 }) as PointerEvent)
    })
    expect(hook.result.current.state).toMatchObject({ mode: 'armed', sourceId: 'a', sourceIds: ['a'] })
  })

  it('the next click on a card body picks the target, and the click never reaches the row', async () => {
    const { hook } = setup()
    const rowClick = vi.fn()
    root.addEventListener('click', rowClick)
    act(() => hook.result.current.armConnect('a'))
    await tick()
    click(body('b'))
    expect(hook.result.current.state).toMatchObject({ mode: 'picking', sourceId: 'a', targetId: 'b' })
    expect(rowClick).not.toHaveBeenCalled()
  })

  it("a card's own controls keep their clicks, and the connection stays armed", async () => {
    const { hook } = setup()
    const expand = vi.fn()
    chevron('b').addEventListener('click', expand)
    act(() => hook.result.current.armConnect('a'))
    await tick()
    click(chevron('b'))
    expect(expand).toHaveBeenCalledTimes(1)
    expect(hook.result.current.state.mode).toBe('armed')
  })

  it('a click on no card passes through and nudges the reminder, never cancelling', async () => {
    const { hook } = setup()
    const background = vi.fn()
    root.addEventListener('click', background)
    act(() => hook.result.current.armConnect('a'))
    await tick()
    const before = hook.result.current.state.nudge
    click(root.querySelector('.empty')!)
    expect(background).toHaveBeenCalledTimes(1)
    expect(hook.result.current.state.mode).toBe('armed')
    expect(hook.result.current.state.nudge).toBe(before + 1)
  })

  it('links at once when only one relationship fits', async () => {
    const singleTypeFor = vi.fn(() => 'PRODUCES')
    const { hook, onConnect } = setup({ singleTypeFor })
    act(() => hook.result.current.armConnect('a'))
    await tick()
    click(body('b'))
    expect(singleTypeFor).toHaveBeenCalledWith('a', 'b')
    expect(onConnect).toHaveBeenCalledWith('a', 'b', 'PRODUCES', { auto: true })
    expect(hook.result.current.state.mode).toBe('idle')
  })

  it('⌘/Ctrl-click collects targets; Enter links the source into all of them', async () => {
    const { hook, onMultiTarget } = setup()
    act(() => hook.result.current.armConnect('a'))
    await tick()
    click(body('b'), { metaKey: true })
    click(body('c'), { ctrlKey: true })
    expect(hook.result.current.state.targets).toEqual(['b', 'c'])
    click(body('c'), { metaKey: true })
    expect(hook.result.current.state.targets).toEqual(['b'])
    click(body('d'), { metaKey: true })
    key('Enter')
    expect(onMultiTarget).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'a', targets: ['b', 'd'] }))
    expect(hook.result.current.state.mode).toBe('idle')
  })

  it('a plain click after collecting finishes the set with that card', async () => {
    const { hook, onMultiTarget } = setup()
    act(() => hook.result.current.armConnect('a'))
    await tick()
    click(body('b'), { metaKey: true })
    click(body('c'))
    expect(onMultiTarget).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'a', targets: ['b', 'c'] }))
  })

  it('Escape backs out one step at a time: targets, then the connection', async () => {
    const { hook } = setup()
    act(() => hook.result.current.armConnect('a'))
    await tick()
    click(body('b'), { metaKey: true })
    key('Escape')
    expect(hook.result.current.state).toMatchObject({ mode: 'armed', targets: [] })
    key('Escape')
    expect(hook.result.current.state.mode).toBe('idle')
  })

  it('a click on the source itself is ignored', async () => {
    const { hook } = setup()
    act(() => hook.result.current.armConnect('a'))
    await tick()
    click(body('a'))
    expect(hook.result.current.state).toMatchObject({ mode: 'armed', sourceId: 'a' })
  })
})

describe('useEdgeConnect — the Connect tool', () => {
  it('a click picks the source, the next the target, and the tool waits for the next source', async () => {
    const { hook, onConnect } = setup()
    act(() => hook.result.current.setTool(true))
    await tick()
    click(body('a'))
    expect(hook.result.current.state).toMatchObject({ mode: 'armed', sourceId: 'a', tool: true })
    await tick()
    click(body('b'))
    expect(hook.result.current.state.mode).toBe('picking')
    act(() => hook.result.current.confirm('PRODUCES'))
    expect(onConnect).toHaveBeenCalledWith('a', 'b', 'PRODUCES')
    expect(hook.result.current.state).toMatchObject({ mode: 'idle', tool: true })
  })

  it('Escape drops the source first, then turns the tool off', async () => {
    const { hook } = setup()
    act(() => hook.result.current.setTool(true))
    await tick()
    click(body('a'))
    await tick()
    key('Escape')
    expect(hook.result.current.state).toMatchObject({ mode: 'idle', tool: true })
    await tick()
    key('Escape')
    expect(hook.result.current.state).toMatchObject({ mode: 'idle', tool: false })
  })

  it('toggleTool turns it on and off', () => {
    const { hook } = setup()
    act(() => hook.result.current.toggleTool())
    expect(hook.result.current.state.tool).toBe(true)
    act(() => hook.result.current.toggleTool())
    expect(hook.result.current.state.tool).toBe(false)
  })
})

describe('useEdgeConnect — armed from a selection', () => {
  it('carries the selection and links it into the card clicked', async () => {
    const onBulkDrop = vi.fn()
    const SELECTION = ['a', 'b']
    const { hook } = setup({ onBulkDrop, groupOf: (id) => (SELECTION.includes(id) ? SELECTION : null) })
    act(() => hook.result.current.armConnect('a'))
    expect(hook.result.current.state.sourceIds).toEqual(SELECTION)
    await tick()
    click(body('c'))
    expect(onBulkDrop).toHaveBeenCalledWith({ direction: 'selection-feeds', picked: ['c'], at: { x: 40, y: 50 } })
  })
})
