/**
 * Show on canvas in a view the server places: the hit is loaded into the layer the server
 * draws it in, under the containers it nests in there — however far down the layer's pages it
 * is — and selected; one the view draws nowhere says so; one that couldn't be asked about
 * falls back to the walk.
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/queryClient', () => ({ getQueryClient: () => ({}) }))
vi.mock('@/hooks/useViewSchema', () => ({
  useViewContainmentEdgeTypes: () => ['CONTAINS'],
  useViewLineageEdgeTypes: () => ['FLOWS_TO'],
  useViewRootEntityTypes: () => [],
  useViewEntityTypes: () => [],
  useViewSchemaIsReady: () => true,
}))
const loadIntoCanvas = vi.hoisted(() => vi.fn())
vi.mock('@/features/served-placement/loadIntoCanvas', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/served-placement/loadIntoCanvas')>()),
  loadIntoCanvas,
}))

import { useCanvasStore } from '@/store/canvas'

import { useRevealSearchHit } from '../useRevealSearchHit'

const served = (placed: Record<string, { layerId: string | null; inLayer?: number }>) =>
  ({ unavailable: null, get: (u: string) => placed[u] }) as never

describe('useRevealSearchHit — a view the server places', () => {
  beforeEach(() => {
    loadIntoCanvas.mockReset()
    useCanvasStore.setState({ nodes: [], edges: [] } as never)
  })

  it('loads the hit into its layer, opens the containers it nests in there, and selects it', async () => {
    loadIntoCanvas.mockImplementation(async () => {
      useCanvasStore.setState({ nodes: [{
        id: 'col', type: 'default', position: { x: 0, y: 0 },
        data: { urn: 'col', label: 'col', feedLayerId: 'L2', inLayer: 1, ancestorPath: [{ urn: 'db' }, { urn: 'tbl' }] },
      }] } as never)
      return { loaded: ['col'], outside: [], failed: [] }
    })
    const setExpandedNodes = vi.fn()
    const scrollIntoView = vi.fn()
    const { result } = renderHook(() => useRevealSearchHit({
      setExpandedNodes, provider: {} as never, scrollIntoView, served: served({ col: { layerId: 'L2', inLayer: 1 } }),
    }))
    let outcome: unknown
    await act(async () => { outcome = await result.current('col', []) })
    expect(outcome).toMatchObject({ landedOn: 'hit', urn: 'col' })
    expect(loadIntoCanvas.mock.calls[0][2]).toEqual(['col'])
    const opened = setExpandedNodes.mock.calls[0][0](new Set<string>())
    expect([...opened]).toEqual(['logical:context:L2:tbl'])
    expect(useCanvasStore.getState().selectedNodeIds).toContain('col')
    expect(scrollIntoView).toHaveBeenCalledWith('col')
  })

  it('says a hit the view draws nowhere is outside it', async () => {
    loadIntoCanvas.mockResolvedValue({ loaded: [], outside: ['x'], failed: [] })
    const { result } = renderHook(() => useRevealSearchHit({ setExpandedNodes: vi.fn(), provider: {} as never, served: served({}) }))
    let outcome: unknown
    await act(async () => { outcome = await result.current('x', []) })
    expect(outcome).toMatchObject({ landedOn: 'outside', urn: 'x' })
  })
})
