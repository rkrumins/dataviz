/**
 * useExpandBelow — a level at a time, or every level, against a fake loader:
 * which level comes next, nested roots, the checkpoint and its choices (more,
 * everything, stop — and a prompt closed without choosing), Cancel and the
 * depth guard. The canvas's own loader and queue are not in this picture on purpose:
 * the hook's whole job is to ask for first pages and wait for them.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { useNotificationStore } from '@/components/ui/notifications'

import {
  CHECKPOINT_EVERY, MAX_EXPAND_DEPTH, isPausedOn, nextLevel, outermost, useExpandBelow, type ExpandBelowDeps,
} from '../useExpandBelow'

type Tree = Record<string, string[]>

// R ⊃ {A, B}; A ⊃ {a1, a2}; B ⊃ {b1}; a1 ⊃ {x}.
const TREE: Tree = { R: ['A', 'B'], A: ['a1', 'a2'], B: ['b1'], a1: ['x'] }

const parentsOf = (tree: Tree) => {
  const parents: Record<string, string> = {}
  for (const [p, kids] of Object.entries(tree)) for (const k of kids) parents[k] = p
  return parents
}

/** A canvas in miniature: what is open, what is loaded, what is on its way. */
function useFakeCanvas(tree: Tree, opts: { hold?: boolean; weight?: number; firstPageSize?: number; batched?: boolean } = {}) {
  const parents = parentsOf(tree)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [loaded, setLoaded] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set())
  const asked = useRef<string[]>([])
  const batches = useRef<string[][]>([])
  const cancelled = useRef<string[]>([])
  const deps: ExpandBelowDeps = {
    expanded,
    childrenOf: (id) => loaded[id] ?? [],
    isContainer: (id) => (tree[id]?.length ?? 0) > 0,
    parentOf: (id) => parents[id],
    open: (ids) => setExpanded((prev) => new Set([...prev, ...ids])),
    loadFirstPage: (id) => {
      asked.current.push(id)
      setLoading((prev) => new Set([...prev, id]))
      if (opts.hold) return new Promise(() => {})
      return Promise.resolve().then(() => {
        setLoaded((prev) => ({ ...prev, [id]: tree[id] ?? [] }))
        setLoading((prev) => { const next = new Set(prev); next.delete(id); return next })
      })
    },
    // A loader that lands a whole level's first pages together.
    ...(opts.batched ? {
      loadFirstPages: (ids: readonly string[]) => {
        batches.current.push([...ids])
        setLoading((prev) => new Set([...prev, ...ids]))
        return Promise.resolve().then(() => {
          setLoaded((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id) => [id, tree[id] ?? []])) }))
          setLoading((prev) => new Set([...prev].filter((id) => !ids.includes(id))))
        })
      },
    } : {}),
    cancelLoad: (id) => { cancelled.current.push(id) },
    loading,
    // Each loaded entity counts `weight` — enough to reach a checkpoint with a small tree.
    loadedCount: () => Object.values(loaded).flat().length * (opts.weight ?? 1),
    firstPageSize: opts.firstPageSize ? () => opts.firstPageSize! : undefined,
    labelOf: (id) => id,
  }
  const api = useExpandBelow(deps)
  return { api, expanded, asked, batches, cancelled }
}

const toasts = () => useNotificationStore.getState().notifications
const lastToast = () => toasts()[toasts().length - 1]

afterEach(() => { useNotificationStore.setState({ notifications: [] }) })

describe('nextLevel', () => {
  const tree = (open: string[], loaded: Tree = TREE) => ({
    expanded: new Set(open),
    childrenOf: (id: string) => loaded[id] ?? [],
    isContainer: (id: string) => (TREE[id]?.length ?? 0) > 0,
  })

  it('a closed root is its own first level', () => {
    expect(nextLevel(['R'], tree([]))).toEqual({ ids: ['R'], depth: 0 })
  })

  it('then the closed containers at the shallowest depth beneath the open ones', () => {
    expect(nextLevel(['R'], tree(['R']))).toEqual({ ids: ['A', 'B'], depth: 1 })
    expect(nextLevel(['R'], tree(['R', 'A', 'B']))).toEqual({ ids: ['a1'], depth: 2 })
    expect(nextLevel(['R'], tree(['R', 'A', 'B', 'a1']))).toEqual({ ids: [], depth: -1 })
  })

  it('only through what is loaded', () => {
    expect(nextLevel(['R'], tree(['R'], {}))).toEqual({ ids: [], depth: -1 })
  })

  it('outermost drops a root inside another', () => {
    const parents = parentsOf(TREE)
    expect(outermost(['a1', 'R', 'B', 'zz'], (id) => parents[id])).toEqual(['R', 'zz'])
  })

  it('a paused run is on the rows with its roots, in any order, and no others', () => {
    const paused = { roots: ['A', 'B'], message: '', detail: '' }
    expect(isPausedOn(paused, ['B', 'A'])).toBe(true)
    expect(isPausedOn(paused, ['A'])).toBe(false)
    expect(isPausedOn(paused, ['A', 'R'])).toBe(false)
    expect(isPausedOn(null, ['A', 'B'])).toBe(false)
  })
})

