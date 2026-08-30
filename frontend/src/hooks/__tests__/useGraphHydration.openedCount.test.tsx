/**
 * "Opened “Customer 360” · 1,204 items" must count the entities that arrived.
 *
 * An OPEN-scope view (no assignments — the default) hydrates BY TYPE, and that
 * load spans two phases: 'roots' fetches the root types, then 'children'
 * fetches the remaining visible types, and only after that second fetch are
 * the nodes committed with `setGraph`. Hydration had already emptied the store
 * on line one of the attempt, so a success message fired at the roots→children
 * hop counted an empty store and announced "· 0 items" — immediately followed
 * by "Connections · 3,918", which contradicted it.
 *
 * The canvas therefore holds the notification across BOTH phases; the falling
 * edge is the move to 'edges', which is behind the store write on the curated
 * path too. Pinned here against the real hook, the real notification store and
 * the real `useLoadingNotification` — the wiring itself is pinned in
 * `loadMessages.test.ts` (the canvas cannot be mounted in jsdom).
 */
import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** The fields of the provider's GraphNode that this journey reads. */
interface FetchedNode { urn: string; entityType: string; displayName: string }

const { mockProvider } = vi.hoisted(() => ({
  mockProvider: {
    getNodes: vi.fn(async (_query: { entityTypes?: string[] }): Promise<FetchedNode[]> => []),
    getEdgesBetween: vi.fn(async () => []),
    getChildren: vi.fn(async () => []),
  },
}))

vi.mock('@/providers/GraphProviderContext', () => ({
  useGraphProvider: () => mockProvider,
  useGraphProviderContext: () => ({ providerVersion: 1 }),
}))
vi.mock('@/hooks/useViewSchema', () => ({
  useViewContainmentEdgeTypes: () => ['CONTAINS'],
  useViewLineageEdgeTypes: () => ['FLOWS_TO'],
  useViewRootEntityTypes: () => ['database'],
  useViewEntityTypes: () => [
    { id: 'database', hierarchy: { canBeContainedBy: [], canContain: ['table'] } },
    { id: 'table', hierarchy: { canBeContainedBy: ['database'], canContain: [] } },
  ],
  useViewSchemaIsReady: () => true,
}))
vi.mock('@/store/schema', () => ({
  // No assignments ⇒ entityScope 'all' ⇒ the type-based branch, where
  // `remainingTypes` is non-empty and the 'children' phase is rendered.
  useActiveView: () => ({
    id: 'v1',
    layout: { type: 'reference', referenceLayout: { layers: [] } },
    content: { visibleEntityTypes: ['database', 'table'] },
  }),
  isContainmentEdgeType: () => false,
  normalizeEdgeType: (t: string) => t,
}))

import { useGraphHydration } from '../useGraphHydration'
import { useCanvasStore } from '@/store/canvas'
import { useLoadingNotification, useNotificationStore } from '@/components/ui/notifications'
import { openedViewMessage, openingViewMessage } from '@/components/canvas/context-view/loadMessages'

const node = (urn: string, entityType: string): FetchedNode => ({ urn, entityType, displayName: urn })

/**
 * ContextViewCanvas's wiring, verbatim, minus the 5k lines around it. It reads
 * the phase through the canvas store, which CanvasRouter mirrors from this
 * hook — a mirror preserves the order, which is the whole subject here.
 */
function Probe() {
  const { hydrationPhase } = useGraphHydration({ hydrate: true })
  useLoadingNotification(
    'ctx-hydrating-entities',
    hydrationPhase === 'roots' || hydrationPhase === 'children',
    openingViewMessage('Customer 360'),
    () => openedViewMessage('Customer 360', useCanvasStore.getState().nodes.length),
    false,
  )
  return null
}

describe('the message that announces an opened view', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useNotificationStore.getState().clearHistory()
    useCanvasStore.getState().setGraph([], [])
    // Both fetches take a MACROTASK, as a real one does. Resolving inside the
    // microtask queue lets React coalesce roots→children→edges into a single
    // render, and a harness that never renders the 'children' phase can never
    // see the bug it was written for.
    mockProvider.getNodes.mockImplementation(async ({ entityTypes }) => {
      await new Promise(r => setTimeout(r, 5))
      return entityTypes?.[0] === 'database'
        ? [node('urn:db:a', 'database'), node('urn:db:b', 'database')]
        : [node('urn:t:1', 'table'), node('urn:t:2', 'table'), node('urn:t:3', 'table')]
    })
  })

  it('counts everything the type-based load brought back, roots and the rest', async () => {
    render(<Probe />)

    await waitFor(() =>
      expect(useNotificationStore.getState().history.map(h => h.message))
        .toContain('Opened “Customer 360” · 5 items'),
    )
    // The load really did run through the second, non-root type — otherwise
    // this test would pass on the very sequence it exists to catch.
    expect(mockProvider.getNodes).toHaveBeenCalledWith(
      expect.objectContaining({ entityTypes: ['table'] }),
    )
    expect(useNotificationStore.getState().history.map(h => h.message))
      .not.toContain('Opened “Customer 360” · 0 items')
  })
})
