/**
 * useLensContainer — "open this container, show only what's inside it
 * that connects to my focal".
 *
 * The contract that matters: it must use the descendant-resolving
 * primitive (expandAggregated), degrade when that capability is absent,
 * and — critically — never mistake the backend's "no edges" response
 * (which carries ALL children) for real content.
 */
import { renderHook, waitFor, act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useLensContainer, containerKey, FRAME_AUTO_STEPS } from '../useLensContainer'
import type { GraphDataProvider } from '@/providers/GraphDataProvider'

const gn = (urn: string, entityType = 'dataset') => ({
  urn, displayName: `label-${urn}`, entityType, properties: {},
})
const ge = (id: string, s: string, t: string) => ({
  id, sourceUrn: s, targetUrn: t, edgeType: 'FLOWS_TO',
})

const result = (nodes: unknown[], edges: unknown[], over: Record<string, unknown> = {}) => ({
  nodes, edges, containmentEdges: [],
  upstreamUrns: new Set<string>(), downstreamUrns: new Set<string>(),
  focus: { urn: 'C', level: 1, entityType: 'container' },
  effectiveLevel: 2, isInherited: false, truncated: false,
  ...over,
})

function makeProvider(impl: (req: { sourceUrn: string; targetUrn: string; nextLevel: number | string }) => unknown) {
  const expandAggregated = vi.fn(async (req: { sourceUrn: string; targetUrn: string; nextLevel: number | string }) => impl(req))
  return { provider: { expandAggregated } as unknown as GraphDataProvider, expandAggregated }
}

