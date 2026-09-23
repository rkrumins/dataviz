/**
 * The wizard names the entities a view places by asking the graph in batches, not one request
 * each: an imported view can place tens of thousands. An entity asked for and not returned is
 * missing; one in a batch that failed is unknown, named from its URN and never called missing.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'
import type { LayerAssignmentEntry } from '@/types/schema'
import { fallbackNameFromUrn, useWizardEntityIndex } from '../useWizardEntityIndex'

const urns = Array.from({ length: 250 }, (_, i) => `urn:li:dataset:(hive,t${i},PROD)`)
const assignments: Record<string, LayerAssignmentEntry> = Object.fromEntries(urns.map(u => [u, { layerId: 'l1', inheritsChildren: true }]))

describe('useWizardEntityIndex — naming what a view places', () => {
  it('asks in batches of a hundred, and tells missing from unknown', async () => {
    const getNodes = vi.fn(async (q: { urns?: string[] }) => {
      const batch = q.urns ?? []
      if (batch.includes(urns[200])) throw new Error('504')                     // the last batch fails
      return batch.filter(u => u !== urns[5]).map(u => ({ urn: u, displayName: `name of ${u}`, entityType: 'dataset', properties: {} }))
    })
    const provider = { getNodes } as unknown as GraphDataProvider
    const { result } = renderHook(() => useWizardEntityIndex({
      provider, containmentEdgeTypes: [], assignments, snapshot: null,
    }))

    await waitFor(() => expect(result.current.resolve(urns[249])).toBeDefined())
    expect(getNodes).toHaveBeenCalledTimes(3)
    expect(getNodes.mock.calls.map(([q]) => q.urns?.length)).toEqual([100, 100, 50])
    expect(result.current.resolve(urns[0])).toMatchObject({ name: `name of ${urns[0]}`, type: 'dataset' })
    expect(result.current.resolve(urns[5])).toMatchObject({ missing: true })
    expect(result.current.resolve(urns[249])).toMatchObject({ name: fallbackNameFromUrn(urns[249]), type: 'unknown' })
    expect(result.current.resolve(urns[249])?.missing).toBeUndefined()
  })
})
