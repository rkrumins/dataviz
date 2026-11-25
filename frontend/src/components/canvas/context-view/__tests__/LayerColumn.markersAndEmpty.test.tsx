/**
 * Display › Show off-screen markers, and Display › Empty layers.
 *
 * The markers are the "↑ N more · M lines" at a column's top and bottom; off,
 * neither is drawn, fade or label. An empty layer says so always (the
 * default), not while a trace is on, or never — but a column built around an
 * entity that is gone, or held by another column, always says why: that is a
 * problem with the data, not an empty layer.
 */
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ViewRowSearchContext,
  ViewSearchSessionContext,
} from '@/components/canvas/search/session/ViewSearchSessionContext'
import { installJsdomLayout } from '@/test/canvasHarness'
import { stubSession } from '@/test/stubSearchSession'
import { useColumnPeripheryStore } from '@/store/columnPeriphery'
import { usePersonaStore } from '@/store/persona'
import { usePreferencesStore } from '@/store/preferences'
import type { ViewLayerConfig } from '@/types/schema'

import { LayerColumn } from '../LayerColumn'
import type { HierarchyNode } from '../types'

const layer: ViewLayerConfig = { id: 'L1', name: 'Data', entityTypes: [], order: 0, color: '#4488ff' }

const node = (id: string): HierarchyNode => ({
  id, urn: id, typeId: 'dataset', name: id, data: { label: id }, children: [],
  depth: 0, entityTypeOption: 'dataset', tags: [],
})

function renderColumn(extra: Partial<React.ComponentProps<typeof LayerColumn>> = {}) {
  const session = stubSession()
  render(
    <ViewSearchSessionContext.Provider value={session}>
      <ViewRowSearchContext.Provider value={session.rowSearch}>
        <LayerColumn
          layer={layer} schema={null} nodes={[]} selectedNodeId={null}
          expandedNodes={new Set()} searchResults={new Set<string>()}
          onSelect={vi.fn()} onSelectRange={vi.fn()} onToggle={vi.fn()} onContextMenu={vi.fn()}
          onDoubleClick={vi.fn()} traceFocusId={null} traceNodes={new Set<string>()}
          traceContextSet={new Set<string>()} overscan={200}
          {...extra}
        />
      </ViewRowSearchContext.Provider>
    </ViewSearchSessionContext.Provider>,
  )
}

beforeEach(() => {
  installJsdomLayout()
  usePersonaStore.setState({ mode: 'technical' })
})
afterEach(() => {
  usePreferencesStore.setState({ showOffscreenLineMarkers: true, emptyLayerMessage: 'always' })
  useColumnPeripheryStore.getState().clear()
})

describe('Show off-screen markers', () => {
  const offScreen = () => useColumnPeripheryStore.getState().setSummaries({
    L1: { upEdges: 3, upEntities: 2, upPartnerIds: [], downEdges: 5, downEntities: 4, downPartnerIds: [] },
  })

  it('on by default: the lines past the column’s top and bottom are counted there', () => {
    offScreen()
    renderColumn({ nodes: [node('orders'), node('customers')] })
    expect(screen.getByText('3 lines')).toBeInTheDocument()
    expect(screen.getByText('5 lines')).toBeInTheDocument()
  })

  it('off: neither end draws its marker', () => {
    offScreen()
    usePreferencesStore.setState({ showOffscreenLineMarkers: false })
    renderColumn({ nodes: [node('orders'), node('customers')] })
    expect(screen.queryByText('3 lines')).not.toBeInTheDocument()
    expect(screen.queryByText('5 lines')).not.toBeInTheDocument()
    // The rows themselves are untouched.
    expect(document.getElementById('layer-node-orders')).not.toBeNull()
  })
})

describe('Empty layers', () => {
  it('always, by default: an empty layer says so, in a trace too', () => {
    renderColumn()
    expect(screen.getByText('No assigned entities yet')).toBeInTheDocument()
    renderColumn({ isTracing: true })
    expect(screen.getAllByText('No assigned entities yet')).toHaveLength(2)
  })

  it('not while tracing: says so while no trace is on, with its hint', () => {
    usePreferencesStore.setState({ emptyLayerMessage: 'tracing-hidden' })
    renderColumn({ onAddToLayer: vi.fn() })
    expect(screen.getByText('No assigned entities yet')).toBeInTheDocument()
    expect(screen.getByText('Click + to assign entities')).toBeInTheDocument()
  })

  it('not while tracing, in a trace: the column is blank', () => {
    usePreferencesStore.setState({ emptyLayerMessage: 'tracing-hidden' })
    renderColumn({ isTracing: true, onAddToLayer: vi.fn() })
    expect(screen.queryByText('No assigned entities yet')).not.toBeInTheDocument()
    expect(screen.queryByText('Click + to assign entities')).not.toBeInTheDocument()
  })

  it('never: the column is blank, and the header keeps its way to add', () => {
    usePreferencesStore.setState({ emptyLayerMessage: 'never' })
    renderColumn({ onAddToLayer: vi.fn(), emptyText: 'No matches' })
    expect(screen.queryByText('No matches')).not.toBeInTheDocument()
    expect(screen.queryByText('Click + to assign entities')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add entity to Data' })).toBeInTheDocument()
  })

  it.each(['never', 'tracing-hidden'] as const)('%s: a column whose entity is gone still says why', (mode) => {
    usePreferencesStore.setState({ emptyLayerMessage: mode })
    renderColumn({ isTracing: true, anchorIssue: 'missing' })
    expect(screen.getByText(/entity is gone/i)).toBeInTheDocument()
    expect(screen.getByText(/removed from the source/i)).toBeInTheDocument()
  })
})
