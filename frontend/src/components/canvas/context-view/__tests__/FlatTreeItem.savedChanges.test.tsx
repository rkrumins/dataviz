/**
 * A closed container says it holds changes saved on the draft — by hand or by an import — and that
 * includes children it gained that are not loaded yet (an import's new rows under a table nobody
 * opened): its row carries a stripe and says why.
 */
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ViewRowSearchContext,
  ViewSearchSessionContext,
} from '@/components/canvas/search/session/ViewSearchSessionContext'
import type { ViewSearchSession } from '@/components/canvas/search/session/useViewSearchSessionController'
import { useBranchStore } from '@/store/branchStore'
import { useSchemaStore } from '@/store/schema'
import { buildChangeSet } from '@/features/versioning/model/changeModel'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { installJsdomLayout } from '@/test/canvasHarness'
import { stubSession } from '@/test/stubSearchSession'
import type { ViewLayerConfig } from '@/types/schema'

import { LayerColumn } from '../LayerColumn'
import type { HierarchyNode } from '../types'

const layer: ViewLayerConfig = { id: 'L1', name: 'Data', entityTypes: [], order: 0, color: '#4488ff' }

function node(id: string): HierarchyNode {
  return {
    id, urn: `urn:${id}`, typeId: 'dataset', name: id, data: { label: id, urn: `urn:${id}` },
    children: [], depth: 0, entityTypeOption: 'dataset', tags: [],
  }
}

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

const origin = { source: 'branch' as const, branchId: 'b' }

beforeEach(() => {
  useStagedChangesStore.setState({ changes: [], redoStack: [] })
  useSchemaStore.setState({ schema: { containmentEdgeTypes: ['CONTAINS'], entityTypes: [] } } as never)
  useBranchStore.setState({ committedDiffHidden: false, activeChangeSet: null } as never)
})

describe('a closed container with changes saved inside it', () => {
  it('says so for a loaded child that changed', () => {
    const table = { ...node('orders'), children: [node('col')] }
    useBranchStore.setState({ activeChangeSet: buildChangeSet([
      { entityId: 'urn:col', kind: 'node', status: 'modified', label: 'col', origin },
    ]) } as never)
    renderColumn([table])
    expect(row('orders').className).toContain('border-l-emerald-500')
  })

  it('says so for children an import added that are not loaded', () => {
    useBranchStore.setState({ activeChangeSet: buildChangeSet([
      { entityId: 'gv-1', kind: 'edge', status: 'added', label: 'CONTAINS', sourceUrn: 'urn:orders', targetUrn: 'urn:new', after: { edgeType: 'CONTAINS' }, origin },
    ]) } as never)
    renderColumn([node('orders'), node('plain')])
    expect(row('orders').className).toContain('border-l-emerald-500')
    expect(row('plain').className).not.toContain('border-l-emerald-500')
  })

  it('a new lineage link is not a child', () => {
    useBranchStore.setState({ activeChangeSet: buildChangeSet([
      { entityId: 'gv-2', kind: 'edge', status: 'added', label: 'FEEDS', sourceUrn: 'urn:orders', targetUrn: 'urn:x', after: { edgeType: 'FEEDS' }, origin },
    ]) } as never)
    renderColumn([node('orders')])
    expect(row('orders').className).not.toContain('border-l-emerald-500')
  })

  it('says nothing while the draft’s saved changes are hidden', () => {
    useBranchStore.setState({ committedDiffHidden: true, activeChangeSet: buildChangeSet([
      { entityId: 'gv-1', kind: 'edge', status: 'added', label: 'CONTAINS', sourceUrn: 'urn:orders', targetUrn: 'urn:new', after: { edgeType: 'CONTAINS' }, origin },
    ]) } as never)
    renderColumn([node('orders')])
    expect(row('orders').className).not.toContain('border-l-emerald-500')
  })
})
