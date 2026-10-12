/**
 * A row's type badge names the type from the VIEW's ontology.
 *
 * The global schema store follows whichever scope loaded last, so resolving
 * against it could show another data source's type name on a row. Inside a
 * view the badge resolves against that view's own ontology, ignoring case,
 * and falls back to the raw type id only when the ontology lacks the type.
 */
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ViewRowSearchContext,
  ViewSearchSessionContext,
} from '@/components/canvas/search/session/ViewSearchSessionContext'
import { StaticViewSchemaProvider, type ResolvedViewSchema } from '@/providers/ViewExecutionContext'
import { installJsdomLayout } from '@/test/canvasHarness'
import { stubSession } from '@/test/stubSearchSession'
import { useSchemaStore } from '@/store/schema'
import type { EntityTypeSchema, ViewLayerConfig } from '@/types/schema'

import { LayerColumn } from '../LayerColumn'
import type { HierarchyNode } from '../types'

function entityType(id: string, name: string): EntityTypeSchema {
  return {
    id,
    name,
    pluralName: `${name}s`,
    visual: { icon: 'Box', color: '#ff0000', shape: 'rounded', size: 'md', borderStyle: 'solid', showInMinimap: true },
    fields: [],
    hierarchy: { level: 0, canContain: [], canBeContainedBy: [], defaultExpanded: false, rollUpFields: [] },
    behavior: { selectable: true, draggable: true, expandable: false, traceable: false, clickAction: 'select', doubleClickAction: 'expand' },
  }
}

// The view's own ontology declares Dataset only.
const viewSchema: ResolvedViewSchema = {
  entityTypes: [entityType('Dataset', 'Data Set')],
  relationshipTypes: [],
  containmentEdgeTypes: [],
  lineageEdgeTypes: [],
  rootEntityTypes: [],
}

const layer: ViewLayerConfig = { id: 'L1', name: 'Data', entityTypes: [], order: 0, color: '#4488ff' }

const node = (id: string, typeId: string): HierarchyNode => ({
  id, urn: id, typeId, name: id, data: { label: id }, children: [],
  depth: 0, entityTypeOption: typeId, tags: [],
})

function renderColumn(nodes: HierarchyNode[]) {
  installJsdomLayout()
  const session = stubSession({})
  render(
    <StaticViewSchemaProvider schema={viewSchema}>
      <ViewSearchSessionContext.Provider value={session}>
        <ViewRowSearchContext.Provider value={session.rowSearch}>
          <LayerColumn
            layer={layer}
            // As ContextViewCanvas wires it: the global store's schema.
            schema={useSchemaStore.getState().schema}
            nodes={nodes}
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
      </ViewSearchSessionContext.Provider>
    </StaticViewSchemaProvider>,
  )
}

const row = (id: string) => document.getElementById(`layer-node-${id}`)!

afterEach(() => useSchemaStore.setState({ schema: null }))

describe('Row type badge', () => {
  it("names the type from the view's ontology, ignoring case", () => {
    renderColumn([node('orders', 'dataset')])
    expect(row('orders').textContent).toContain('Data Set')
  })

  it("never borrows a name from the global store's ontology", () => {
    // Another data source's ontology, loaded last into the global store.
    useSchemaStore.setState({
      schema: { entityTypes: [entityType('schemaField', 'Schema Field')], relationshipTypes: [], views: [] } as never,
    })
    renderColumn([node('order_id', 'schemaField')])
    expect(row('order_id').textContent).toContain('schemaField')
    expect(row('order_id').textContent).not.toContain('Schema Field')
  })
})
