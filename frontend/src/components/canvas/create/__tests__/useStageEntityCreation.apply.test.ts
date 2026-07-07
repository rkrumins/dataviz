/**
 * apply() swaps the optimistic temp node for the backend-issued one. The swap
 * must be FULL fidelity: losing `childCount` made the post-save collapse →
 * expand cycle destructive (collapse drops the saved containment edges
 * expecting `loadChildren` to refetch; a missing childCount short-circuits the
 * refetch, permanently orphaning the children — the "flat model" bug, which
 * also breaks HARD-RULE layer inheritance), and losing the OCC `version`
 * broke optimistic concurrency on post-save edits.
 */
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore } from '@/store/canvas'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import { useStageEntityCreation } from '../useStageEntityCreation'

const resetStores = () => {
  useCanvasStore.setState({ nodes: [], edges: [], _nodeIndex: new Set(), _edgeIndex: new Set() } as never)
  useStagedChangesStore.setState({ changes: [] } as never)
}

describe('useStageEntityCreation — apply() node swap fidelity', () => {
  beforeEach(resetStores)

  it('carries childCount (floored at staged children) and the OCC version through the swap', async () => {
    const { result } = renderHook(() => useStageEntityCreation())

    let parentTemp = ''
    act(() => {
      parentTemp = result.current.stageEntity({ entityType: 'container', displayName: 'A' })
      result.current.stageEntity({
        entityType: 'dataset', displayName: 'B', parentUrn: parentTemp, containmentEdgeType: 'CONTAINS',
      })
    })

    const change = useStagedChangesStore.getState().changes.find((c) => c.targetUrn === parentTemp)!
    const provider = {
      createNode: async () => ({
        success: true,
        node: {
          urn: 'urn:real:A', displayName: 'A', entityType: 'container',
          tags: [], properties: {}, version: 'occ-1', childCount: 0,
        },
      }),
    } as unknown as GraphDataProvider

    await act(async () => {
      await change.apply!({
        provider,
        wsId: 'ws1',
        resolveTempId: () => undefined,
        registerTempIdResolution: () => {},
      } as never)
    })

    const nodes = useCanvasStore.getState().nodes
    expect(nodes.find((n) => n.id === parentTemp)).toBeUndefined() // temp gone
    const swapped = nodes.find((n) => n.id === 'urn:real:A')!
    expect(swapped).toBeTruthy()
    // The backend reports 0 children at create time (this node's children
    // apply right after it in the same save) — the canvas knows better:
    // floor childCount at the node's staged children so the post-save
    // collapse → expand cycle can always refetch.
    expect(swapped.data.childCount).toBe(1)
    expect(swapped.data.version).toBe('occ-1')
    expect(swapped.data.label).toBe('A')
  })
})
