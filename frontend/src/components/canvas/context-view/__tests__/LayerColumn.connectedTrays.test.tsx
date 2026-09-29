/**
 * The Anchor Rail's trays, and the lines that dock to them.
 *
 * The focused entity's lines to partners scrolled out of a column dock to
 * that column's tray, or to its hint pill when trays are off. Opening a tray
 * from its hint, or switching trays on or off, moves where they dock, so the
 * column asks the canvas to draw them again (`onAnimationComplete`, which
 * schedules an overlay pass). Without it the lines stayed on the old pill
 * until the next scroll.
 *
 * Each entry says who the line really reaches (not the card it lands on),
 * which way it flows, and where that entity sits; a click reveals it on the
 * canvas and leaves the selection alone. × and Esc fold a tray into its pill
 * in either mode.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ViewRowSearchContext,
  ViewSearchSessionContext,
} from '@/components/canvas/search/session/ViewSearchSessionContext'
import { useAnchorRailStore } from '@/store/anchorRail'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { usePreferencesStore } from '@/store/preferences'
import { installJsdomLayout } from '@/test/canvasHarness'
import { stubSession } from '@/test/stubSearchSession'
import type { AnchorProxy } from '../types'
import type { ViewLayerConfig } from '@/types/schema'

import { LayerColumn } from '../LayerColumn'
import type { HierarchyNode } from '../types'

const layer: ViewLayerConfig = { id: 'L1', name: 'Data', entityTypes: [], order: 0, color: '#4488ff' }

const node = (id: string, name = id, children: HierarchyNode[] = []): HierarchyNode => ({
  id, urn: id, typeId: 'dataset', name, data: { label: name }, children,
  depth: 0, entityTypeOption: 'dataset', tags: [],
})

/** What the canvas store knows by name. */
function seedNames(names: Record<string, string>) {
  useCanvasStore.getState().setNodes(Object.entries(names).map(([id, label]) => (
    { id, type: 'default', position: { x: 0, y: 0 }, data: { label } } as unknown as LineageNode
  )))
}

function publish(proxies: AnchorProxy[], focusId = 'a') {
  useAnchorRailStore.getState().publish(new Map([['L1', { proxies, moreCount: 0 }]]), focusId)
}

afterEach(() => {
  useAnchorRailStore.getState().clear()
  useCanvasStore.getState().setNodes([])
  usePreferencesStore.setState({ showConnectedTrays: true })
})

function renderColumn(onAnimationComplete: () => void, props: Partial<React.ComponentProps<typeof LayerColumn>> = {}) {
  installJsdomLayout()
  const session = stubSession({})
  render(
    <ViewSearchSessionContext.Provider value={session}>
      <ViewRowSearchContext.Provider value={session.rowSearch}>
        <LayerColumn
          layer={layer}
          schema={null}
          nodes={[node('a'), node('b')]}
          selectedNodeId={null}
          expandedNodes={new Set()}
          searchResults={new Set<string>()}
          onSelect={vi.fn()}
          onSelectRange={vi.fn()}
          onToggle={vi.fn()}
          onContextMenu={vi.fn()}
          onDoubleClick={vi.fn()}
          traceFocusId={null}
          traceNodes={new Set<string>()}
          traceContextSet={new Set<string>()}
          onRevealSearchHit={vi.fn()}
          onAnimationComplete={onAnimationComplete}
          overscan={200}
          {...props}
        />
      </ViewRowSearchContext.Provider>
    </ViewSearchSessionContext.Provider>,
  )
}

describe('LayerColumn — connected trays', () => {
  it('opening a tray from its hint, or switching trays, redraws the lines', () => {
    usePreferencesStore.setState({ showConnectedTrays: false })
    useAnchorRailStore.getState().publish(new Map([
      ['L1', { proxies: [{ nodeId: 'far', count: 3, color: '#888', direction: 'down', flow: 'in' }], moreCount: 0 }],
    ]), 'a')
    const redraw = vi.fn()
    renderColumn(redraw)

    const hint = screen.getByRole('button', { name: /1 connected/ })
    redraw.mockClear()
    fireEvent.click(hint)
    expect(screen.getByText('Off-screen below')).toBeInTheDocument()
    expect(redraw).toHaveBeenCalled()

    redraw.mockClear()
    act(() => { usePreferencesStore.setState({ showConnectedTrays: true }) })
    expect(redraw).toHaveBeenCalled()
  })
})

