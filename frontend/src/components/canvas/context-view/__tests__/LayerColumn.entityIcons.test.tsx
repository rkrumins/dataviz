/**
 * Display > Display options > Show entity icons.
 *
 * Off, a row is its NAME alone — the ontology's icon and its tile are gone,
 * not hidden behind opacity — and a bulk-selected row keeps the one mark
 * that says "you picked this", in the icon's place.
 */
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ViewRowSearchContext,
  ViewSearchSessionContext,
} from '@/components/canvas/search/session/ViewSearchSessionContext'
import { installJsdomLayout } from '@/test/canvasHarness'
import { stubSession } from '@/test/stubSearchSession'
import { usePreferencesStore } from '@/store/preferences'
import type { ViewLayerConfig } from '@/types/schema'

import { LayerColumn } from '../LayerColumn'
import type { HierarchyNode } from '../types'

const layer: ViewLayerConfig = { id: 'L1', name: 'Data', entityTypes: [], order: 0, color: '#4488ff' }

const node = (id: string): HierarchyNode => ({
  id, urn: id, typeId: 'dataset', name: id, data: { label: id }, children: [],
  depth: 0, entityTypeOption: 'dataset', tags: [],
})

function renderColumn() {
  installJsdomLayout()
  const session = stubSession({})
  render(
    <ViewSearchSessionContext.Provider value={session}>
      <ViewRowSearchContext.Provider value={session.rowSearch}>
        <LayerColumn
          layer={layer}
          schema={null}
          nodes={[node('orders'), node('customers')]}
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
        />
      </ViewRowSearchContext.Provider>
    </ViewSearchSessionContext.Provider>,
  )
}

const row = (id: string) => document.getElementById(`layer-node-${id}`)!

afterEach(() => usePreferencesStore.setState({ showCanvasEntityIcons: true }))

describe('Show entity icons', () => {
  it('on by default: every row carries its type icon', () => {
    renderColumn()
    expect(row('orders').querySelector('[data-entity-icon]')).not.toBeNull()
  })

  it('off: the row is its name alone', () => {
    usePreferencesStore.setState({ showCanvasEntityIcons: false })
    renderColumn()
    expect(row('orders').querySelector('[data-entity-icon]')).toBeNull()
    expect(row('orders').textContent).toContain('orders')
  })

  it('Reset brings the icons back', () => {
    usePreferencesStore.setState({ showCanvasEntityIcons: false })
    usePreferencesStore.getState().resetCanvasDisplaySettings()
    expect(usePreferencesStore.getState().showCanvasEntityIcons).toBe(true)
  })
})
