/**
 * SubsetStudioPanel — the rail that guides a subset: Pick → Connect → Shape.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LineageBridgesState } from '../../hooks/useLineageBridges'
import { useSubsetStudioStore, type SubsetPick } from '../../model/studioStore'
import { SubsetStudioPanel, type SubsetStudioPanelProps } from '../SubsetStudioPanel'

const layers = [
  { id: 'raw', name: 'Raw', color: '#111111' },
  { id: 'marts', name: 'Marts', color: '#222222' },
]
const pick = (urn: string, layerId = 'raw', over: Partial<SubsetPick> = {}): SubsetPick =>
  ({ urn, layerId, inheritsChildren: true, origin: 'picked', label: urn.toUpperCase(), entityType: 'table', ...over })

const preview = (over: Partial<LineageBridgesState> = {}): LineageBridgesState => ({
  status: 'ready', links: [], incomplete: [], depthLimited: false, isFetching: false, refetch: vi.fn(), ...over,
})

function renderPanel(props: Partial<SubsetStudioPanelProps> = {}) {
  const handlers = { onGrow: vi.fn(), onOpenHop: vi.fn(), onLocate: vi.fn(), onSave: vi.fn() }
  const view = render(
    <SubsetStudioPanel
      open
      sourceName="Finance lineage"
      layers={layers}
      layerCandidates={new Map([['raw', [pick('a'), pick('b')]], ['marts', [pick('f', 'marts')]]])}
      containerUrns={new Set(['a'])}
      preview={preview()}
      growing={false}
      {...handlers}
      {...props}
    />,
  )
  return { ...view, ...handlers }
}

const store = () => useSubsetStudioStore.getState()

beforeEach(() => {
  sessionStorage.clear()
  store().open('view-1')
})
afterEach(() => store().close({ discard: true }))

describe('SubsetStudioPanel — Pick', () => {
  it('explains the gesture before anything is picked, and offers whole layers', () => {
    renderPanel()
    expect(screen.getByRole('complementary', { name: 'Subset studio' })).toBeTruthy()
    expect(screen.getByText('Click entities on the canvas to keep them')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Raw\s*2/ }))
    expect(store().order).toEqual(['a', 'b'])
  })

  it('lists the picks by layer, each one removable, and undoes a batch', () => {
    act(() => { store().add([pick('a'), pick('f', 'marts', { origin: 'grown-down' })], 'Grow') })
    renderPanel()
    const list = screen.getByRole('region', { name: 'Picked entities' })
    expect(within(list).getByText('Raw')).toBeTruthy()
    expect(within(list).getByText('Downstream')).toBeTruthy()
    fireEvent.click(within(list).getByRole('button', { name: 'Leave A out' }))
    expect(store().order).toEqual(['f'])
    fireEvent.click(screen.getByRole('button', { name: /^Undo:/ }))
    expect(store().order).toEqual(['a', 'f'])
  })

  it('grows in the chosen direction and depth', () => {
    act(() => { store().toggle(pick('a')) })
    const { onGrow } = renderPanel()
    fireEvent.click(screen.getByRole('radio', { name: /Downstream/ }))
    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    fireEvent.click(screen.getByRole('button', { name: 'Grow' }))
    expect(onGrow).toHaveBeenCalledWith('downstream', 'all')
  })

  it('says why Grow cannot run yet', () => {
    act(() => { store().toggle(pick('a')) })
    renderPanel({ growBlockedReason: 'Reading how the entities of this view connect…' })
    expect((screen.getByRole('button', { name: 'Grow' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Reading how the entities of this view connect…')).toBeTruthy()
  })
})

describe('SubsetStudioPanel — Connect', () => {
  beforeEach(() => {
    act(() => { store().add([pick('a'), pick('c'), pick('z', 'marts')], 'Add'); store().setStep('connect') })
  })

  it('counts direct links, virtual hops and the isolated, and opens a hop', () => {
    const { onOpenHop } = renderPanel({ preview: preview({ links: [{ source: 'a', target: 'c', hops: 3 }] }) })
    expect(screen.getByText('Virtual hops', { selector: 'div' }).previousSibling?.textContent).toBe('1')
    const isolated = screen.getByRole('region', { name: 'Isolated entities' })
    expect(within(isolated).getByText('Z')).toBeTruthy()
    fireEvent.click(within(screen.getByRole('region', { name: 'Virtual hops' })).getByRole('button', { name: /A.*C.*via 2/ }))
    expect(onOpenHop).toHaveBeenCalledWith({ source: 'a', target: 'c', hops: 3 }, expect.any(Object))
  })

  it('says when the answer may be incomplete, and for whom', () => {
    renderPanel({ preview: preview({ status: 'partial', incomplete: [{ urn: 'z', side: 'upstream', reason: 'hub' }] }) })
    expect(screen.getByText(/Some connections may be missing/).textContent).toContain('Z')
  })

  it('tells the reader plainly when the source cannot stitch at all', () => {
    renderPanel({ preview: preview({ status: 'disabled' }) })
    expect(screen.getByText(/Virtual hops aren.t available on this data source/)).toBeTruthy()
  })
})

describe('SubsetStudioPanel — Shape', () => {
  it('lets a container come with or without what sits inside it, and sets the reach', () => {
    act(() => { store().add([pick('a'), pick('b')], 'Add'); store().setStep('shape') })
    renderPanel()
    fireEvent.click(screen.getByRole('switch', { name: 'A comes with what sits inside it' }))
    expect(store().picks.a.inheritsChildren).toBe(false)
    fireEvent.change(screen.getByRole('slider', { name: /Longest virtual hop/ }), { target: { value: '6' } })
    expect(store().maxHops).toBe(6)
    expect(screen.getByText(/Left out, nothing picked from them: Marts/)).toBeTruthy()
  })
})

describe('SubsetStudioPanel — leaving and saving', () => {
  it('asks before discarding picks', () => {
    act(() => { store().toggle(pick('a')) })
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('alert').textContent).toContain('Discard 1 pick?')
    fireEvent.click(screen.getByRole('button', { name: 'Keep picking' }))
    expect(store().sourceViewId).toBe('view-1')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(store().sourceViewId).toBeNull()
  })

  it('offers Save only once something is picked', () => {
    const { onSave } = renderPanel()
    const save = screen.getByRole('button', { name: /Save as view/ }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    act(() => { store().toggle(pick('a')) })
    fireEvent.click(screen.getByRole('button', { name: /Save as view/ }))
    expect(onSave).toHaveBeenCalled()
  })

  it('moves between the steps as tabs', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('tab', { name: /Shape/ }))
    expect(store().step).toBe('shape')
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('subset-step-shape')
  })
})
