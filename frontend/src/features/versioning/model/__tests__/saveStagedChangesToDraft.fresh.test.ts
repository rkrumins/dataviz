/**
 * A save answers with what it wrote; the canvas takes it — values and tokens — so the next edit of
 * the same entity is checked against the value just saved, not the one first read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/versioningApiService', () => ({ applyGraphChanges: vi.fn() }))
vi.mock('@/hooks/useAggregatedLineage', () => ({ invalidateAggregatedEdges: vi.fn() }))

import { saveStagedChangesToDraft } from '../saveStagedChangesToDraft'
import { applyGraphChanges } from '@/services/versioningApiService'
import { useCanvasStore, type LineageNode } from '@/store/canvas'
import type { StagedChange } from '@/store/stagedChangesStore'

const mockApply = vi.mocked(applyGraphChanges)
const target = { wsId: 'w', dataSourceId: 'ds', branchId: 'b', provider: {} as never }

beforeEach(() => {
  useCanvasStore.setState({
    nodes: [{ id: 'urn:n', type: 'generic', position: { x: 0, y: 0 },
      data: { urn: 'urn:n', label: 'N', type: 'dataset', version: 'v1', properties: { owner: 'bo', sla: '1h' } } } as unknown as LineageNode],
    edges: [], _nodeIndex: new Set(['urn:n']), _edgeIndex: new Set(),
  } as never)
})

describe('saveStagedChangesToDraft — the canvas takes what was stored', () => {
  it('replaces the saved entity’s value and token', async () => {
    mockApply.mockResolvedValue({
      commitId: 'c1', assigned: {},
      entities: { 'urn:n': { kind: 'node', version: 'v2', node: {
        urn: 'urn:n', entityType: 'dataset', displayName: 'N', properties: { owner: 'bo' }, version: 'v2' } } },
    } as never)
    const change: StagedChange = {
      id: 'c', type: 'update_entity', targetId: 'urn:n', targetUrn: 'urn:n', summary: '', timestamp: 0,
      before: { urn: 'urn:n', label: 'N', version: 'v1', properties: { owner: 'ana', sla: '1h' } },
      after: { urn: 'urn:n', label: 'N', version: 'v1', properties: { owner: 'bo' } },
    }
    await saveStagedChangesToDraft([change], target)
    const n = useCanvasStore.getState().nodes[0]
    expect(n.data.version).toBe('v2')
    expect(n.data.properties).toEqual({ owner: 'bo' })
  })
})
