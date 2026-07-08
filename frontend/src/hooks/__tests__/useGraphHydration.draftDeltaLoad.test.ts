/**
 * `useGraphHydration` — draft closed-scope load actually FETCHES branch-created
 * entities, including the case where the "committed in this branch" half of the
 * delta only becomes known AFTER this hook's initial mount effect has already
 * fired (the real reload scenario: `activeChangeSet` is populated asynchronously
 * by `CanvasVersioningBar`'s diff-vs-main query, which mounts alongside — not
 * before — `useGraphHydration`'s hydrating effect in `CanvasRouter`).
 *
 * Pinned here:
 *  - draft + closed-scope: first fetch is assigned-only (delta not resolved yet);
 *    once the committed delta resolves, the hook RE-FETCHES with the union.
 *  - non-draft (main): the same later `activeChangeSet` update does NOT trigger
 *    a second fetch — the mandatory "no-delta / non-draft loads exactly as
 *    before" regression guard.
 */
import { renderHook, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// NOTE: every array below is a module-level (hoisted) constant, not an inline
// literal returned fresh per call — a real selector is referentially stable
// across renders when the underlying data hasn't changed, and several of
// these arrays are effect dependencies inside useGraphHydration. A
// fresh-array-per-call mock would make the dependency array "change" on
// every render and re-trigger the mount effect in a loop, unrelated to
// anything under test here.
const { mockProvider, viewLayers, EMPTY, activeView } = vi.hoisted(() => {
  const EMPTY: never[] = []
  // Layer needs an `id` so normalizeReferenceLayout up-converts the legacy entityAssignment
  // into a layer-keyed assignment; entityScope 'curated' makes this a closed-scope view that
  // loads strictly by its assigned URNs (the behaviour under test).
  const viewLayers = [{ id: 'layer-1', entityAssignments: [{ entityId: 'urn:assigned' }] }]
  const activeView = {
    id: 'v1',
    layout: { type: 'reference', referenceLayout: { layers: viewLayers } },
    content: { visibleEntityTypes: EMPTY, entityScope: 'curated' },
  }
  return {
    mockProvider: {
      getNodes: vi.fn(async (opts: { urns?: string[] }) =>
        (opts.urns ?? []).map(urn => ({
          urn,
          entityType: 'thing',
          displayName: urn,
          properties: {},
        })),
      ),
      getEdgesBetween: vi.fn(async () => []),
      getChildren: vi.fn(async () => []),
    },
    viewLayers,
    EMPTY,
    activeView,
  }
})

vi.mock('@/providers/GraphProviderContext', () => ({
  useGraphProvider: () => mockProvider,
  useGraphProviderContext: () => ({ providerVersion: 1 }),
}))
vi.mock('@/hooks/useViewSchema', () => ({
  useViewContainmentEdgeTypes: () => EMPTY,
  useViewLineageEdgeTypes: () => EMPTY,
  useViewRootEntityTypes: () => EMPTY,
  useViewEntityTypes: () => EMPTY,
  useViewSchemaIsReady: () => true,
}))
vi.mock('@/store/schema', () => ({
  useActiveView: () => activeView,
  isContainmentEdgeType: () => false,
  normalizeEdgeType: (t: string) => t,
}))

import { useGraphHydration } from '../useGraphHydration'
import { useBranchStore } from '@/store/branchStore'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { buildChangeSet } from '@/features/versioning/model/changeModel'

function urnsRequestedIn(callIndex: number): string[] {
  return (mockProvider.getNodes.mock.calls[callIndex][0].urns as string[]).slice().sort()
}

describe('useGraphHydration — draft closed-scope load union (reload timing)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockProvider.getNodes.mockImplementation(async (opts: { urns?: string[] }) =>
      (opts.urns ?? []).map(urn => ({ urn, entityType: 'thing', displayName: urn, properties: {} })),
    )
    useStagedChangesStore.setState({ changes: [], _scopeKey: null, _byScope: {} } as any)
    useBranchStore.setState({ currentBranchId: null, mainBranchId: 'main1', activeChangeSet: null } as any)
  })

  it('draft: fetches assigned-only first, then RE-FETCHES the union once the committed delta resolves', async () => {
    useBranchStore.setState({ currentBranchId: 'br1', mainBranchId: 'main1', activeChangeSet: null } as any)

    renderHook(() => useGraphHydration({ hydrate: true }))

    await waitFor(() => expect(mockProvider.getNodes).toHaveBeenCalledTimes(1))
    expect(urnsRequestedIn(0)).toEqual(['urn:assigned'])

    // The async diff-vs-main query (CanvasVersioningBar) resolves AFTER mount,
    // revealing a previously-committed branch-created entity.
    act(() => {
      useBranchStore.getState().setActiveChangeSet(
        buildChangeSet([
          {
            entityId: 'urn:created',
            kind: 'node',
            status: 'added',
            label: 'Created Thing',
            origin: { source: 'branch', branchId: 'br1' },
          },
        ]),
      )
    })

    await waitFor(() => expect(mockProvider.getNodes).toHaveBeenCalledTimes(2))
    expect(urnsRequestedIn(1)).toEqual(['urn:assigned', 'urn:created'])
  })

  it('main (non-draft): the same later activeChangeSet update does NOT trigger a second fetch', async () => {
    useBranchStore.setState({ currentBranchId: null, mainBranchId: 'main1', activeChangeSet: null } as any)

    renderHook(() => useGraphHydration({ hydrate: true }))

    await waitFor(() => expect(mockProvider.getNodes).toHaveBeenCalledTimes(1))
    expect(urnsRequestedIn(0)).toEqual(['urn:assigned'])

    act(() => {
      useBranchStore.getState().setActiveChangeSet(
        buildChangeSet([
          {
            entityId: 'urn:created',
            kind: 'node',
            status: 'added',
            label: 'Created Thing',
            origin: { source: 'branch', branchId: 'br1' },
          },
        ]),
      )
    })

    // Give any (unwanted) async re-fetch a chance to happen, then assert it didn't.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(mockProvider.getNodes).toHaveBeenCalledTimes(1)
  })
})
