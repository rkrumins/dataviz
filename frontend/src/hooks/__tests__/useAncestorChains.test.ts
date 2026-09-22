/**
 * useAncestorChains — asks where the canvas's unloaded lineage ends live.
 *
 * Only the ends that need it (lineage, not containment; not loaded; not a
 * logical group), each asked once; an answer is kept, a failure re-asked on
 * the next settle, and a reader with no containment walk left alone.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useCanvasStore } from '@/store/canvas'

const holder: { current: Record<string, unknown> } = { current: {} }
vi.mock('@/providers', async (original) => ({
  ...(await original<typeof import('@/providers')>()),
  useGraphProvider: () => holder.current,
}))

import { useAncestorChains } from '../useAncestorChains'

const node = (id: string) => ({ id, type: 'entity', position: { x: 0, y: 0 }, data: { urn: id } })
const link = (id: string, source: string, target: string, edgeType = 'FLOWS_TO') =>
  ({ id, source, target, data: { edgeType } })
const isContainment = (t: string) => t === 'CONTAINS'

function seed(version: number, edges = [
  link('e1', 'loaded-a', 'far-x'),
  link('e2', 'far-y', 'loaded-b'),
  link('e3', 'loaded-a', 'child-c', 'CONTAINS'),
  link('e4', 'loaded-a', 'logical:group-1'),
]) {
  act(() => {
    useCanvasStore.setState({
      nodes: [node('loaded-a'), node('loaded-b')] as never,
      edges: edges as never,
      _version: version,
    })
  })
}

beforeEach(() => { seed(1) })
afterEach(() => {
  act(() => { useCanvasStore.setState({ nodes: [], edges: [] }) })
  holder.current = {}
})

describe('useAncestorChains', () => {
  it('asks once for the unloaded lineage ends, and keeps the answers', async () => {
    const getAncestorChains = vi.fn(async (urns: string[]) =>
      Object.fromEntries(urns.map(u => [u, ['warehouse']])))
    holder.current = { getAncestorChains }

    const { result } = renderHook(() => useAncestorChains(true, isContainment))
    await waitFor(() => expect(result.current.get('far-x')).toEqual(['warehouse']))

    expect(getAncestorChains).toHaveBeenCalledTimes(1)
    expect(getAncestorChains.mock.calls[0][0].sort()).toEqual(['far-x', 'far-y'])
  })

  it('does not ask again for an end it already asked about', async () => {
    const getAncestorChains = vi.fn(async (urns: string[]) =>
      Object.fromEntries(urns.map(u => [u, ['warehouse']])))
    holder.current = { getAncestorChains }

    const { result } = renderHook(() => useAncestorChains(true, isContainment))
    await waitFor(() => expect(result.current.size).toBe(2))
    seed(2, [link('e1', 'loaded-a', 'far-x'), link('e5', 'loaded-a', 'far-z')])
    await waitFor(() => expect(getAncestorChains).toHaveBeenCalledTimes(2))
    expect(getAncestorChains.mock.calls[1][0]).toEqual(['far-z'])
  })

  it('asks again on the next settle after a failure', async () => {
    const getAncestorChains = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 429 }))
      .mockImplementation(async (urns: string[]) => Object.fromEntries(urns.map(u => [u, []])))
    holder.current = { getAncestorChains }

    const { result } = renderHook(() => useAncestorChains(true, isContainment))
    await waitFor(() => expect(getAncestorChains).toHaveBeenCalledTimes(1))
    seed(2)
    await waitFor(() => expect(result.current.get('far-x')).toEqual([]))
    expect(getAncestorChains).toHaveBeenCalledTimes(2)
  })

  it('leaves a reader with no containment walk alone', async () => {
    const getAncestorChains = vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { status: 501 }))
    holder.current = { getAncestorChains }

    renderHook(() => useAncestorChains(true, isContainment))
    await waitFor(() => expect(getAncestorChains).toHaveBeenCalledTimes(1))
    seed(2)
    await new Promise(r => setTimeout(r, 450))
    expect(getAncestorChains).toHaveBeenCalledTimes(1)
  })

  it('asks nothing while off', async () => {
    const getAncestorChains = vi.fn()
    holder.current = { getAncestorChains }
    renderHook(() => useAncestorChains(false, isContainment))
    await new Promise(r => setTimeout(r, 450))
    expect(getAncestorChains).not.toHaveBeenCalled()
  })
})
