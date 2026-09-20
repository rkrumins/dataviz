/**
 * "Select its N children only" must mean ALL N, not the page on screen.
 *
 * The tree pages children (CHILDREN_PAGE_SIZE at a time), so a 250-child root
 * shows 100. If select-all took what was loaded, assigning would place 100 and
 * quietly drop 150 — the column would look done and be wrong.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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

const TOTAL = 250
const PAGE = 100
const childUrn = (i: number) => `urn:c${i}`

type Entry = {
  node: { urn: string; entityType: string; displayName: string; properties: Record<string, unknown> }
  childIds: string[]
  totalChildren: number
  totalIsExact: boolean
  hasMore: boolean
  nextCursor: string | null
  loaded: boolean
}

const entry = (urn: string, name: string, over: Partial<Entry> = {}): Entry => ({
  node: { urn, entityType: 'domain', displayName: name, properties: {} },
  childIds: [], totalChildren: 0, totalIsExact: true,
  hasMore: false, nextCursor: null, loaded: true, ...over,
})

/** A root holding TOTAL children, of which only the first PAGE are loaded. */
function makeBrowser() {
  const nodes = new Map<string, Entry>()
  nodes.set('urn:root', entry('urn:root', 'Root', {
    childIds: Array.from({ length: PAGE }, (_, i) => childUrn(i)),
    totalChildren: TOTAL, hasMore: true, nextCursor: 'c99',
  }))
  for (let i = 0; i < PAGE; i++) nodes.set(childUrn(i), entry(childUrn(i), `Child ${i}`))

  const browser = {
    typeFilter: null as string | null,
    typesOnPathTo: () => null,
    topLevelIds: ['urn:root'],
    nodes,
    parentMap: new Map<string, string>(Array.from({ length: PAGE }, (_, i) => [childUrn(i), 'urn:root'])),
    isLoading: false,
    loadTopLevel: vi.fn(), setSearch: vi.fn(), setTypeFilter: vi.fn(), expandNode: vi.fn(),
    loadMoreChildren: vi.fn(), loadMoreTopLevel: vi.fn(),
    loadAllTopLevel: vi.fn().mockResolvedValue(undefined),
    /** Drains every page, as the real one does, and returns the MERGED list. */
    loadAllChildren: vi.fn(async (parentUrn: string): Promise<string[]> => {
      const all = Array.from({ length: TOTAL }, (_, i) => childUrn(i))
      for (const urn of all) if (!nodes.has(urn)) nodes.set(urn, entry(urn, `Child ${urn.slice(5)}`))
      nodes.set(parentUrn, entry(parentUrn, 'Root', {
        childIds: all, totalChildren: TOTAL, hasMore: false, nextCursor: null,
      }))
      all.forEach(urn => browser.parentMap.set(urn, parentUrn))
      return all
    }),
    peekNode: (urn: string) => nodes.get(urn),
    topLevelHasMore: false,
    topLevelTotalCount: 1,
    topLevelMetadata: { rootTypeCount: 1, orphanCount: 0 },
    loadingNodes: new Set<string>(),
  }
  return browser
}

let fakeBrowser = makeBrowser()
vi.mock('@/hooks/useEntityBrowser', () => ({ useEntityBrowser: () => fakeBrowser }))

import { WizardAssignmentTree } from '../WizardAssignmentTree'
import type { ViewLayerConfig } from '@/types/schema'

const layers: ViewLayerConfig[] = [
  { id: 'l1', name: 'Layer 1', entityTypes: [], order: 0 },
  { id: 'l2', name: 'Layer 2', entityTypes: [], order: 1 },
]

beforeEach(() => { fakeBrowser = makeBrowser() })

describe('WizardAssignmentTree — select all children of a root', () => {
  async function selectAllChildren() {
    const onBulkAssign = vi.fn()
    render(
      <WizardAssignmentTree
        layers={layers}
        assignments={{}}
        onAssignmentChange={vi.fn()}
        onBulkAssign={onBulkAssign}
      />
    )
    fireEvent.click(screen.getByText('Root'))
    const selectAll = await screen.findByRole('button', { name: new RegExp(`Select its ${TOTAL} children only`) })
    fireEvent.click(selectAll)
    // The selection is set AFTER the paging await resolves, so waiting on the
    // fetch alone races it — wait for the count the toolbar reports.
    // "{count} selected" is split across text nodes, so match the container.
    await waitFor(() => expect(document.body.textContent).toContain(`${TOTAL} selected`))
    return { onBulkAssign }
  }

  it('pages in every child before selecting', async () => {
    await selectAllChildren()
    expect(fakeBrowser.loadAllChildren).toHaveBeenCalledTimes(1)
  })

  it('assigns ALL of them, not just the page that was on screen', async () => {
    const { onBulkAssign } = await selectAllChildren()
    fireEvent.keyDown(window, { key: '2' })
    await waitFor(() => expect(onBulkAssign).toHaveBeenCalled())
    const [layerId, ids] = onBulkAssign.mock.calls[0]
    expect(layerId).toBe('l2')
    expect(ids).toHaveLength(TOTAL)
  })

  it('never includes the root itself — it was deliberately excluded', async () => {
    const { onBulkAssign } = await selectAllChildren()
    fireEvent.keyDown(window, { key: '2' })
    await waitFor(() => expect(onBulkAssign).toHaveBeenCalled())
    expect(onBulkAssign.mock.calls[0][1]).not.toContain('urn:root')
  })
})

describe('WizardAssignmentTree — a container bigger than the loader reaches', () => {
  it('says how many it could not load, rather than selecting a fraction silently', async () => {
    // The bulk loader has a safety stop (200 pages). Past it the caller used to
    // receive a PARTIAL list and treat it as all of them — a select-all would
    // then place a fraction and look finished.
    fakeBrowser.loadAllChildren = vi.fn(async () => {
      const partial = Array.from({ length: 40 }, (_, i) => childUrn(i))
      return partial
    }) as never

    render(
      <WizardAssignmentTree
        layers={layers}
        assignments={{}}
        onAssignmentChange={vi.fn()}
        onBulkAssign={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('Root'))
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`Select its ${TOTAL} children only`) }))

    await waitFor(() => expect(document.body.textContent).toContain('40 selected'))
    // 250 reported, 40 delivered.
    expect(document.body.textContent).toContain('210 more couldn’t be loaded')
  })
})
