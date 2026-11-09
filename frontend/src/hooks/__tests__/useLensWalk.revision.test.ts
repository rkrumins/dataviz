/**
 * At a past revision the Lens walks the flows as they ran then, and asks for no rollup cells: they
 * are the graph as it is now, and the server answers a coarse request there with the fine page the
 * walk asks for anyway.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/features/versioning/hooks/useAtRevision', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/versioning/hooks/useAtRevision')>()
  return { ...actual, useRevisionCapabilities: () => actual.revisionCapabilities(12) }
})

import { useLensWalk } from '../useLensWalk'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'

const FOCUS = 'urn:li:table:orders'

describe('useLensWalk at a past revision', () => {
  it('asks for the fine walk alone', async () => {
    const traceClosure = vi.fn(async (req: Record<string, unknown>) => ({
      nodes: [], edges: [], containmentEdges: [],
      upstreamUrns: new Set(), downstreamUrns: new Set(),
      focus: { urn: req.urn as string, level: 0, entityType: 'table' },
      effectiveLevel: 0, isInherited: false, inheritedFromUrn: null,
      truncated: false, truncationReason: null,
      frontierUp: [], frontierDown: [], seedTruncated: false,
    }))
    const provider = { traceClosure } as unknown as GraphDataProvider
    const { result } = renderHook(() => useLensWalk(FOCUS, provider))
    await waitFor(() => expect(result.current.walkFor(FOCUS)?.status).toBe('done'))
    expect(traceClosure).toHaveBeenCalledTimes(1)
    expect(traceClosure.mock.calls[0][0]).not.toHaveProperty('grain')
  })
})
