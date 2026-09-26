/**
 * The lineage ports a column draws on its cards.
 *
 * A port glows brighter the more lines meet it, against THIS column's busiest
 * card — one hub in another column must not dim every port in this one. A
 * card whose lineage could not be counted says so, in neither colour.
 */
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  ViewRowSearchContext,
  ViewSearchSessionContext,
} from '@/components/canvas/search/session/ViewSearchSessionContext'
import { installJsdomLayout } from '@/test/canvasHarness'
import { stubSession } from '@/test/stubSearchSession'
import type { ViewLayerConfig } from '@/types/schema'

import { LayerColumn } from '../LayerColumn'
import type { NodePorts } from '../lineagePorts'
import type { HierarchyNode } from '../types'

const layer: ViewLayerConfig = { id: 'L1', name: 'Data', entityTypes: [], order: 0, color: '#4488ff' }

const node = (id: string): HierarchyNode => ({
  id, urn: id, typeId: 'dataset', name: id, data: { label: id }, children: [],
  depth: 0, entityTypeOption: 'dataset', tags: [],
})

const outRight = (n: number): NodePorts => ({
  left: { in: 0, out: 0 }, right: { in: 0, out: n }, delegated: { in: 0, out: 0 }, held: { in: 0, out: 0 },
})

function renderColumn(
  lineagePorts: ReadonlyMap<string, NodePorts>,
  lineageUnknown?: ReadonlySet<string>,
  lineage?: {
    totals?: ReadonlyMap<string, { in: number; out: number }>
    outside?: ReadonlyMap<string, { in: number; out: number }>
  },
) {
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
          overscan={200}
          lineagePorts={lineagePorts}
          lineageUnknown={lineageUnknown}
          lineageTotals={lineage?.totals}
          lineageOutside={lineage?.outside}
          showLineageIndicators
        />
      </ViewRowSearchContext.Provider>
    </ViewSearchSessionContext.Provider>,
  )
}

const port = (id: string, side: 'left' | 'right') =>
  document.getElementById(`layer-node-${id}`)!.querySelector<HTMLElement>(`[data-lineage-port="${side}"]`)

describe('LayerColumn — lineage ports', () => {
  it('glow is measured against this column’s busiest card, not a hub elsewhere', () => {
    renderColumn(new Map([
      ['a', outRight(2)],
      ['b', outRight(4)],
      // A card in another column, far busier than anything here.
      ['elsewhere', outRight(400)],
    ]))
    expect(port('b', 'right')!.style.getPropertyValue('--port-strength')).toBe('1')
    expect(Number(port('a', 'right')!.style.getPropertyValue('--port-strength'))).toBeCloseTo(Math.log2(3) / Math.log2(5))
  })

  it('a card whose count failed says unknown on both sides; the others say nothing', () => {
    renderColumn(new Map(), new Set(['a']))
    expect(port('a', 'left')!.dataset.port).toBe('unknown')
    expect(port('a', 'right')!.dataset.port).toBe('unknown')
    expect(port('b', 'left')).toBeNull()
    expect(port('b', 'right')).toBeNull()
  })

  it('a card is hollow only for flows the canvas placed outside; a total alone makes it solid', () => {
    renderColumn(new Map(), undefined, {
      totals: new Map([['a', { in: 0, out: 5 }], ['b', { in: 0, out: 5 }]]),
      outside: new Map([['a', { in: 0, out: 2 }]]),
    })
    expect(port('a', 'right')!.dataset.port).toBe('beyond')
    // The tip counts what leads outside, not the total.
    expect(port('a', 'right')!.dataset.out).toBe('2')
    expect(port('b', 'right')!.dataset.port).toBe('lineage')
    expect(port('b', 'left')).toBeNull()
  })
})
