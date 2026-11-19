/**
 * A change list that picks (a review page's): a change opens beside the list, never in it —
 * clicked, Enter or → — listed or top-down, and the list's current row follows the one picked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ChangeListRow, ChangeListSummary, ChangeTreeLevel } from '@/services/versioningApiService'

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
}))
vi.mock('@/services/versioningApiService', async (orig) => ({
  ...(await orig<typeof import('@/services/versioningApiService')>()),
  ...api,
}))
vi.mock('@/features/reviews/comments/useReviewComments', () => ({
  useReviewCommentCounts: () => ({ data: undefined }),
  useReviewThreads: () => ({ data: undefined }),
}))

import { ChangeList } from '../ChangeList'
import { usePreferencesStore } from '@/store/preferences'

const NONE = { added: 0, modified: 0, removed: 0 }
const summary: ChangeListSummary = {
  origin: { branchId: 'br_1' }, counts: { ...NONE, modified: 2 }, entityCounts: { ...NONE, modified: 2 },
  edgeCounts: NONE, structureCounts: NONE, impact: { Table: 2 },
  byType: [{ kind: 'node', type: 'Table', added: 0, modified: 2, removed: 0 }],
  total: 2, listed: 2, approximate: false, tooLarge: null, window: null,
}
const row = (entityId: string, name: string): ChangeListRow => ({
  entityId, kind: 'node', status: 'modified', type: 'Table', structural: false, displayName: name,
  fields: { changed: 1, added: 0, removed: 0, total: 1, top: [{ label: 'owner', kind: 'changed', before: 'ana', after: 'bo' }] },
})
const level = (ids: Array<[string, string]>): ChangeTreeLevel => ({
  items: ids.map(([id, name]) => ({ id, hasChildren: false, inside: NONE, change: row(id, name) })),
  total: ids.length, offset: 0, limit: 100, hasMore: false, path: [],
})

const onPick = vi.fn()
beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset())
  onPick.mockReset()
  api.getChangeEntries.mockResolvedValue({ entries: [row('T1', 'Orders'), row('T2', 'Sales')], total: 2, offset: 0, limit: 100, hasMore: false })
  api.getChangeTreeLevel.mockResolvedValue(level([['T1', 'Orders'], ['T2', 'Sales']]))
})

function list(selected: string | null) {
  return <ChangeList wsId="ws1" graphId="g1" origin={{ branchId: 'br_1' }} summary={summary} pick={{ selected, onPick }} />
}
function renderList(selected: string | null = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const out = render(<QueryClientProvider client={qc}>{list(selected)}</QueryClientProvider>)
  return { ...out, pickTo: (id: string) => out.rerender(<QueryClientProvider client={qc}>{list(id)}</QueryClientProvider>) }
}

describe.each([
  ['listed', 'list', 'change-row-'],
  ['top-down', 'tree', 'change-tree-'],
] as const)('ChangeList — picking, %s', (_name, layout, prefix) => {
  beforeEach(() => { usePreferencesStore.setState({ changeListLayout: layout }) })
  const button = (id: string) => document.getElementById(`${prefix}${id}`)!

  it('a click picks the change, and it does not open in the list', async () => {
    renderList()
    await screen.findByText('Orders')
    fireEvent.click(button('T1'))
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'T1' }))
    expect(button('T1')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('Enter and → pick it too, once each', async () => {
    renderList()
    await screen.findByText('Sales')
    fireEvent.focus(button('T2'))
    fireEvent.keyDown(button('T2'), { key: 'Enter' })
    fireEvent.keyDown(button('T2'), { key: 'ArrowRight' })
    expect(onPick).toHaveBeenCalledTimes(2)
    expect(onPick.mock.calls.every(([r]) => r.entityId === 'T2')).toBe(true)
    expect(button('T2')).toHaveAttribute('aria-expanded', 'false')
  })

  it('the current row follows the change picked elsewhere', async () => {
    const { pickTo } = renderList('T1')
    await screen.findByText('Sales')
    expect(button('T1')).toHaveAttribute('tabindex', '0')
    pickTo('T2')
    expect(button('T2')).toHaveAttribute('tabindex', '0')
    expect(button('T1')).toHaveAttribute('tabindex', '-1')
  })
})

describe('ChangeList — picking, what it offers', () => {
  it('lists → as opening it beside the list, and no "open every change"', async () => {
    usePreferencesStore.setState({ changeListLayout: 'list' })
    renderList()
    await screen.findByText('Orders')
    expect(screen.queryByRole('button', { name: /Expand all/ })).toBeNull()
    fireEvent.focus(screen.getByRole('button', { name: 'Keyboard shortcuts' }))
    const tip = await screen.findByText('Open it beside the list')
    expect(tip).toBeInTheDocument()
    expect(within(document.body).queryByText('Open every change shown')).toBeNull()
  })
})
