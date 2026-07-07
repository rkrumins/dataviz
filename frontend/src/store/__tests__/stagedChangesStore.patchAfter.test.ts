/**
 * A staged `create_entity` row must be editable in place (rename + details) via the
 * Hierarchy Builder, with the edits surviving to the eventual backend save. The apply
 * hook reads from the shared `after` object (patched by `patchAfter`/`updateStagedEntity`)
 * instead of stale closure values captured at stage time.
 */
import { renderHook } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useStageEntityCreation } from '@/components/canvas/create/useStageEntityCreation'
import { useCanvasStore } from '@/store/canvas'
import { useStagedChangesStore } from '../stagedChangesStore'

const resetStores = () => {
  useCanvasStore.setState({ nodes: [], edges: [], _nodeIndex: new Set(), _edgeIndex: new Set() } as never)
  useStagedChangesStore.setState({ changes: [], redoStack: [], _scopeKey: null, _byScope: {} })
}

const staged = () => useStagedChangesStore.getState().changes
const node = (id: string) => useCanvasStore.getState().nodes.find((n) => n.id === id)

describe('stagedChangesStore.patchAfter + useStageEntityCreation.updateStagedEntity', () => {
  beforeEach(resetStores)

  it('edits survive to save: apply reads the patched after object, not stale closures', async () => {
    const { result } = renderHook(() => useStageEntityCreation())
    const tempUrn = result.current.stageEntity({ entityType: 'dataset', displayName: 'Orders' })

    result.current.updateStagedEntity(tempUrn, {
      displayName: 'Renamed',
      tags: ['t1'],
      properties: { description: 'd' },
    })

    const createNode = vi.fn().mockResolvedValue({
      success: true,
      node: {
        urn: 'urn:real:1',
        entityType: 'dataset',
        displayName: 'Renamed',
        tags: ['t1'],
        properties: { description: 'd' },
      },
      containmentEdge: null,
    })
    const provider = { createNode } as never

    const change = staged().find((c) => c.targetUrn === tempUrn)!
    await change.apply!({
      provider,
      wsId: 'ws',
      resolveTempId: () => undefined,
      registerTempIdResolution: vi.fn(),
    })

    expect(createNode).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'Renamed',
        tags: ['t1'],
        properties: expect.objectContaining({ description: 'd' }),
      }),
    )
  })

  it('mirrors edits to the optimistic canvas node', () => {
    const { result } = renderHook(() => useStageEntityCreation())
    const tempUrn = result.current.stageEntity({ entityType: 'dataset', displayName: 'Orders' })

    result.current.updateStagedEntity(tempUrn, { displayName: 'Renamed', tags: ['t1'] })

    const n = node(tempUrn)
    expect(n?.data.label).toBe('Renamed')
    expect(n?.data.classifications).toEqual(['t1'])
  })

  it('rebuilds the summary on rename and bumps the changes array reference', () => {
    const { result } = renderHook(() => useStageEntityCreation())
    const tempUrn = result.current.stageEntity({ entityType: 'dataset', displayName: 'Orders' })

    const before = staged()
    result.current.updateStagedEntity(tempUrn, { displayName: 'Renamed' })
    const after = staged()

    expect(after).not.toBe(before)
    const change = after.find((c) => c.targetUrn === tempUrn)!
    expect(change.summary).toContain('Renamed')
  })

  it('merges properties patches instead of replacing them', () => {
    const { result } = renderHook(() => useStageEntityCreation())
    const tempUrn = result.current.stageEntity({
      entityType: 'dataset',
      displayName: 'Orders',
      properties: { owner: 'alice' },
    })

    result.current.updateStagedEntity(tempUrn, { properties: { description: 'd' } })

    const change = staged().find((c) => c.targetUrn === tempUrn)!
    expect((change.after as { properties: Record<string, unknown> }).properties).toEqual({
      owner: 'alice',
      description: 'd',
    })
    // Canvas node mirrors the same merged properties.
    expect(node(tempUrn)?.data.properties).toEqual({ owner: 'alice', description: 'd' })
  })

  it('updateStagedEntity no-ops for an unknown temp urn', () => {
    const { result } = renderHook(() => useStageEntityCreation())
    const before = staged()
    expect(() => result.current.updateStagedEntity('urn:missing', { displayName: 'X' })).not.toThrow()
    expect(staged()).toBe(before)
  })

  it('patchAfter no-ops for an unknown change id', () => {
    const before = staged()
    expect(() =>
      useStagedChangesStore.getState().patchAfter('missing-id', { displayName: 'X' }),
    ).not.toThrow()
    expect(staged()).toBe(before)
  })
})