describe('useLensContainer', () => {
  it('opens a container against the focal and keeps only what is inside it', async () => {
    const { provider, expandAggregated } = makeProvider(() =>
      result([gn('C', 'container'), gn('kid1'), gn('kid2'), gn('F')], [ge('e1', 'kid1', 'F'), ge('e2', 'kid2', 'F')]))
    const { result: hook } = renderHook(() => useLensContainer('F', provider, ['FLOWS_TO']))
    const key = containerKey('C', 'F', 'in')

    act(() => hook.current.openContainer('C', 'F', 'in', 1))
    await waitFor(() => expect(hook.current.status.get(key)).toBe('done'))

    // Upstream ⇒ the container is the SOURCE anchor, and we ask one
    // grain finer than the container's own level.
    expect(expandAggregated).toHaveBeenCalledWith(expect.objectContaining({
      sourceUrn: 'C', targetUrn: 'F', nextLevel: 2, lineageEdgeTypes: ['FLOWS_TO'],
    }))
    const res = hook.current.results.get(key)!
    // The container itself and the focal are not "inside" it.
    expect(res.nodes.map(n => n.id).sort()).toEqual(['kid1', 'kid2'])
    expect(res.edges).toHaveLength(2)
    expect(res.empty).toBe(false)
  })

  it('reverses the anchors for a downstream container', async () => {
    const { provider, expandAggregated } = makeProvider(() =>
      result([gn('kid1'), gn('F')], [ge('e1', 'F', 'kid1')]))
    const { result: hook } = renderHook(() => useLensContainer('F', provider, []))
    act(() => hook.current.openContainer('C', 'F', 'out', 1))
    await waitFor(() => expect(hook.current.status.get(containerKey('C', 'F', 'out'))).toBe('done'))
    expect(expandAggregated).toHaveBeenCalledWith(expect.objectContaining({ sourceUrn: 'F', targetUrn: 'C' }))
  })

  it('treats a zero-edge response as EMPTY, never as content', async () => {
    // The backend returns every collected child of both anchors when it
    // finds no edges — rendering those would show unrelated entities as
    // though they were connected.
    const { provider } = makeProvider(() =>
      result([gn('kid1'), gn('kid2'), gn('kid3'), gn('kid4'), gn('kid5')], []))
    const { result: hook } = renderHook(() => useLensContainer('F', provider, []))
    const key = containerKey('C', 'F', 'in')
    act(() => hook.current.openContainer('C', 'F', 'in', 1))
    await waitFor(() => expect(hook.current.status.get(key)).toBe('done'))

    const res = hook.current.results.get(key)!
    expect(res.empty).toBe(true)
    expect(res.nodes).toEqual([])
    expect(res.edges).toEqual([])
  })

  it('skips pass-through levels, recording each one it walked through', async () => {
    // C holds exactly one relevant container, which holds two datasets:
    // the user should land on the datasets, with the middle step shown.
    const { provider, expandAggregated } = makeProvider(({ sourceUrn }) =>
      sourceUrn === 'C'
        ? result([gn('mid', 'container'), gn('F')], [ge('e1', 'mid', 'F')])
        : result([gn('kid1'), gn('kid2'), gn('F')], [ge('e2', 'kid1', 'F'), ge('e3', 'kid2', 'F')]))
    const { result: hook } = renderHook(() => useLensContainer('F', provider, []))
    const key = containerKey('C', 'F', 'in')

    act(() => hook.current.openContainer('C', 'F', 'in', 1))
    await waitFor(() => expect(hook.current.status.get(key)).toBe('done'))

    const res = hook.current.results.get(key)!
    expect(res.nodes.map(n => n.id).sort()).toEqual(['kid1', 'kid2'])
    expect(res.passedThrough.map(n => n.id)).toEqual(['mid'])
    // The descent asked one level deeper each step.
    expect(expandAggregated).toHaveBeenNthCalledWith(2, expect.objectContaining({ sourceUrn: 'mid', nextLevel: 3 }))
  })

  it('bounds the pass-through descent', async () => {
    // A chain of single children that never widens must stop.
    let n = 0
    const { provider, expandAggregated } = makeProvider(() =>
      result([gn(`c${++n}`, 'container'), gn('F')], [ge(`e${n}`, `c${n}`, 'F')]))
    const { result: hook } = renderHook(() => useLensContainer('F', provider, []))
    act(() => hook.current.openContainer('C', 'F', 'in', 1))
    await waitFor(() => expect(hook.current.status.get(containerKey('C', 'F', 'in'))).toBe('done'))
    expect(expandAggregated).toHaveBeenCalledTimes(FRAME_AUTO_STEPS)
  })

  it('reports truncation so counts read as floors', async () => {
    const { provider } = makeProvider(() =>
      result([gn('kid1'), gn('F')], [ge('e1', 'kid1', 'F')], { truncated: true, truncationReason: 'max_nodes' }))
    const { result: hook } = renderHook(() => useLensContainer('F', provider, []))
    const key = containerKey('C', 'F', 'in')
    act(() => hook.current.openContainer('C', 'F', 'in', 1))
    await waitFor(() => expect(hook.current.status.get(key)).toBe('done'))
    expect(hook.current.results.get(key)!.truncated).toBe(true)
  })

  it('degrades to unsupported when the provider lacks the capability', async () => {
    const provider = {} as unknown as GraphDataProvider
    const { result: hook } = renderHook(() => useLensContainer('F', provider, []))
    const key = containerKey('C', 'F', 'in')
    act(() => hook.current.openContainer('C', 'F', 'in', 1))
    await waitFor(() => expect(hook.current.status.get(key)).toBe('unsupported'))
    expect(hook.current.results.has(key)).toBe(false)
  })

  it('opens once per key; a failure is retryable but never auto-loops', async () => {
    let fail = true
    // Two children, so a successful open settles here rather than
    // descending through a single pass-through child.
    const { provider, expandAggregated } = makeProvider(() => {
      if (fail) throw new Error('backend down')
      return result([gn('kid1'), gn('kid2'), gn('F')], [ge('e1', 'kid1', 'F'), ge('e2', 'kid2', 'F')])
    })
    const { result: hook } = renderHook(() => useLensContainer('F', provider, []))
    const key = containerKey('C', 'F', 'in')

    act(() => hook.current.openContainer('C', 'F', 'in', 1))
    await waitFor(() => expect(hook.current.status.get(key)).toBe('error'))
    expect(expandAggregated).toHaveBeenCalledTimes(1)

    // A failed open does NOT retry itself — it waits for the user.
    await new Promise(r => setTimeout(r, 20))
    expect(expandAggregated).toHaveBeenCalledTimes(1)

    fail = false
    act(() => hook.current.retry('C', 'F', 'in', 1))
    await waitFor(() => expect(hook.current.status.get(key)).toBe('done'))
    expect(expandAggregated).toHaveBeenCalledTimes(2)

    // A completed open is never refetched.
    act(() => hook.current.openContainer('C', 'F', 'in', 1))
    expect(expandAggregated).toHaveBeenCalledTimes(2)
  })

  it('clears the session when the lens closes', async () => {
    const { provider } = makeProvider(() => result([gn('kid1'), gn('F')], [ge('e1', 'kid1', 'F')]))
    const { result: hook, rerender } = renderHook(
      ({ focal }: { focal: string | null }) => useLensContainer(focal, provider, []),
      { initialProps: { focal: 'F' as string | null } },
    )
    act(() => hook.current.openContainer('C', 'F', 'in', 1))
    await waitFor(() => expect(hook.current.results.size).toBe(1))
    rerender({ focal: null })
    expect(hook.current.results.size).toBe(0)
    expect(hook.current.status.size).toBe(0)
  })
})
