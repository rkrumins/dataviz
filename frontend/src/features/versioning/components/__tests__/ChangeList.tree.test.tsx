/**
 * A change list top-down: the top level first, each container saying how many changes sit under
 * it; a level read when its container opens (and a page more when asked); → / ← open, step in, close
 * and climb. Searching lists what matches anywhere, each with where it sits, and "In hierarchy"
 * opens the way down to it. The layout chosen is remembered; Business starts top-down.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ChangeListRow, ChangeListSummary, ChangeTreeItem, ChangeTreeLevel } from '@/services/versioningApiService'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; getItemKey?: (i: number) => string | number }) => ({
    getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({
      index, key: opts.getItemKey ? opts.getItemKey(index) : index, start: index * 54, size: 54,
    })),
    getTotalSize: () => opts.count * 54,
    measureElement: () => undefined,
    scrollToIndex: () => undefined,
  }),
}))
const api = vi.hoisted(() => ({
  getChangeEntries: vi.fn(), getChangeEntry: vi.fn(), getChangeTreeLevel: vi.fn(), getChangeTreePath: vi.fn(),
  getReviewChangeTreeLevel: vi.fn(),
}))
vi.mock('@/services/versioningApiService', async (orig) => ({
  ...(await orig<typeof import('@/services/versioningApiService')>()),
  ...api,
}))

import { ChangeList } from '../ChangeList'
import { flattenTree, TOP, TREE_PAGE, type TreeLevel } from '../../hooks/useChangeTree'
import { usePreferencesStore } from '@/store/preferences'
import { usePersonaStore } from '@/store/persona'

const NONE = { added: 0, modified: 0, removed: 0 }
const summary: ChangeListSummary = {
  origin: { branchId: 'br_1' }, counts: { added: 1, modified: 2, removed: 0 }, entityCounts: { added: 1, modified: 2, removed: 0 },
  edgeCounts: NONE, structureCounts: NONE, impact: { Table: 3 },
  byType: [{ kind: 'node', type: 'Table', added: 1, modified: 2, removed: 0 }],
  total: 3, listed: 3, approximate: false, tooLarge: null, window: null,
}
const change = (entityId: string, name: string, status: 'added' | 'modified' = 'modified'): ChangeListRow => ({
  entityId, kind: 'node', status, type: 'Table', structural: false, displayName: name,
  fields: { changed: 1, added: 0, removed: 0, total: 1, top: [{ label: 'owner', kind: 'changed', before: 'ana', after: 'bo' }] },
})
const container = (id: string, name: string, inside: Partial<ChangeTreeItem['inside']>): ChangeTreeItem => ({
  id, name, type: 'Schema', hasChildren: true, inside: { ...NONE, ...inside },
})
const level = (items: ChangeTreeItem[], over: Partial<ChangeTreeLevel> = {}): ChangeTreeLevel => ({
  items, total: items.length, offset: 0, limit: 100, hasMore: false, path: [], ...over,
})
const LEVELS: Record<string, ChangeTreeLevel> = {
  '': level([container('S1', 'sales', { added: 1, modified: 2 })]),
  S1: level([
    { id: 'T1', hasChildren: true, inside: { ...NONE, modified: 1 }, change: change('T1', 'orders') },
    { id: 'T2', hasChildren: false, inside: NONE, change: change('T2', 'refunds', 'added') },
  ]),
  T1: level([{ id: 'C1', hasChildren: false, inside: NONE, change: change('C1', 'amount') }]),
}

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset())
  usePreferencesStore.setState({ changeListLayout: 'tree' })
  api.getChangeTreeLevel.mockImplementation((_ws, _g, _o, parent: string | null) => Promise.resolve(LEVELS[parent ?? '']))
  api.getReviewChangeTreeLevel.mockImplementation((_ws, _pr, parent: string | null) => Promise.resolve(LEVELS[parent ?? '']))
  api.getChangeEntries.mockResolvedValue({
    entries: [{ ...change('C1', 'amount'), path: ['sales', 'orders'] }], total: 1, offset: 0, limit: 100, hasMore: false,
  })
  api.getChangeTreePath.mockResolvedValue({ entityId: 'C1', at: 0, path: [{ id: 'S1', name: 'sales', at: 0 }, { id: 'T1', name: 'orders', at: 0 }] })
})

function renderList(props: Partial<Parameters<typeof ChangeList>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>
    <ChangeList wsId="ws1" graphId="g1" origin={{ branchId: 'br_1' }} summary={summary} {...props} />
  </QueryClientProvider>)
}
const tree = () => screen.getByRole('list', { name: 'Changes, top-down' })
const rowNamed = (name: RegExp) => within(tree()).getAllByRole('button').find((b) => b.id.startsWith('change-tree-') && name.test(b.textContent ?? ''))!

describe('ChangeList — top-down', () => {
  it('starts at the top, each container saying how many changes sit under it, and reads a level as it opens', async () => {
    renderList()
    expect(await screen.findByText('sales')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Hierarchy/ })).toHaveAttribute('aria-checked', 'true')
    expect(within(tree()).getByText('3 inside')).toBeInTheDocument()
    expect(api.getChangeTreeLevel).toHaveBeenCalledWith('ws1', 'g1', { branchId: 'br_1' }, null, 0, TREE_PAGE, true)
    expect(api.getChangeEntries).not.toHaveBeenCalled()
    fireEvent.click(rowNamed(/sales/))
    expect(await within(tree()).findByText('orders')).toBeInTheDocument()
    expect(api.getChangeTreeLevel).toHaveBeenCalledWith('ws1', 'g1', { branchId: 'br_1' }, 'S1', 0, TREE_PAGE, true)
    // A change in the tree is the list's own row: its summary, opened to its key differences.
    expect(within(tree()).getAllByText(/Edited owner/).length).toBeGreaterThan(0)
    const items = within(tree()).getAllByRole('listitem')
    expect(items.map((i) => i.getAttribute('aria-level'))).toEqual(['1', '2', '2'])
  })

  it('opens, steps in, closes and climbs with → and ←', async () => {
    renderList()
    await screen.findByText('sales')
    const sales = rowNamed(/sales/)
    fireEvent.keyDown(sales, { key: 'ArrowRight' })
    expect(await within(tree()).findByText('orders')).toBeInTheDocument()
    fireEvent.keyDown(sales, { key: 'ArrowRight' })
    expect(rowNamed(/orders/)).toHaveAttribute('tabindex', '0')
    // Where it sits, from the top.
    expect(within(screen.getByRole('navigation', { name: 'Where this sits' })).getByText('sales')).toBeInTheDocument()
    fireEvent.keyDown(rowNamed(/orders/), { key: 'ArrowLeft' })
    expect(rowNamed(/sales/)).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(rowNamed(/sales/), { key: 'ArrowLeft' })
    await waitFor(() => expect(within(tree()).queryByText('orders')).not.toBeInTheDocument())
  })

  it('reads a page more of a long level when asked', async () => {
    api.getChangeTreeLevel.mockImplementation((_ws, _g, _o, parent: string | null, offset: number) => Promise.resolve(
      parent === null
        ? level([container(`S${offset}`, `schema ${offset}`, { modified: 1 })], { total: 250, offset, hasMore: offset < 200 })
        : LEVELS.S1))
    renderList()
    fireEvent.click(await screen.findByRole('button', { name: 'Show 100 more of 249' }))
    await waitFor(() => expect(api.getChangeTreeLevel).toHaveBeenCalledWith('ws1', 'g1', { branchId: 'br_1' }, null, 100, TREE_PAGE, true))
    expect(await within(tree()).findByText('schema 100')).toBeInTheDocument()
  })

  it('searches every change anywhere, each saying where it sits — and opens the way down to one', async () => {
    renderList()
    await screen.findByText('sales')
    fireEvent.change(screen.getByPlaceholderText('Search every change, anywhere…'), { target: { value: 'amount' } })
    await waitFor(() => expect(api.getChangeEntries).toHaveBeenLastCalledWith('ws1', 'g1', { branchId: 'br_1' },
      expect.objectContaining({ kind: undefined, q: 'amount' }), 0, 100, true, true))
    expect(await screen.findByText('sales › orders')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show amount in the hierarchy' }))
    await waitFor(() => expect(api.getChangeTreePath).toHaveBeenCalledWith('ws1', 'g1', { branchId: 'br_1' }, 'C1'))
    // Its containers open, and it is the current row, opened.
    await waitFor(() => expect(rowNamed(/amount/)).toHaveAttribute('tabindex', '0'))
    expect(rowNamed(/amount/)).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByPlaceholderText('Search every change, anywhere…')).toHaveValue('')
  })

  it("lays a draft's review out from its own tree, each change with its decision", async () => {
    renderList({ review: { prId: 'pr1', canComment: false, canResolve: false, decisions: { canDecide: true } } as never })
    expect(await screen.findByText('sales')).toBeInTheDocument()
    expect(api.getReviewChangeTreeLevel).toHaveBeenCalledWith('ws1', 'pr1', null, 0, TREE_PAGE, true)
    expect(api.getChangeTreeLevel).not.toHaveBeenCalled()
  })

  it('remembers the layout chosen; Business starts top-down, Technical as a list', async () => {
    usePreferencesStore.setState({ changeListLayout: null })
    act(() => { usePersonaStore.setState({ mode: 'business' }) })
    renderList()
    expect(await screen.findByRole('radio', { name: /Hierarchy/ })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: /List/ }))
    expect(usePreferencesStore.getState().changeListLayout).toBe('list')
    act(() => { usePersonaStore.setState({ mode: 'technical' }) })
  })
})

describe('flattenTree', () => {
  const lv = (over: Partial<TreeLevel>): TreeLevel => ({ items: [], start: 0, total: 0, loading: false, error: false, retry: () => {}, ...over })
  const item = (id: string, hasChildren = false): ChangeTreeItem => ({ id, hasChildren, inside: NONE, name: id })

  it('draws open levels depth first, with what is left to read and what failed', () => {
    const retry = vi.fn()
    const levels = new Map<string, TreeLevel>([
      [TOP, lv({ items: [item('A', true), item('B', true)], total: 5 })],
      ['A', lv({ items: [item('A1')], start: 100, total: 300 })],
      ['B', lv({ error: true, retry, total: null })],
    ])
    const rows = flattenTree(levels, new Set(['A', 'B']))
    expect(rows.map((r) => `${r.kind}:${r.depth}:${'item' in r ? r.item.id : r.parent}`)).toEqual([
      'item:0:A', 'earlier:1:A', 'item:1:A1', 'more:1:A', 'item:0:B', 'error:1:B', 'more:0:',
    ])
    expect(rows.find((r) => r.kind === 'more' && r.parent === 'A')).toMatchObject({ count: 100, left: 199 })
    expect(rows.find((r) => r.kind === 'item' && r.key === 'A1')).toMatchObject({ posinset: 101, setsize: 300 })
  })

  it('says a level is loading until its first page is read', () => {
    expect(flattenTree(new Map([[TOP, lv({ loading: true, total: null })]]), new Set()).map((r) => r.kind)).toEqual(['loading'])
  })
})
