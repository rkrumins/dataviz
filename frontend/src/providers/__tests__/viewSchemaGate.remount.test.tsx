/**
 * ViewSchemaGate — the canvas must not be REMOUNTED by a schema re-key.
 *
 * The gate renders its children through a render prop, so returning the loading
 * UI early does not overlay the canvas — it destroys it, taking the React Flow
 * instance, the open lens, the trace and the camera with it. `providerVersion` is
 * part of the schema query key and moves on its own (a projection watermark
 * catching up, a provider health recovery), so before this was guarded, ordinary
 * background activity tore the canvas down and rebuilt it: the flicker.
 *
 * The two cases pull in opposite directions and both matter:
 *   1. Same scope, new version  -> children keep their mount.
 *   2. Different workspace      -> children MUST remount, because serving
 *      workspace A's ontology under workspace B's provider is the exact
 *      cross-workspace contamination the version key exists to prevent.
 */
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEffect, useRef } from 'react'

// ─── Mocks ──────────────────────────────────────────────────────────────
// The gate is the subject; everything it needs to exist is stubbed flat.

const schemaState: { data: unknown; isLoading: boolean; isError: boolean } = {
  data: undefined,
  isLoading: true,
  isError: false,
}

vi.mock('@/hooks/useGraphSchema', () => ({
  GRAPH_SCHEMA_QUERY_KEY: ['graph', 'schema'],
  useGraphSchema: () => ({ ...schemaState, error: null, refetch: vi.fn(), meta: null }),
}))

vi.mock('@/providers/providerPool', () => ({
  getOrCreateProvider: () => ({ getStats: () => Promise.resolve({}) }),
  poolKey: (...parts: unknown[]) => parts.join('/'),
}))

vi.mock('@/store/branchStore', () => ({
  useBranchStore: (sel: (s: unknown) => unknown) => sel({ mainEpoch: 0 }),
  useEffectiveBranchId: () => null,
}))

vi.mock('@/store/workspaces', () => ({
  useWorkspacesStore: (sel: (s: unknown) => unknown) => sel({ workspaces: [] }),
}))

vi.mock('@/store/providerStatus', () => ({ useProviderStatus: () => null }))

vi.mock('./../GraphProviderContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../GraphProviderContext')>()
  return {
    ...actual,
    useGraphProviderContext: () => ({
      provider: { getStats: () => Promise.resolve({}) },
      isLoading: false,
      error: null,
      scopeKind: 'ready',
      workspaceId: 'ws-1',
      dataSourceId: 'ds-1',
      providerReady: true,
      providerVersion: 1,
    }),
  }
})

import { ViewExecutionProvider } from '../ViewExecutionContext'

// Shaped for the real `convertBackend*` converters — the gate resolves the raw
// payload for real, so a flat stub would blow up inside `resolveSchema`.
const SCHEMA = {
  entityTypes: [{
    id: 'Table',
    name: 'Table',
    visual: { icon: 'table', color: '#fff', shape: 'rect', size: 'md', borderStyle: 'solid', showInMinimap: true },
    fields: [],
    hierarchy: { level: 0, canContain: [], canBeContainedBy: [], defaultExpanded: false },
    behavior: {
      selectable: true, draggable: true, expandable: true, traceable: true,
      clickAction: 'select', doubleClickAction: 'expand',
    },
  }],
  relationshipTypes: [{
    id: 'FEEDS',
    name: 'Feeds',
    sourceTypes: ['Table'],
    targetTypes: ['Table'],
    visual: {
      strokeColor: '#888', strokeWidth: 1, strokeStyle: 'solid', animated: false,
      animationSpeed: 'normal', arrowType: 'arrow', curveType: 'bezier',
    },
    bidirectional: false,
    showLabel: false,
    isContainment: false,
    isLineage: true,
  }],
  containmentEdgeTypes: ['CONTAINS'],
  lineageEdgeTypes: ['FEEDS'],
  rootEntityTypes: ['Table'],
}

/** Counts how many times it MOUNTS (not how often it renders). */
function MountCounter({ onMount }: { onMount: () => void }) {
  const seen = useRef(false)
  useEffect(() => {
    if (seen.current) return
    seen.current = true
    onMount()
  }, [onMount])
  return <div data-testid="canvas">canvas</div>
}

describe('ViewSchemaGate — remount behaviour', () => {
  beforeEach(() => {
    schemaState.data = undefined
    schemaState.isLoading = true
    schemaState.isError = false
  })

  it('keeps children mounted when only the schema version moves', async () => {
    const mounts = vi.fn()
    const view = (workspaceId: string) => (
      <ViewExecutionProvider workspaceId={workspaceId} dataSourceId="ds-1" viewId="v-1">
        <MountCounter onMount={mounts} />
      </ViewExecutionProvider>
    )

    // First load resolves: the canvas mounts once.
    schemaState.data = SCHEMA
    schemaState.isLoading = false
    const { rerender } = render(view('ws-1'))
    expect(await screen.findByTestId('canvas')).toBeInTheDocument()
    expect(mounts).toHaveBeenCalledTimes(1)

    // A re-key: the query goes pending with no data for the new key. Before the
    // fix this returned the spinner instead of `children`, destroying the canvas.
    schemaState.data = undefined
    schemaState.isLoading = true
    rerender(view('ws-1'))

    expect(screen.getByTestId('canvas')).toBeInTheDocument()
    expect(screen.queryByText(/Loading view schema/i)).not.toBeInTheDocument()
    expect(mounts).toHaveBeenCalledTimes(1)

    // ...and when the refetch lands, still the same mount.
    schemaState.data = SCHEMA
    schemaState.isLoading = false
    rerender(view('ws-1'))
    expect(mounts).toHaveBeenCalledTimes(1)
  })

  it('still gates on a real scope change, so one workspace never shows another ontology', () => {
    const mounts = vi.fn()
    const view = (workspaceId: string) => (
      <ViewExecutionProvider workspaceId={workspaceId} dataSourceId="ds-1" viewId="v-1">
        <MountCounter onMount={mounts} />
      </ViewExecutionProvider>
    )

    schemaState.data = SCHEMA
    schemaState.isLoading = false
    const { rerender } = render(view('ws-1'))
    expect(mounts).toHaveBeenCalledTimes(1)

    // New workspace, schema not yet loaded for it: the cached one belongs to the
    // OLD scope, so it must not be served — the gate closes.
    schemaState.data = undefined
    schemaState.isLoading = true
    rerender(view('ws-2'))

    expect(screen.queryByTestId('canvas')).not.toBeInTheDocument()
    expect(screen.getByText(/Loading view schema/i)).toBeInTheDocument()
  })
})
