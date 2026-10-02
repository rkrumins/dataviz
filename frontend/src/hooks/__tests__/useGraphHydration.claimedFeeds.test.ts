/**
 * Rules + assignments: what a reference view loads.
 *
 * An open view used to feed every type in `content.visibleEntityTypes` — and
 * treat a type the ontology lacks as a root — so the canvas fetched entities
 * no layer claimed (`schemaField`, phantom ids) and drew them.
 *
 * Pinned here:
 *  - claimedFeedTypes: the types the layers claim (`layer.entityTypes`), in the
 *    ontology's declared spelling; a type the ontology lacks, a visible type no
 *    layer claims and a `showUnassigned` layer add nothing;
 *  - an open view feeds exactly those types and loads its placements by URN; with
 *    none claimed it loads by placement alone;
 *  - a rule edit that claims a new type pages it in place, a dropped claim loads
 *    nothing, and a curated view, which never feeds by type, does not re-hydrate;
 *  - an open draft fetches the roots its branch created.
 */
import { renderHook, waitFor, act } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ViewLayerConfig } from '@/types/schema'

const { mockProvider, view, ONTOLOGY } = vi.hoisted(() => ({
  mockProvider: {
    getNodes: vi.fn(async (q: { urns?: string[] }) =>
      (q.urns ?? []).map(u => ({ urn: u, entityType: 'domain', displayName: u }))),
    getNodesPage: vi.fn(async (q: { entityTypes?: string[] }) => ({
      nodes: [{ urn: `urn:${q.entityTypes?.[0]}:1`, entityType: q.entityTypes?.[0], displayName: 'x' }],
      hasMore: false,
      nextOffset: 1,
    })),
    getEdges: vi.fn(async () => []),
    getEdgesBetween: vi.fn(async () => []),
    getChildren: vi.fn(async () => []),
    getChildrenWithEdges: vi.fn(async () => ({
      children: [], containmentEdges: [], lineageEdges: [], totalChildren: 0, hasMore: false, nextOffset: 0,
    })),
  },
  view: {
    layers: [] as ViewLayerConfig[],
    assignments: {} as Record<string, { layerId: string }>,
    visible: [] as string[],
    scope: 'all' as 'all' | 'curated',
  },
  ONTOLOGY: [
    { id: 'domain', hierarchy: { canBeContainedBy: [], canContain: ['dataset'] } },
    { id: 'dataset', hierarchy: { canBeContainedBy: ['domain'], canContain: [] } },
  ],
}))

vi.mock('@/providers/GraphProviderContext', () => ({
  useGraphProvider: () => mockProvider,
  useGraphProviderContext: () => ({ providerVersion: 1 }),
}))
vi.mock('@/hooks/useViewSchema', () => ({
  useViewContainmentEdgeTypes: () => ['CONTAINS'],
  useViewLineageEdgeTypes: () => ['FLOWS_TO'],
  useViewRootEntityTypes: () => ['domain'],
  useViewEntityTypes: () => ONTOLOGY,
  useViewSchemaIsReady: () => true,
}))
vi.mock('@/store/schema', () => ({
  useActiveView: () => ({
    id: 'v-claims',
    layout: {
      type: 'reference',
      referenceLayout: { layers: view.layers, assignments: view.assignments },
    },
    content: { visibleEntityTypes: view.visible, entityScope: view.scope },
  }),
  isContainmentEdgeType: (edgeType: string, types: string[]) =>
    types.some((t) => t.toUpperCase() === edgeType.toUpperCase()),
  normalizeEdgeType: (e: { data?: { edgeType?: string } }) => (e.data?.edgeType || '').toUpperCase(),
}))
vi.mock('@/config/polling', () => ({
  POLLING_INTERVALS: { providerRetry: 10, providerRetrySlow: 20 },
  PROVIDER_RETRY_MAX_ATTEMPTS: 1,
  withJitter: (ms: number) => ms,
}))

import { claimedFeedTypes, useGraphHydration } from '../useGraphHydration'
import { useCanvasStore } from '@/store/canvas'
import { useBranchStore } from '@/store/branchStore'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import { buildChangeSet } from '@/features/versioning/model/changeModel'
import type { EntityTypeDefinition } from '@/providers/GraphDataProvider'

const layer = (id: string, entityTypes: string[], extra: Partial<ViewLayerConfig> = {}): ViewLayerConfig =>
  ({ id, name: id, entityTypes, order: 0, ...extra })
const ontology = (...ids: string[]) => ids.map(id => ({ id })) as unknown as EntityTypeDefinition[]

/** The entity types each getNodesPage call asked for, in call order. */
const fedTypes = () =>
  (mockProvider.getNodesPage.mock.calls as unknown as Array<[{ entityTypes?: string[] }]>).map(c => c[0].entityTypes)
/** The URNs each getNodes call asked for, in call order. */
const askedUrns = () =>
  (mockProvider.getNodes.mock.calls as unknown as Array<[{ urns?: string[] }]>).map(c => c[0].urns ?? [])

async function hydrate() {
  const hydrating = renderHook(() => useGraphHydration({ hydrate: true }))
  await waitFor(() => expect(hydrating.result.current.hydrationStatus).toBe('ready'))
  return hydrating
}