describe('LayerColumn — a tray entry says who, which way and where', () => {
  // order_count (a) is selected; its partner order_key sits inside fact_orders, inside the
  // collapsed GOLD card (b) its line lands on.
  const hidden: AnchorProxy = { nodeId: 'b', realId: 'order_key', flow: 'in', count: 1, color: '#888', direction: 'down' }
  const pathOf = (id: string) => (id === 'order_key' ? ['fact', 'b'] : [])

  it('names the entity the line really reaches, how it flows, and the card it sits in; a click reveals it', () => {
    seedNames({ a: 'order_count', order_key: 'order_key', fact: 'fact_orders' })
    publish([hidden])
    const onProxyReveal = vi.fn()
    const onSelect = vi.fn()
    renderColumn(vi.fn(), {
      nodes: [node('a', 'order_count'), node('b', 'GOLD')], selectedNodeId: 'a', railPathOf: pathOf, onProxyReveal, onSelect,
    })

    const entry = document.getElementById('anchor-proxy-b')!
    expect(entry).toHaveTextContent('order_key')
    expect(entry).toHaveTextContent('feeds order_count · in GOLD › fact_orders')
    expect(within(entry).getByText('feeds')).toHaveClass('text-lineage-in')
    // Never the stand-in as the partner.
    expect(entry.textContent).not.toMatch(/^GOLD/)
    expect(entry).toHaveAccessibleName('order_key, feeds order_count, in GOLD › fact_orders, 1 underlying flow. Reveal on canvas')

    fireEvent.click(entry)
    expect(onProxyReveal).toHaveBeenCalledWith('order_key')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('an entity whose name is not known yet reads by its role, never by its id', () => {
    seedNames({ a: 'order_count' })
    publish([hidden])
    renderColumn(vi.fn(), { nodes: [node('a', 'order_count'), node('b', 'GOLD')], railPathOf: pathOf })

    const entry = document.getElementById('anchor-proxy-b')!
    expect(entry).toHaveTextContent('1 source')
    expect(entry).toHaveTextContent('feeds order_count · in GOLD')
    expect(entry.textContent).not.toContain('order_key')
    expect(entry.textContent).not.toContain('fact')
  })

  it('a line standing for several entities counts them, and a click opens the card down to them', () => {
    seedNames({ a: 'base_pay' })
    publish([{ nodeId: 'b', partners: 3, realIds: ['x', 'y', 'z'], flow: 'out', count: 4, color: '#888', direction: 'down' }])
    const onProxyReveal = vi.fn()
    const onProxyRevealMany = vi.fn()
    renderColumn(vi.fn(), { nodes: [node('a', 'base_pay'), node('b', 'SILVER')], onProxyReveal, onProxyRevealMany })

    const entry = document.getElementById('anchor-proxy-b')!
    expect(entry).toHaveTextContent('3 consumers')
    expect(entry).toHaveTextContent('4 flows')
    expect(entry).toHaveTextContent('fed by base_pay · in SILVER')
    expect(within(entry).getByText('fed by')).toHaveClass('text-lineage-out')
    fireEvent.click(entry)
    expect(onProxyRevealMany).toHaveBeenCalledWith(['x', 'y', 'z'])
    expect(onProxyReveal).not.toHaveBeenCalled()
  })

  it('in hint mode, the pill counts the entities, not the entries', () => {
    usePreferencesStore.setState({ showConnectedTrays: false })
    seedNames({ a: 'base_pay' })
    publish([{ nodeId: 'b', partners: 3, realIds: ['x', 'y', 'z'], flow: 'out', count: 4, color: '#888', direction: 'down' }])
    renderColumn(vi.fn(), { nodes: [node('a', 'base_pay'), node('b', 'SILVER')] })

    const pill = screen.getByRole('button', { name: '3 connected to base_pay, below — show them' })
    expect(pill).toHaveTextContent('3 connected')
    expect(pill).toHaveAttribute('aria-expanded', 'false')
    // Its lines dock to a strip as wide as the tray, not to the pill at the column's left.
    const dock = pill.closest('[data-anchor-dock]')
    expect(dock).not.toBeNull()
    expect(dock).not.toBe(pill)
    expect(dock).toHaveClass('left-2.5', 'right-2.5')
  })

  it('a partner drawn in this column is told apart by the row that holds it', () => {
    seedNames({ a: 'base_pay' })
    publish([{ nodeId: 'bp', flow: 'out', count: 1, color: '#888', direction: 'down' }])
    renderColumn(vi.fn(), {
      nodes: [node('a', 'base_pay'), node('emp', 'employees_clean', [{ ...node('bp', 'base_pay'), depth: 1 }])],
      expandedNodes: new Set(['emp']),
      railPathOf: (id: string) => (id === 'bp' ? ['emp'] : []),
    })

    const entry = document.getElementById('anchor-proxy-bp')!
    expect(entry).toHaveTextContent('base_pay')
    expect(entry).toHaveTextContent('fed by base_pay · in employees_clean')
  })

  it('names a focused entity from another column that the canvas store does not hold — never by its id', () => {
    const focus = 'urn:li:dataset:(prod,focus_table)'
    publish([{ nodeId: 'b', flow: 'in', count: 1, color: '#888', direction: 'down' }], focus)
    // A trace's card: the canvas draws it, its store does not hold it.
    const resolveNode = (id: string) => (id === focus
      ? { id, type: 'default', position: { x: 0, y: 0 }, data: { label: 'focus_table' } } as unknown as LineageNode
      : null)
    renderColumn(vi.fn(), { resolveNode })

    const entry = document.getElementById('anchor-proxy-b')!
    expect(entry).toHaveTextContent('feeds focus_table')
    expect(entry.textContent).not.toContain('urn:li')
    expect(entry.getAttribute('aria-label')).not.toContain('urn:li')
    expect(screen.getByRole('group', { name: "focus_table's lineage, off-screen below" })).toBeInTheDocument()
  })

  it('with no name for it anywhere yet, reads what the lookup shows while it answers — not the raw id', () => {
    const focus = 'urn:li:dataset:(prod,focus_table)'
    publish([{ nodeId: 'b', flow: 'in', count: 1, color: '#888', direction: 'down' }], focus)
    renderColumn(vi.fn())

    const entry = document.getElementById('anchor-proxy-b')!
    expect(entry.textContent).not.toContain('urn:li')
    expect(entry.getAttribute('aria-label')).not.toContain('urn:li')
  })
})

describe('LayerColumn — the selection itself scrolled out of its column', () => {
  const selection: AnchorProxy = { nodeId: 'a', isFocus: true, flow: 'out', count: 2, color: '#888', direction: 'up' }

  it('its tray entry is the selection, and a click goes back to it without changing it', () => {
    seedNames({ a: 'order_count' })
    publish([selection])
    const onProxyReveal = vi.fn()
    const onSelect = vi.fn()
    renderColumn(vi.fn(), { nodes: [node('a', 'order_count'), node('b')], selectedNodeId: 'a', onProxyReveal, onSelect })

    const entry = document.getElementById('anchor-proxy-a')!
    expect(entry).toHaveTextContent('order_count')
    expect(entry).toHaveTextContent('Selected · back to it')
    expect(entry.textContent).not.toMatch(/connected/)
    fireEvent.click(entry)
    expect(onProxyReveal).toHaveBeenCalledWith('a')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('its hint is the selection too, and a click goes straight back to it', () => {
    usePreferencesStore.setState({ showConnectedTrays: false })
    seedNames({ a: 'order_count' })
    publish([selection])
    const onProxyReveal = vi.fn()
    renderColumn(vi.fn(), { nodes: [node('a', 'order_count'), node('b')], selectedNodeId: 'a', onProxyReveal })

    const pill = document.getElementById('anchor-rail-L1-up')!
    expect(pill).toHaveTextContent(/^order_count\s*\(selected\)$/)
    expect(pill.textContent).not.toMatch(/connected/)
    expect(pill).toHaveAccessibleName('order_count, selected, off-screen above — back to it')
    fireEvent.click(pill)
    expect(onProxyReveal).toHaveBeenCalledWith('a')
    expect(screen.queryByText('Off-screen above')).toBeNull()
  })
})

describe('LayerColumn — folding a tray (trays on)', () => {
  const partner: AnchorProxy = { nodeId: 'b', flow: 'in', count: 1, color: '#888', direction: 'down' }

  it('is a named group for the focused entity', () => {
    seedNames({ a: 'order_count' })
    publish([partner])
    renderColumn(vi.fn())
    expect(screen.getByRole('group', { name: "order_count's lineage, off-screen below" })).toHaveAttribute('data-anchor-dock')
  })

  it('× folds it into the hint, which takes focus, and the lines redraw', () => {
    seedNames({ a: 'order_count' })
    publish([partner])
    const redraw = vi.fn()
    renderColumn(redraw)

    redraw.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Fold into the hint' }))
    expect(screen.queryByText('Off-screen below')).toBeNull()
    const pill = screen.getByRole('button', { name: /1 connected to order_count, below/ })
    expect(pill).toHaveFocus()
    expect(redraw).toHaveBeenCalled()
  })

  it('Esc folds it the same way, and the canvas never hears it', () => {
    seedNames({ a: 'order_count' })
    publish([partner])
    renderColumn(vi.fn())
    const onWindowKey = vi.fn()
    window.addEventListener('keydown', onWindowKey)
    try {
      fireEvent.keyDown(document.getElementById('anchor-proxy-b')!, { key: 'Escape' })
    } finally {
      window.removeEventListener('keydown', onWindowKey)
    }
    expect(onWindowKey).not.toHaveBeenCalled()
    expect(screen.queryByText('Off-screen below')).toBeNull()
    expect(document.getElementById('anchor-rail-L1-down')).toHaveFocus()
  })

  it('clicking the hint opens it again, focus on its first entry', () => {
    seedNames({ a: 'order_count' })
    publish([partner])
    renderColumn(vi.fn())
    fireEvent.click(screen.getByRole('button', { name: 'Fold into the hint' }))
    fireEvent.click(document.getElementById('anchor-rail-L1-down')!)
    expect(screen.getByText('Off-screen below')).toBeInTheDocument()
    expect(document.getElementById('anchor-proxy-b')).toHaveFocus()
  })

  it('stays folded through a moment with no rail, and follows the setting again for another entity', () => {
    seedNames({ a: 'order_count' })
    publish([partner])
    const redraw = vi.fn()
    renderColumn(redraw)
    fireEvent.click(screen.getByRole('button', { name: 'Fold into the hint' }))
    expect(document.getElementById('anchor-rail-L1-down')).not.toBeNull()

    // Its partner scrolls into view and back out: the same entity, still folded.
    act(() => { useAnchorRailStore.getState().clear() })
    redraw.mockClear()
    act(() => { publish([partner]) })
    expect(screen.queryByText('Off-screen below')).toBeNull()
    expect(document.getElementById('anchor-rail-L1-down')).not.toBeNull()
    expect(redraw).not.toHaveBeenCalled()

    act(() => { publish([partner], 'z') })
    expect(screen.getByText('Off-screen below')).toBeInTheDocument()
  })
})

describe('LayerColumn — revealing from the keyboard', () => {
  const partner: AnchorProxy = { nodeId: 'b', flow: 'in', count: 1, color: '#888', direction: 'down' }

  for (const [what, after] of [
    ['the rail clears', () => useAnchorRailStore.getState().clear()],
    ['the rail lists another partner', () => publish([{ ...partner, nodeId: 'c' }])],
  ] as const) {
    it(`focus goes to the column when the entry leaves — ${what}`, () => {
      seedNames({ a: 'order_count' })
      publish([partner])
      const onProxyReveal = vi.fn()
      renderColumn(vi.fn(), { onProxyReveal })
      const entry = document.getElementById('anchor-proxy-b')!
      entry.focus()
      fireEvent.click(entry)
      expect(onProxyReveal).toHaveBeenCalledWith('b')

      // The partner is on screen now: the rail drops its entry.
      act(() => { after() })
      expect(document.activeElement).not.toBe(document.body)
      expect(document.activeElement).toContainElement(document.getElementById('layer-node-a'))
    })
  }
})
