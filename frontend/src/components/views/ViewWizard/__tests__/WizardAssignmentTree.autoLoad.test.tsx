/**
 * The Entity Browser's scroll-driven "load more" re-arms only when the LIST grows.
 *
 * Keyed on the page position, a load-more row that stayed on screen because a
 * filter ("Unassigned only", a type filter) hid every row it loaded fired again
 * for every page that landed — an unattended walk of the whole container, one
 * request after another, with nothing new on screen. Keyed on the rows the list
 * shows, it fires once and then waits for a click.
 */
import { render } from '@testing-library/react'
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

const entry = (urn: string) => ({
  node: { urn, entityType: 'domain', displayName: urn, properties: {} },
  childIds: [] as string[], totalChildren: 0, totalIsExact: true,
  hasMore: false, nextOffset: 0, loaded: true,
})

const fakeBrowser = {
  typeFilter: null as string | null,
  typesOnPathTo: () => null,
  topLevelIds: ['urn:a'],
  nodes: new Map([['urn:a', entry('urn:a')]]),
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
  topLevelHasMore: true,
  topLevelTotalCount: 500,
  topLevelMetadata: { rootTypeCount: 500, orphanCount: 0 },
  failedIds: new Set<string>(),
  loadingNodes: new Set<string>(),
}
vi.mock('@/hooks/useEntityBrowser', () => ({ useEntityBrowser: () => fakeBrowser }))

import { WizardAssignmentTree } from '../WizardAssignmentTree'
import type { ViewLayerConfig } from '@/types/schema'

const layers: ViewLayerConfig[] = [{ id: 'l1', name: 'Layer 1', entityTypes: [], order: 0 }]
const tree = () => (
  <WizardAssignmentTree layers={layers} assignments={{}} onAssignmentChange={vi.fn()} onBulkAssign={vi.fn()} />
)

describe('WizardAssignmentTree — scroll-driven load more', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fakeBrowser.topLevelIds = ['urn:a']
    fakeBrowser.nodes = new Map([['urn:a', entry('urn:a')]])
  })

  it('fires once, and not again for a page that added nothing to the list', () => {
    const { rerender } = render(tree())
    expect(fakeBrowser.loadMoreTopLevel).toHaveBeenCalledTimes(1)

    // The page landed, but nothing it brought is on the list (filtered out).
    fakeBrowser.topLevelIds = ['urn:a', 'urn:hidden-1', 'urn:hidden-2']
    rerender(tree())
    expect(fakeBrowser.loadMoreTopLevel).toHaveBeenCalledTimes(1)
  })

  it('fires again once a page grows the list', () => {
    const { rerender } = render(tree())
    expect(fakeBrowser.loadMoreTopLevel).toHaveBeenCalledTimes(1)
    fakeBrowser.topLevelIds = ['urn:a', 'urn:b']
    fakeBrowser.nodes = new Map([['urn:a', entry('urn:a')], ['urn:b', entry('urn:b')]])
    rerender(tree())
    expect(fakeBrowser.loadMoreTopLevel).toHaveBeenCalledTimes(2)
  })
})
