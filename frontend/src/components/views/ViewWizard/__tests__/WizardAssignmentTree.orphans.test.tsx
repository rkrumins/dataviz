/**
 * Entity Browser — "Orphans only", a power-user filter behind the "More filters" menu.
 *
 * The default view says nothing about orphans: one "N total" line, no tags. The
 * menu counts orphans only when opened. Tags, the amber header and the empty
 * state follow the list on screen (`listedOrphans`), not the toggle, so old rows
 * are never tagged while the orphans list loads.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  class RO { observe() {} unobserve() {} disconnect() {} }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 900 })
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width: 600, height: 900, top: 0, left: 0, right: 600, bottom: 900, x: 0, y: 0, toJSON() {} } as DOMRect
  }
})

vi.mock('@/providers/GraphProviderContext', () => ({ useGraphProvider: () => ({}) }))

const entry = (urn: string, name: string) => ({
  node: { urn, entityType: 'Table', displayName: name, properties: {} },
  childIds: [] as string[], totalChildren: 0, totalIsExact: true,
  hasMore: false, nextOffset: 0, loaded: true,
})

const base = () => ({
  typeFilter: null as string | null,
  typesOnPathTo: () => null,
  topLevelIds: ['urn:t1', 'urn:t2'],
  nodes: new Map([['urn:t1', entry('urn:t1', 'Orders')], ['urn:t2', entry('urn:t2', 'Users')]]),
  parentMap: new Map<string, string>(),
  isLoading: false,
  loadTopLevel: vi.fn(),
  setSearch: vi.fn(),
  setTypeFilter: vi.fn(),
  expandNode: vi.fn(),
  loadMoreChildren: vi.fn(),
  loadMoreTopLevel: vi.fn(),
  loadAllChildren: vi.fn().mockResolvedValue([] as string[]),
  loadAllTopLevel: vi.fn().mockResolvedValue(undefined),
  peekNode: (urn: string) => fakeBrowser.nodes.get(urn),
  topLevelHasMore: false,
  topLevelTotalCount: 2,
  failedIds: new Set<string>(),
  loadingNodes: new Set<string>(),
  topLevelTotalExact: true,
  orphansOnly: false,
  listedOrphans: false,
  setOrphansOnly: vi.fn(),
  countOrphans: vi.fn().mockResolvedValue(37 as number | null),
})
let fakeBrowser: ReturnType<typeof base> & Record<string, unknown> = base()
vi.mock('@/hooks/useEntityBrowser', () => ({ useEntityBrowser: () => fakeBrowser }))

import { WizardAssignmentTree } from '../WizardAssignmentTree'
import type { ViewLayerConfig } from '@/types/schema'

const layers: ViewLayerConfig[] = [{ id: 'l1', name: 'Layer 1', entityTypes: [], order: 0 }]
const tree = (onAssignmentChange = vi.fn()) => (
  <WizardAssignmentTree layers={layers} assignments={{}} onAssignmentChange={onAssignmentChange} onBulkAssign={vi.fn()} />
)
const renderTree = (onAssignmentChange = vi.fn()) => render(tree(onAssignmentChange))
const orphansMode = (over: Partial<ReturnType<typeof base>> = {}) => {
  Object.assign(fakeBrowser, { orphansOnly: true, listedOrphans: true, ...over })
}

describe('WizardAssignmentTree — orphans only', () => {
  beforeEach(() => { fakeBrowser = base() })

  it('says nothing about orphans by default, even when the server reports some on the page', () => {
    // An older browser shape: the page-local split, none of the new fields.
    fakeBrowser = { ...base(), topLevelTotalCount: 5, topLevelMetadata: { rootTypeCount: 2, orphanCount: 3 } }
    for (const k of ['topLevelTotalExact', 'orphansOnly', 'listedOrphans', 'setOrphansOnly', 'countOrphans']) delete fakeBrowser[k]
    renderTree()
    expect(screen.getByText('5 total')).toBeInTheDocument()
    expect(screen.queryByText(/orphan/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/top-level/i)).not.toBeInTheDocument()
    expect(screen.queryByTestId('orphan-marker')).not.toBeInTheDocument()
  })

  it('counts orphans only when "More filters" opens, under an Advanced section', async () => {
    renderTree()
    expect(fakeBrowser.countOrphans).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'More filters' }))
    const menu = within(screen.getByRole('menu', { name: 'More filters' }))
    expect(menu.getByRole('group', { name: 'Advanced' })).toHaveTextContent('Advanced')
    const item = menu.getByRole('menuitemcheckbox', { name: /Orphans only/ })
    expect(item).toHaveAttribute('aria-checked', 'false')
    expect(fakeBrowser.countOrphans).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(item).toHaveTextContent('37'))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes the menu on Escape without clearing the selection', () => {
    renderTree()
    fireEvent.click(screen.getByText('Orders'))
    expect(document.body.textContent).toContain('entities • 1 selected')

    const button = screen.getByRole('button', { name: 'More filters' })
    fireEvent.click(button)
    fireEvent.keyDown(button, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.body.textContent).toContain('entities • 1 selected')
  })

  it('reads "many" when the server could not count them', async () => {
    fakeBrowser.countOrphans.mockResolvedValue(null)
    renderTree()
    fireEvent.click(screen.getByRole('button', { name: 'More filters' }))
    await waitFor(() => expect(screen.getByRole('menuitemcheckbox', { name: /Orphans only/ })).toHaveTextContent('many'))
  })

  it('turns the filter on from the menu, and closes it', () => {
    renderTree()
    fireEvent.click(screen.getByRole('button', { name: 'More filters' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Orphans only/ }))
    expect(fakeBrowser.setOrphansOnly).toHaveBeenCalledWith(true)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('tags the orphans list and counts it in the header', () => {
    orphansMode({ topLevelTotalCount: 2 })
    renderTree()
    expect(screen.getAllByTestId('orphan-marker')).toHaveLength(2)
    expect(screen.getByText('2 orphans')).toBeInTheDocument()
    expect(screen.queryByText('2 total')).not.toBeInTheDocument()
  })

  it('reads "Many orphans" when the server could not count the list', () => {
    orphansMode({ topLevelTotalExact: false, topLevelTotalCount: 0, topLevelHasMore: true })
    renderTree()
    expect(screen.getByText('Many orphans')).toBeInTheDocument()
  })

  it('does not tag the old rows while the orphans list is still loading', () => {
    orphansMode({ listedOrphans: false })
    renderTree()
    expect(screen.queryByTestId('orphan-marker')).not.toBeInTheDocument()
    expect(screen.getByText('2 total')).toBeInTheDocument()
  })

  it('says so when there are no orphans', () => {
    orphansMode({ topLevelIds: [], nodes: new Map(), topLevelTotalCount: 0 })
    renderTree()
    expect(screen.getByText('No orphaned entities found')).toBeInTheDocument()
    expect(screen.getByText(/Turn off Orphans only/)).toBeInTheDocument()
  })

  it('keeps orphans assignable', () => {
    orphansMode()
    const onAssignmentChange = vi.fn()
    renderTree(onAssignmentChange)
    const row = screen.getByText('Orders').closest('div.group') as HTMLElement
    fireEvent.change(within(row).getByRole('combobox'), { target: { value: 'l1' } })
    expect(onAssignmentChange).toHaveBeenCalledWith('urn:t1', 'l1')
  })

  it('re-arms scroll-driven load more when the orphans list replaces the default one', () => {
    Object.assign(fakeBrowser, {
      topLevelIds: ['urn:t1'], nodes: new Map([['urn:t1', entry('urn:t1', 'Orders')]]),
      topLevelHasMore: true, topLevelTotalCount: 500,
    })
    const { rerender } = render(tree())
    expect(fakeBrowser.loadMoreTopLevel).toHaveBeenCalledTimes(1)

    // Its first page is as long as the list it replaced.
    orphansMode({ topLevelIds: ['urn:t2'], nodes: new Map([['urn:t2', entry('urn:t2', 'Users')]]) })
    rerender(tree())
    expect(fakeBrowser.loadMoreTopLevel).toHaveBeenCalledTimes(2)
  })

  it('offers "Load all" with no number for an uncounted orphans list, and not for an uncounted default list', () => {
    orphansMode({ topLevelTotalExact: false, topLevelTotalCount: 0, topLevelHasMore: true })
    const { unmount } = renderTree()
    expect(screen.getByRole('button', { name: 'Load all' })).toBeInTheDocument()
    unmount()

    fakeBrowser = { ...base(), topLevelTotalExact: false, topLevelTotalCount: 0, topLevelHasMore: true }
    renderTree()
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Load all/ })).not.toBeInTheDocument()
  })
})