describe('claimedFeedTypes', () => {
  it('is the types the layers claim', () => {
    expect(claimedFeedTypes([layer('L1', ['domain'])], ontology('domain', 'dataset'))).toEqual(['domain'])
  })

  it('drops a type the ontology lacks and answers in the declared spelling', () => {
    expect(claimedFeedTypes(
      [layer('L1', ['Domain', 'schemaField', 'bounded-context'])], ontology('domain', 'dataset'),
    )).toEqual(['domain'])
    expect(claimedFeedTypes([layer('L1', ['domain'])], ontology('Domain'))).toEqual(['Domain'])
  })

  it('is empty when no layer claims a type', () => {
    expect(claimedFeedTypes([layer('L1', []), layer('L2', [])], ontology('domain', 'dataset'))).toEqual([])
  })

  it('adds nothing for a layer that takes unassigned entities', () => {
    expect(claimedFeedTypes(
      [layer('L1', ['domain']), layer('L2', [], { showUnassigned: true })], ontology('domain', 'dataset'),
    )).toEqual(['domain'])
  })

  it('counts a type a layer rule claims', () => {
    expect(claimedFeedTypes(
      [layer('L1', [], { rules: [{ id: 'r1', entityTypes: ['Dataset'], priority: 0 }] })], ontology('domain', 'dataset'),
    )).toEqual(['dataset'])
  })

  it('names a type two layers claim once', () => {
    expect(claimedFeedTypes(
      [layer('L1', ['domain']), layer('L2', ['DOMAIN', 'dataset'])], ontology('domain', 'dataset'),
    )).toEqual(['domain', 'dataset'])
  })
})

describe('useGraphHydration — an open view loads Rules + assignments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    view.layers = []
    view.assignments = {}
    view.visible = []
    view.scope = 'all'
    useCanvasStore.getState().setGraph([], [])
    useStagedChangesStore.setState({ changes: [], _scopeKey: null, _byScope: {} } as never)
    useBranchStore.setState({ currentBranchId: null, mainBranchId: 'main1', activeChangeSet: null } as never)
  })

  it('feeds only the types a layer claims, never other visible types', async () => {
    view.layers = [layer('L1', ['domain'])]
    view.visible = ['domain', 'dataset', 'schemaField']
    await hydrate()
    expect(fedTypes()).toEqual([['domain']])
  })

  it('drops a claimed type the ontology lacks and asks in the declared spelling', async () => {
    view.layers = [layer('L1', ['Domain', 'schemaField'])]
    view.visible = ['Domain', 'schemaField']
    await hydrate()
    expect(fedTypes()).toEqual([['domain']])
  })

  it('loads strictly by placement when no layer claims a type', async () => {
    view.layers = [layer('L1', [])]
    view.assignments = { 'urn:a': { layerId: 'L1' } }
    view.visible = ['domain', 'dataset']
    await hydrate()
    expect(mockProvider.getNodesPage).not.toHaveBeenCalled()
    expect(askedUrns()).toEqual([['urn:a']])
  })

  it('loads no type for a layer that takes unassigned entities', async () => {
    view.layers = [layer('L1', [], { showUnassigned: true })]
    view.visible = ['domain', 'dataset']
    await hydrate()
    expect(mockProvider.getNodesPage).not.toHaveBeenCalled()
  })

  it('loads a type a rule edit claims, without a reload', async () => {
    view.layers = [layer('L1', ['domain'])]
    const hydrating = await hydrate()
    expect(fedTypes()).toEqual([['domain']])

    act(() => { view.layers = [layer('L1', ['domain', 'dataset'])] })
    hydrating.rerender()
    await waitFor(() => expect(fedTypes()).toContainEqual(['dataset']))
    await waitFor(() => expect(hydrating.result.current.hydrationStatus).toBe('ready'))
    expect(useCanvasStore.getState().nodes.map(n => n.id)).toEqual(
      expect.arrayContaining(['urn:domain:1', 'urn:dataset:1']))
  })

  it('loads nothing and does not re-hydrate when a claim is dropped', async () => {
    view.layers = [layer('L1', ['domain']), layer('L2', ['dataset'])]
    const hydrating = await hydrate()
    const pages = mockProvider.getNodesPage.mock.calls.length
    const between = mockProvider.getEdgesBetween.mock.calls.length

    act(() => { view.layers = [layer('L1', ['domain'])] })
    hydrating.rerender()
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
    expect(mockProvider.getNodesPage).toHaveBeenCalledTimes(pages)
    expect(mockProvider.getEdgesBetween).toHaveBeenCalledTimes(between)
    expect(hydrating.result.current.hydrationStatus).toBe('ready')
  })

  it('does not re-hydrate a curated view when a layer’s types change', async () => {
    view.scope = 'curated'
    view.layers = [layer('L1', ['domain'])]
    view.assignments = { 'urn:a': { layerId: 'L1' } }
    const hydrating = await hydrate()
    expect(mockProvider.getNodes).toHaveBeenCalledTimes(1)

    act(() => { view.layers = [layer('L1', ['domain', 'dataset'])] })
    hydrating.rerender()
    await act(async () => { await new Promise(r => setTimeout(r, 50)) })
    expect(mockProvider.getNodes).toHaveBeenCalledTimes(1)
    expect(mockProvider.getNodesPage).not.toHaveBeenCalled()
  })

  it('fetches the roots an open draft created, by URN', async () => {
    useBranchStore.setState({
      currentBranchId: 'br1',
      mainBranchId: 'main1',
      activeChangeSet: buildChangeSet([{
        entityId: 'urn:created',
        kind: 'node',
        status: 'added',
        label: 'x',
        origin: { source: 'branch', branchId: 'br1' },
      }]),
    } as never)
    view.layers = [layer('L1', ['domain'])]
    await hydrate()
    expect(fedTypes()).toEqual([['domain']])
    expect(askedUrns().some(urns => urns.includes('urn:created'))).toBe(true)
  })
})