describe('useExpandBelow', () => {
  it('opens one level per press, loading each container\'s first page, until everything is open', async () => {
    const { result } = renderHook(() => useFakeCanvas(TREE))

    act(() => result.current.api.expand(['R'], false))
    await waitFor(() => expect(result.current.api.running).toBe(false))
    expect([...result.current.expanded]).toEqual(['R'])
    expect(lastToast().message).toBe('Opened level 1 inside “R” · 2 loaded')

    act(() => result.current.api.expand(['R'], false))
    await waitFor(() => expect(result.current.api.running).toBe(false))
    expect([...result.current.expanded].sort()).toEqual(['A', 'B', 'R'])

    act(() => result.current.api.expand(['R'], false))
    await waitFor(() => expect(result.current.api.running).toBe(false))
    expect([...result.current.expanded].sort()).toEqual(['A', 'B', 'R', 'a1'])
    expect(result.current.asked.current).toEqual(['R', 'A', 'B', 'a1'])

    act(() => result.current.api.expand(['R'], false))
    await waitFor(() => expect(result.current.api.running).toBe(false))
    expect(lastToast().message).toBe('Everything inside “R” is already open')
  })

  it('a root inside another selected root is not a root of its own', async () => {
    const { result } = renderHook(() => useFakeCanvas(TREE))
    act(() => result.current.api.expand(['A', 'R'], false))
    await waitFor(() => expect(result.current.api.running).toBe(false))
    expect([...result.current.expanded]).toEqual(['R'])
  })

  it('All levels repeats the next level until nothing is left, saying how it is doing', async () => {
    const { result } = renderHook(() => useFakeCanvas(TREE))
    act(() => result.current.api.expand(['R'], true))
    expect(lastToast()).toMatchObject({ type: 'loading', message: 'Opening “R” · level 1 · 1 container', action: { label: 'Cancel' } })
    await waitFor(() => expect(result.current.api.running).toBe(false))
    expect([...result.current.expanded].sort()).toEqual(['A', 'B', 'R', 'a1'])
    expect(lastToast()).toMatchObject({ type: 'success', message: 'Opened everything inside “R” · 6 loaded' })
    // One toast all along: the progress replaced itself, then gave way to the result.
    expect(toasts().filter((t) => t.type === 'loading')).toEqual([])
  })

  it(`pauses every ${CHECKPOINT_EVERY.toLocaleString()} newly loaded entities and asks: more, everything, or stop`, async () => {
    const { result } = renderHook(() => useFakeCanvas(TREE, { weight: CHECKPOINT_EVERY }))
    act(() => result.current.api.expand(['R'], true))
    await waitFor(() => expect(result.current.api.paused).not.toBeNull())
    // Not busy: a prompt the reader may close, saying what is left at the next level.
    expect(lastToast()).toMatchObject({
      type: 'loading',
      paused: true,
      message: 'Paused opening “R”\u00a0· 4,000 loaded so far',
      detail: '2 containers still to open at level 2',
      action: { label: 'Load 2,000 more' },
      secondaryAction: { label: 'Load everything' },
      tertiaryAction: { label: 'Stop here' },
    })
    expect(result.current.api.paused).toEqual({
      roots: ['R'], message: 'Paused opening “R”\u00a0· 4,000 loaded so far', detail: '2 containers still to open at level 2',
    })
    expect([...result.current.expanded]).toEqual(['R'])
    expect(result.current.api.running).toBe(true)

    // Load 2,000 more: on to the next checkpoint, and the same question there.
    act(() => lastToast().action!.onClick())
    expect(result.current.api.paused).toBeNull()
    expect(lastToast()).toMatchObject({ type: 'loading', message: 'Opening “R” · level 2 · 2 containers · 4,000 loaded' })
    await waitFor(() => expect(result.current.api.paused).not.toBeNull())
    expect([...result.current.expanded].sort()).toEqual(['A', 'B', 'R'])
    expect(lastToast()).toMatchObject({
      message: 'Paused opening “R”\u00a0· 10,000 loaded so far', detail: '1 container still to open at level 3',
    })
  })

  it('Load everything goes on to the end without pausing again', async () => {
    const { result } = renderHook(() => useFakeCanvas(TREE, { weight: CHECKPOINT_EVERY }))
    act(() => result.current.api.expand(['R'], true))
    await waitFor(() => expect(result.current.api.paused).not.toBeNull())
    const prompts: string[] = []
    const unsubscribe = useNotificationStore.subscribe((s) => {
      for (const n of s.notifications) if (n.paused && !prompts.includes(n.message)) prompts.push(n.message)
    })
    try {
      act(() => lastToast().secondaryAction!.onClick())
      await waitFor(() => expect(result.current.api.running).toBe(false))
    } finally { unsubscribe() }
    expect(prompts).toEqual([])
    expect([...result.current.expanded].sort()).toEqual(['A', 'B', 'R', 'a1'])
    expect(lastToast()).toMatchObject({ type: 'success', message: 'Opened everything inside “R” · 12,000 loaded' })
  })

  it('Load everything opens the rest of a wide level at once — no batches to fit a checkpoint', async () => {
    const wide: Tree = { W: Array.from({ length: 10 }, (_, i) => `c${i}`) }
    for (let i = 0; i < 10; i++) wide[`c${i}`] = Array.from({ length: 500 }, (_, j) => `c${i}.${j}`)
    const { result } = renderHook(() => useFakeCanvas(wide, { firstPageSize: 500, batched: true }))
    act(() => result.current.api.expand(['W'], true))
    await waitFor(() => expect(result.current.api.paused).not.toBeNull())
    expect(result.current.api.paused!.detail).toBe('6 containers still to open at level 2')
    act(() => result.current.api.resume('all'))
    await waitFor(() => expect(result.current.api.running).toBe(false))
    expect(result.current.batches.current).toEqual([['W'], ['c0', 'c1', 'c2', 'c3'], ['c4', 'c5', 'c6', 'c7', 'c8', 'c9']])
  })

  it('Stop here keeps what loaded — and All levels again goes on from the shallowest level still closed', async () => {
    const { result } = renderHook(() => useFakeCanvas(TREE, { weight: CHECKPOINT_EVERY }))
    act(() => result.current.api.expand(['R'], true))
    await waitFor(() => expect(result.current.api.paused).not.toBeNull())
    act(() => lastToast().tertiaryAction!.onClick())
    expect(result.current.api.running).toBe(false)
    expect(result.current.api.paused).toBeNull()
    expect([...result.current.expanded]).toEqual(['R'])
    expect(lastToast()).toMatchObject({ type: 'info', message: 'Stopped opening “R” · 4,000 loaded' })
    expect(toasts().filter((t) => t.type === 'loading')).toEqual([])

    act(() => result.current.api.expand(['R'], true))
    expect(lastToast().message).toBe('Opening “R” · level 2 · 2 containers')
    await waitFor(() => expect(result.current.api.paused).not.toBeNull())
    expect(result.current.asked.current).toEqual(['R', 'A', 'B'])
  })

  it('closing the prompt leaves the run paused, to go on from wherever the canvas offers it', async () => {
    const { result } = renderHook(() => useFakeCanvas(TREE, { weight: CHECKPOINT_EVERY }))
    act(() => result.current.api.expand(['R'], true))
    await waitFor(() => expect(result.current.api.paused).not.toBeNull())
    // Its ✕.
    act(() => useNotificationStore.getState().remove(lastToast().id))
    expect(toasts()).toEqual([])
    expect(result.current.api.running).toBe(true)
    expect(result.current.api.paused?.roots).toEqual(['R'])

    act(() => result.current.api.resume('all'))
    await waitFor(() => expect(result.current.api.running).toBe(false))
    expect([...result.current.expanded].sort()).toEqual(['A', 'B', 'R', 'a1'])
  })

  it('a new expand replaces a paused run', async () => {
    const { result } = renderHook(() => useFakeCanvas(TREE, { weight: CHECKPOINT_EVERY }))
    act(() => result.current.api.expand(['R'], true))
    await waitFor(() => expect(result.current.api.paused).not.toBeNull())
    act(() => result.current.api.expand(['A'], false))
    expect(result.current.api.paused).toBeNull()
    expect(toasts().map((t) => t.message)).toEqual(['Stopped opening “R” · 4,000 loaded', 'Opening “A” · level 1 · 1 container'])
    await waitFor(() => expect(result.current.api.running).toBe(false))
    expect([...result.current.expanded].sort()).toEqual(['A', 'R'])
  })

  it('a checkpoint with nothing left to open ends the run instead of asking', async () => {
    // R ⊃ {x, y}: its one level brings 2 × 2,000 — past the checkpoint, and nothing beneath.
    const { result } = renderHook(() => useFakeCanvas({ R: ['x', 'y'] }, { weight: CHECKPOINT_EVERY }))
    act(() => result.current.api.expand(['R'], true))
    await waitFor(() => expect(result.current.api.running).toBe(false))
    expect(result.current.api.paused).toBeNull()
    expect(lastToast()).toMatchObject({ type: 'success', message: 'Opened everything inside “R” · 4,000 loaded' })
  })

  it('opens a wide level in batches that fit before the next checkpoint, so it pauses near it', async () => {
    // W ⊃ c0…c9, each holding 500.
    const wide: Tree = { W: Array.from({ length: 10 }, (_, i) => `c${i}`) }
    for (let i = 0; i < 10; i++) wide[`c${i}`] = Array.from({ length: 500 }, (_, j) => `c${i}.${j}`)
    const { result } = renderHook(() => useFakeCanvas(wide, { firstPageSize: 500 }))
    act(() => result.current.api.expand(['W'], true))
    await waitFor(() => expect(result.current.api.paused).not.toBeNull())
    // 10 loaded opening W, then four of the ten (≈2,000 more) — not all ten (5,000).
    expect([...result.current.expanded].sort()).toEqual(['W', 'c0', 'c1', 'c2', 'c3'])
    expect(lastToast().message).toBe('Paused opening “W”\u00a0· 2,010 loaded so far')
    // Six of the level's ten are still closed.
    expect(lastToast().detail).toBe('6 containers still to open at level 2')

    act(() => lastToast().action!.onClick())
    await waitFor(() => expect(result.current.expanded.size).toBe(9))
  })

  it('Cancel stops the run and the pages on their way; what is open stays', async () => {
    const { result } = renderHook(() => useFakeCanvas(TREE, { hold: true }))
    act(() => result.current.api.expand(['R'], true))
    await waitFor(() => expect(result.current.asked.current).toEqual(['R']))
    act(() => result.current.api.cancel())
    expect(result.current.api.running).toBe(false)
    expect(result.current.cancelled.current).toEqual(['R'])
    expect([...result.current.expanded]).toEqual(['R'])
    expect(lastToast()).toMatchObject({ type: 'info', message: 'Stopped opening “R”' })
  })

  it('asks a loader that batches for a whole level at once, and only for what is not loaded', async () => {
    const { result } = renderHook(() => useFakeCanvas(TREE, { batched: true }))
    act(() => result.current.api.expand(['R'], true))
    await waitFor(() => expect(result.current.api.running).toBe(false))
    expect([...result.current.expanded].sort()).toEqual(['A', 'B', 'R', 'a1'])
    // One call per level, never one per container.
    expect(result.current.batches.current).toEqual([['R'], ['A', 'B'], ['a1']])
    expect(result.current.asked.current).toEqual([])
    expect(lastToast()).toMatchObject({ type: 'success', message: 'Opened everything inside “R” · 6 loaded' })
  })

  it(`stops at ${MAX_EXPAND_DEPTH} levels, whatever the graph says`, async () => {
    // A chain deeper than any containment: c0 ⊃ c1 ⊃ … ⊃ c59.
    const chain: Tree = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`c${i}`, [`c${i + 1}`]]))
    const { result } = renderHook(() => useFakeCanvas(chain))
    act(() => result.current.api.expand(['c0'], true))
    await waitFor(() => expect(result.current.api.running).toBe(false), { timeout: 5000 })
    expect(result.current.expanded.size).toBe(MAX_EXPAND_DEPTH)
    expect(lastToast().message).toMatch(new RegExp(`^Stopped at ${MAX_EXPAND_DEPTH} levels inside “c0”`))
  })

  it('Load everything is still bounded by the depth limit — and still cancellable', async () => {
    const chain: Tree = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`c${i}`, [`c${i + 1}`]]))
    // Every level loads a checkpoint's worth.
    const { result } = renderHook(() => useFakeCanvas(chain, { weight: CHECKPOINT_EVERY }))
    act(() => result.current.api.expand(['c0'], true))
    await waitFor(() => expect(result.current.api.paused).not.toBeNull())
    act(() => result.current.api.resume('all'))
    await waitFor(() => expect(result.current.api.running).toBe(false), { timeout: 5000 })
    expect(result.current.expanded.size).toBe(MAX_EXPAND_DEPTH)
    expect(lastToast().message).toMatch(new RegExp(`^Stopped at ${MAX_EXPAND_DEPTH} levels inside “c0”`))

    const held = renderHook(() => useFakeCanvas(TREE, { weight: CHECKPOINT_EVERY }))
    act(() => held.result.current.api.expand(['R'], true))
    await waitFor(() => expect(held.result.current.api.paused).not.toBeNull())
    act(() => held.result.current.api.resume('all'))
    expect(lastToast().action?.label).toBe('Cancel')
    act(() => lastToast().action!.onClick())
    expect(held.result.current.api.running).toBe(false)
    expect(lastToast()).toMatchObject({ type: 'info', message: 'Stopped opening “R” · 4,000 loaded' })
  })
})
