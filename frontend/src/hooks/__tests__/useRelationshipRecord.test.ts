import { createElement, type ReactNode } from 'react'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi } from 'vitest'
import { pickRelationship, useRelationshipRecord } from '../useRelationshipRecord'
import { useStagedChangesStore } from '@/store/stagedChangesStore'
import type { GraphEdge } from '@/providers/GraphDataProvider'

const getEdges = vi.hoisted(() => vi.fn(async () => []))
vi.mock('@/providers/GraphProviderContext', () => ({
  useGraphProviderContext: () => ({ provider: { getEdges }, providerVersion: 0 }),
}))

const ge = (id: string, sourceUrn: string, targetUrn: string, edgeType = 'FLOWS_TO'): GraphEdge =>
  ({ id, sourceUrn, targetUrn, edgeType, properties: {} })

describe('pickRelationship', () => {
  const ref = { id: 'e1', source: 'a', target: 'b', edgeType: 'FLOWS_TO' }

  it('takes the relationship by its own id', () => {
    expect(pickRelationship([ge('e0', 'a', 'b', 'PRODUCES'), ge('e1', 'a', 'b')], ref)?.id).toBe('e1')
  })

  it('finds it by (source, target, type) when the canvas holds another id for it', () => {
    // A trace reads a relationship under FalkorDB's internal id; a save re-keys a drawn one.
    expect(pickRelationship([ge('ent_9', 'a', 'b', 'flows_to'), ge('ent_8', 'a', 'b', 'PRODUCES')], { ...ref, id: '1234' })?.id)
      .toBe('ent_9')
  })

  it('does not guess between two relationships of the same type', () => {
    expect(pickRelationship([ge('x', 'a', 'b'), ge('y', 'a', 'b')], { ...ref, id: 'zzz' })).toBeUndefined()
  })

  it('does not match the reverse direction', () => {
    expect(pickRelationship([ge('x', 'b', 'a')], { ...ref, id: 'zzz' })).toBeUndefined()
  })
})

describe('useRelationshipRecord', () => {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: new QueryClient() }, children)

  it.each(['create_edge', 'reverse_edge'] as const)('one a %s stages is not saved yet: nothing stored is read for it', (type) => {
    useStagedChangesStore.setState({ changes: [{ id: 'c1', type, targetId: 'staged-edge-1', after: {}, summary: '', timestamp: 0 }] } as never)
    const { result } = renderHook(() => useRelationshipRecord({ id: 'staged-edge-1', source: 'a', target: 'b', edgeType: 'FLOWS_TO' }), { wrapper })
    expect(result.current).toMatchObject({ unsaved: true, entityId: 'staged-edge-1', record: undefined })
    expect(getEdges).not.toHaveBeenCalled()
  })
})
