/**
 * A display rule's look on a Context View row: the card takes the tint of the
 * first matching rule with one (a data attribute, which globals.css paints) and
 * the frame of the first with one (an outline drawn inside the card, so no row
 * grows and none reaches its neighbour).
 */
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ViewRowSearchContext,
  ViewSearchSessionContext,
} from '@/components/canvas/search/session/ViewSearchSessionContext'
import type { ViewSearchSession } from '@/components/canvas/search/session/useViewSearchSessionController'
import { useDisplayRuleMatchStore } from '@/store/displayRuleMatchStore'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { installJsdomLayout } from '@/test/canvasHarness'
import { stubSession } from '@/test/stubSearchSession'
import type { DisplayRuleConfig, ViewLayerConfig } from '@/types/schema'

import { LayerColumn } from '../LayerColumn'
import type { HierarchyNode } from '../types'

const layer: ViewLayerConfig = { id: 'L1', name: 'Data', entityTypes: [], order: 0, color: '#4488ff' }

function node(id: string): HierarchyNode {
  return {
    id, urn: `urn:${id}`, typeId: 'dataset', name: id, data: { label: id, urn: `urn:${id}` },
    children: [], depth: 0, entityTypeOption: 'dataset', tags: [],
  }
}

const rule = (id: string, color: string, style: DisplayRuleConfig['style']): DisplayRuleConfig => ({
  id, name: id, color, style, predicate: {}, enabled: true, createdAt: '2026-01-01T00:00:00Z',
})

function renderColumn(nodes: HierarchyNode[]) {
  installJsdomLayout()
  const session = stubSession({})
  render(
    <ViewSearchSessionContext.Provider value={session as ViewSearchSession}>
      <ViewRowSearchContext.Provider value={session.rowSearch}>
        <LayerColumn
          layer={layer} schema={null} selectedNodeId={null} expandedNodes={new Set()} searchResults={new Set()}
          onSelect={vi.fn()} onSelectRange={vi.fn()} onToggle={vi.fn()} onContextMenu={vi.fn()} onDoubleClick={vi.fn()}
          traceFocusId={null} traceNodes={new Set()} traceContextSet={new Set()} onRevealSearchHit={vi.fn()}
          overscan={200} nodes={nodes} isTracing={false}
        />
      </ViewRowSearchContext.Provider>
    </ViewSearchSessionContext.Provider>,
  )
}

const row = (id: string) => document.getElementById(`layer-node-${id}`) as HTMLElement

beforeEach(() => {
  useDisplayRuleMatchStore.getState().clear()
  useStagedChangesStore.setState({ changes: [], redoStack: [] })
  useDisplayRuleMatchStore.getState().setRuleMeta([
    rule('seed', '#3b82f6', { fill: true }),
    rule('boxed', '#ef4444', { frame: 'dashed', chip: false }),
  ])
  useDisplayRuleMatchStore.getState().applyMembership(
    ['seed', 'boxed'], ['urn:orders', 'urn:plain'], { seed: ['urn:orders'], boxed: ['urn:orders'] },
  )
})

describe('a display rule\'s look on a row', () => {
  it('tints and frames the card it matches', () => {
    renderColumn([node('orders'), node('plain')])
    expect(row('orders')).toHaveAttribute('data-rule-fill')
    expect(row('orders').style.getPropertyValue('--nx-rule-fill')).toBe('#3b82f6')
    expect(row('orders').style.outline).toContain('dashed')
    expect(row('plain')).not.toHaveAttribute('data-rule-fill')
    expect(row('plain').style.outline).toBe('')
  })

  it('leaves a chip-off rule\'s chip out', () => {
    renderColumn([node('orders')])
    expect(row('orders').textContent).not.toContain('boxed')
    expect(row('orders').textContent).toContain('seed')
  })
})
