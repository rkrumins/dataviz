/**
 * useWizardEntityIndex keeps the placement facts of the children a page brings
 * in, so the contract's rail places a child it loaded itself by its tags and
 * stamp, not by its type alone.
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useWizardEntityIndex } from '../useWizardEntityIndex'

const makeProvider = () => ({
  getNodes: vi.fn().mockResolvedValue([]),
  getChildrenWithEdges: vi.fn().mockResolvedValue({
    children: [{
      urn: 'urn:k', entityType: 'dataset', displayName: 'Orders',
      tags: ['gold'], properties: { owner: 'finance' }, layerAssignment: 'right',
    }],
    containmentEdges: [], lineageEdges: [], hasMore: false,
  }),
})

describe('useWizardEntityIndex — child facts', () => {
  it('keeps the facts of a loaded child, and forgets them with the provider', async () => {
    let provider = makeProvider()
    const { result, rerender } = renderHook(() => useWizardEntityIndex({
      provider: provider as never, containmentEdgeTypes: ['CONTAINS'], assignments: {}, snapshot: null,
    }))
    const before = result.current.factsOf
    expect(before?.('urn:k')).toBeUndefined()

    await act(async () => { await result.current.loadChildren('urn:p') })
    expect(result.current.factsOf).not.toBe(before)   // a new answer, so consumers re-place
    expect(result.current.factsOf?.('urn:k')).toEqual({
      urn: 'urn:k', entityType: 'dataset', displayName: 'Orders',
      tags: ['gold'], properties: { owner: 'finance' }, stamp: 'right',
    })

    provider = makeProvider()
    rerender()
    expect(result.current.factsOf?.('urn:k')).toBeUndefined()
  })
})
