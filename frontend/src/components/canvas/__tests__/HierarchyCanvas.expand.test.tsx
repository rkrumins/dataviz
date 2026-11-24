/**
 * Opening the Hierarchy a level at a time — the toolbar's Expand, a row's menu, the keys — on the
 * REAL canvas, against a warehouse that holds only its roots, so every level's first page comes
 * through the canvas's own loader. And the list that shows it: virtualized, so a container of
 * thousands mounts only the rows on screen, with the keys, the selection and the menu working
 * through it.
 *
 * jsdom has no layout: each list row is given a height here (`data-index`, the virtualizer's
 * mark) and the scroller a viewport, so what the list mounts is what a browser would.
 */
import { act, fireEvent, render, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HierarchyCanvas } from '../HierarchyCanvas'
import { ProviderOverride } from '@/providers/GraphProviderContext'
import { toCanvasEdge, toCanvasNode } from '@/lib/canvasNodeMapper'
import { useCanvasStore, type LineageEdge } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { usePreferencesStore } from '@/store/preferences'
import { useNotificationStore } from '@/components/ui/notifications'
import { revealNodeOnCanvas } from '@/store/canvasReveal'
import { installJsdomLayout } from '@/test/canvasHarness'
import type { GraphDataProvider, GraphEdge, GraphNode } from '@/providers/GraphDataProvider'

// ── The warehouse: Warehouse › schema › table › column, and a Data Lake of empty buckets ──
const size = { schemas: 3, tables: 2, columns: 2 }
const pad = (n: number) => String(n).padStart(4, '0')
const wire = (urn: string, displayName: string, entityType: string, childCount: number): GraphNode =>
  ({ urn, displayName, entityType, childCount, properties: {} }) as unknown as GraphNode
const roots = () => [wire('wh', 'Warehouse', 'warehouse', size.schemas), wire('lake', 'Data Lake', 'warehouse', 2)]
function childrenOf(urn: string): GraphNode[] {
  if (urn === 'wh') return Array.from({ length: size.schemas }, (_, i) => wire(`s${i}`, `schema_${pad(i)}`, 'schema', size.tables))
  if (urn === 'lake') return [wire('b0', 'bucket_0', 'schema', 0), wire('b1', 'bucket_1', 'schema', 0)]
  const s = urn.match(/^s(\d+)$/)
  if (s) return Array.from({ length: size.tables }, (_, j) => wire(`t${s[1]}_${j}`, `table_${s[1]}_${pad(j)}`, 'table', size.columns))
  const t = urn.match(/^t(\d+)_(\d+)$/)
  if (t) return Array.from({ length: size.columns }, (_, k) => wire(`c${t[1]}_${t[2]}_${k}`, `column_${k}`, 'column', 0))
  return []
}

/** Every container whose children were asked for, in order. */
const fetched: string[] = []
/** While set, every page waits for it. */
let gate: Promise<void> | null = null

const provider = {
  scopeKey: 'hierarchy-expand',
  getChildren: async (urn: string) => childrenOf(urn),
  getChildrenWithEdges: async (urn: string, opts?: { offset?: number; limit?: number }) => {
    fetched.push(urn)
    if (gate) await gate
    const all = childrenOf(urn)
    const offset = opts?.offset ?? 0
    const page = all.slice(offset, offset + (opts?.limit ?? 100))
    const next = offset + page.length
    return {
      children: page,
      containmentEdges: page.map((c) => ({ id: `c:${urn}>${c.urn}`, sourceUrn: urn, targetUrn: c.urn, edgeType: 'CONTAINS' })),
      lineageEdges: [],
      totalChildren: all.length,
      hasMore: next < all.length,
      nextOffset: next < all.length ? next : null,
      nextCursor: null,
    }
  },
  getNodes: async () => [],
  getEdges: async () => [],
  getEdgesBetween: async () => [],
  getParent: async () => null,
  getAggregatedEdges: async () => ({ aggregatedEdges: [], totalSourceEdges: 0 }),
} as unknown as GraphDataProvider

let restoreFetch: () => void = () => {}
function stubFetch() {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const body = url.includes('/library') ? { viewId: 'v1', displayRules: [], savedQueries: [], canEdit: true } : {}
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  restoreFetch = () => { globalThis.fetch = original }
}

/** A list row is 60px; the scroller (and everything else) 900px, and as tall inside as what it
 *  holds. A scroll moves the list. */
function installListLayout() {
  installJsdomLayout()
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) { return this.hasAttribute('data-index') ? 60 : 900 },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 900 })
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) { return Math.max(900, parseFloat((this.firstElementChild as HTMLElement | null)?.style.height ?? '') || 0) },
  })
  Element.prototype.scrollTo = function (this: Element, opts?: ScrollToOptions | number) {
    if (typeof opts !== 'object' || opts.top === undefined) return
    this.scrollTop = opts.top
    this.dispatchEvent(new Event('scroll'))
  } as typeof Element.prototype.scrollTo
}

const entityType = (id: string, name: string, canContain: string[]) => ({
  id, name, pluralName: `${name}s`, description: '', fields: [],
  visual: { icon: 'Box', color: '#6366f1', shape: 'rounded', size: 'md', borderStyle: 'solid', showInMinimap: true },
  hierarchy: { level: 0, canContain, canBeContainedBy: [], defaultExpanded: false, rollUpFields: [] },
  behavior: { selectable: true, draggable: true, expandable: true, traceable: false, clickAction: 'select', doubleClickAction: 'expand' },
})

function seed() {
  useSchemaStore.setState({
    activeViewId: 'v1',
    schema: {
      id: 's', name: 's', version: '1',
      entityTypes: [
        entityType('warehouse', 'Warehouse', ['schema']),
        entityType('schema', 'Schema', ['table']),
        entityType('table', 'Table', ['column']),
        entityType('column', 'Column', []),
      ],
      relationshipTypes: [], globalVisuals: {},
      containmentEdgeTypes: ['CONTAINS'], lineageEdgeTypes: ['TRANSFORMS'],
      rootEntityTypes: [], defaultViewId: 'v1',
      views: [{
        id: 'v1', name: 'View', workspaceId: 'ws', dataSourceId: 'ds',
        content: { visibleEntityTypes: [], visibleRelationshipTypes: [], defaultDepth: 3, maxDepth: 10, rootEntityTypes: [] },
        layout: { type: 'hierarchy' }, filters: {}, entityOverrides: {}, isDefault: true,
      }],
    },
  } as never)
  const store = useCanvasStore.getState()
  store.setGraph(roots().map((n) => toCanvasNode(n)), [] as LineageEdge[])
  store.setHydrationPhase('complete')
  store.clearSelection()
}

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  }
}

async function mount() {
  installListLayout()
  stubFetch()
  seed()
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ProviderOverride value={{
          provider, isLoading: false, error: null, scopeKind: 'ready',
          workspaceId: 'ws', dataSourceId: 'ds', providerReady: true, providerVersion: 1,
        } as never}>
          <HierarchyCanvas />
        </ProviderOverride>
      </QueryClientProvider>
    </MemoryRouter>,
  )
  await waitFor(() => { if (!row('wh')) throw new Error('no rows yet') }, { timeout: 4000 })
  await settle()
}

const row = (id: string) => document.getElementById(`hierarchy-node-${id}`)
const header = (id: string) => row(id)!.querySelector<HTMLElement>('.group\\/row')!
/** The rows mounted, top to bottom. */
const mounted = () => [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].map((el) => el.id.replace('hierarchy-node-', ''))
const tree = () => document.querySelector<HTMLElement>('[role="tree"]')!
const toolbar = () => document.querySelector<HTMLElement>('[data-canvas-toolbar]')!
const expandButton = () => within(toolbar()).getByRole('button', { name: /^Expand (next level|all levels)$/ })
const messages = () => useNotificationStore.getState().notifications.map((n) => n.message)
const selected = () => useCanvasStore.getState().selectedNodeIds
const inStore = (id: string) => useCanvasStore.getState().nodes.some((n) => n.id === id)
const menuItem = (label: RegExp) => [...document.querySelectorAll<HTMLButtonElement>('[data-canvas-context-menu] button')]
  .find((b) => label.test((b.querySelector('span.block')?.textContent ?? '').trim()))
async function click(el: HTMLElement, init?: MouseEventInit) {
  await act(async () => { fireEvent.click(el, init) })
  await settle()
}
async function key(k: string, init?: KeyboardEventInit) {
  await act(async () => { fireEvent.keyDown(tree(), { key: k, ...init }) })
  await settle()
}

beforeEach(() => {
  Object.assign(size, { schemas: 3, tables: 2, columns: 2 })
  fetched.length = 0
  gate = null
  usePreferencesStore.setState({ expandDepthMode: 'level' })
  useNotificationStore.setState({ notifications: [], history: [] } as never)
})
afterEach(() => { restoreFetch() })

describe('HierarchyCanvas — the toolbar opens a level at a time', () => {
  it('each press opens the next level, fetching the first page of every container in it', async () => {
    await mount()
    // Sorted by name: the lake, then the warehouse — closed, nothing inside them loaded.
    expect(mounted()).toEqual(['lake', 'wh'])

    await click(expandButton())
    await waitFor(() => expect(mounted()).toEqual(['lake', 'b0', 'b1', 'wh', 's0', 's1', 's2']))
    expect([...fetched].sort()).toEqual(['lake', 'wh'])
    await waitFor(() => expect(messages()).toContain('Opened level 1 inside 2 entities · 5 loaded'))

    // The schemas were never loaded open: each gets its first page now. The empty buckets are
    // not containers, so nothing is asked of them.
    await click(expandButton())
    await waitFor(() => expect(mounted()).toEqual(
      ['lake', 'b0', 'b1', 'wh', 's0', 't0_0', 't0_1', 's1', 't1_0', 't1_1', 's2', 't2_0', 't2_1']))
    expect([...fetched].sort()).toEqual(['lake', 's0', 's1', 's2', 'wh'])
    await waitFor(() => expect(messages()).toContain('Opened level 2 inside 2 entities · 6 loaded'))
    expect(row('t0_0')!.getAttribute('aria-level')).toBe('3')
    expect(row('wh')!.getAttribute('aria-expanded')).toBe('true')
  }, 30000)

  it('All levels — the remembered switch — opens every level, pausing every 2,000 entities loaded', async () => {
    Object.assign(size, { schemas: 30, tables: 100, columns: 0 })
    await mount()
    const allLevels = within(toolbar()).getByRole('switch', { name: 'All levels' })
    await click(allLevels)
    expect(usePreferencesStore.getState().expandDepthMode).toBe('all')
    expect(allLevels).toHaveAttribute('aria-checked', 'true')

    await click(expandButton())
    // The roots' pages (32), then as many schemas as fit before the checkpoint (20 × 100).
    await waitFor(() => expect(messages()).toContain('Paused opening 2 entities · 2,032 loaded so far. Keep going?'), { timeout: 10000 })
    expect(fetched.filter((u) => u.startsWith('s'))).toHaveLength(20)
    // The toolbar's Expand is the way to stop meanwhile.
    expect(within(toolbar()).getByRole('button', { name: /Stop opening/ })).toBeInTheDocument()
    // Two thousand rows open; the list mounts what is on screen.
    expect(mounted().length).toBeGreaterThan(5)
    expect(mounted().length).toBeLessThan(40)

    const paused = useNotificationStore.getState().notifications.find((n) => n.action?.label === 'Continue')!
    expect(paused.secondaryAction?.label).toBe('Stop')
    await act(async () => { paused.action!.onClick() })
    await waitFor(() => expect(messages()).toContain('Opened everything inside 2 entities · 3,032 loaded'), { timeout: 10000 })
    expect(fetched.filter((u) => u.startsWith('s'))).toHaveLength(30)
    expect(within(toolbar()).getByRole('button', { name: 'Expand all levels' })).toBeDisabled()
  }, 40000)

  it('Collapse all closes every row — and stops a run, with nothing still on its way landing', async () => {
    await mount()
    await click(expandButton())
    await waitFor(() => expect(mounted()).toContain('s0'))
    await click(within(toolbar()).getByRole('button', { name: 'Collapse all' }))
    expect(mounted()).toEqual(['lake', 'wh'])

    // The next level's pages held on the wire; Collapse all while they are.
    let release!: () => void
    gate = new Promise((resolve) => { release = resolve })
    await click(expandButton())
    await click(expandButton())
    await waitFor(() => expect(fetched.filter((u) => u.startsWith('s')).length).toBeGreaterThan(0))
    await click(within(toolbar()).getByRole('button', { name: 'Collapse all' }))
    expect(mounted()).toEqual(['lake', 'wh'])
    expect(messages().some((m) => m.startsWith('Stopped opening 2 entities'))).toBe(true)
    await act(async () => { release() })
    await settle()
    expect(mounted()).toEqual(['lake', 'wh'])
    expect(inStore('t0_0')).toBe(false)
  }, 30000)
})

describe('HierarchyCanvas — a row opened any other way', () => {
  it('“Show on canvas” on a container that holds nothing yet opens it onto its first page', async () => {
    await mount()
    act(() => { revealNodeOnCanvas('wh') })
    await waitFor(() => expect(mounted()).toEqual(['lake', 'wh', 's0', 's1', 's2']))
    expect(fetched).toEqual(['wh'])
    // Once: a later render does not ask again.
    await settle()
    expect(fetched).toEqual(['wh'])
  }, 30000)
})

describe('HierarchyCanvas — a row’s menu, for one row or several', () => {
  it('Expand next level and Collapse, for the rows selected together', async () => {
    await mount()
    await click(header('wh').querySelector<HTMLElement>('button[aria-label="Expand Warehouse"]')!)
    await waitFor(() => expect(mounted()).toContain('s2'))
    await click(header('s0'))
    await click(header('s1'), { ctrlKey: true })
    expect(selected()).toEqual(['s0', 's1'])

    await act(async () => { fireEvent.contextMenu(header('s0')) })
    expect(menuItem(/^Collapse/)).toBeUndefined()
    await click(menuItem(/^Expand next level$/)!)
    await waitFor(() => expect(mounted()).toEqual(expect.arrayContaining(['t0_0', 't0_1', 't1_0', 't1_1'])))
    expect(mounted()).not.toContain('t2_0')
    expect(fetched).not.toContain('s2')

    // Nothing open beneath them: the way back is the rows themselves.
    await act(async () => { fireEvent.contextMenu(header('s1')) })
    expect(menuItem(/^Collapse everything inside$/)).toBeUndefined()
    await click(menuItem(/^Collapse$/)!)
    expect(mounted()).not.toContain('t0_0')
    expect(mounted()).not.toContain('t1_0')
    expect(mounted()).toContain('s0')
  }, 30000)
})

describe('HierarchyCanvas — a virtualized list', () => {
  /** The warehouse with all 5,000 schemas already loaded, closed. */
  function holdFiveThousand() {
    size.schemas = 5000
    const kids = childrenOf('wh')
    act(() => {
      useCanvasStore.getState().addGraph(
        kids.map((n) => toCanvasNode(n)),
        kids.map((c) => toCanvasEdge({ id: `c:wh>${c.urn}`, sourceUrn: 'wh', targetUrn: c.urn, edgeType: 'CONTAINS' } as GraphEdge)),
      )
    })
  }

  it('a container of 5,000 rows mounts only those on screen, and says how many there are', async () => {
    await mount()
    holdFiveThousand()
    await settle()
    await click(header('wh').querySelector<HTMLElement>('button[aria-label="Expand Warehouse"]')!)
    // Every schema was loaded already: opening it fetched nothing.
    expect(fetched).toEqual([])
    const shown = mounted()
    expect(shown.slice(0, 3)).toEqual(['lake', 'wh', 's0'])
    expect(shown.length).toBeLessThan(40)
    expect(row('s0')!.getAttribute('aria-setsize')).toBe('5000')
    expect(row('s0')!.getAttribute('aria-posinset')).toBe('1')
  }, 30000)

  it('the keys walk the rows — scrolling the list to them — and Shift-click still takes a range', async () => {
    await mount()
    holdFiveThousand()
    await settle()
    await key('ArrowDown')
    expect(tree().getAttribute('aria-activedescendant')).toBe('hierarchy-node-lake')
    await key('ArrowDown')
    // → opens the warehouse, → again steps into it.
    await key('ArrowRight')
    expect(row('wh')!.getAttribute('aria-expanded')).toBe('true')
    await key('ArrowRight')
    expect(tree().getAttribute('aria-activedescendant')).toBe('hierarchy-node-s0')
    // Space adds the row to the selection; Enter selects it alone.
    await key(' ')
    expect(selected()).toEqual(['s0'])

    // End: the last of 5,000, brought on screen.
    await key('End')
    expect(tree().getAttribute('aria-activedescendant')).toBe('hierarchy-node-s4999')
    await waitFor(() => expect(row('s4999')).not.toBeNull())
    expect(mounted()).not.toContain('s0')
    await key('Enter')
    expect(selected()).toEqual(['s4999'])
    // ← from a row inside steps out to its container — back at the top.
    await key('ArrowLeft')
    expect(tree().getAttribute('aria-activedescendant')).toBe('hierarchy-node-wh')
    await waitFor(() => expect(row('wh')).not.toBeNull())

    // A plain click, then a Shift-click: every row between, as drawn.
    await click(header('s1'))
    await click(header('s4'), { shiftKey: true })
    expect(selected()).toEqual(['s1', 's2', 's3', 's4'])
  }, 30000)

  it('a container with more than a page offers the rest, and loads it', async () => {
    Object.assign(size, { schemas: 150 })
    await mount()
    await click(header('wh').querySelector<HTMLElement>('button[aria-label="Expand Warehouse"]')!)
    await waitFor(() => expect(inStore('s99')).toBe(true))
    expect(inStore('s100')).toBe(false)
    // The paging row sits under the hundredth: bring it on screen, as a reader scrolling would.
    await key('End')
    const more = await waitFor(() => {
      const b = document.querySelector<HTMLElement>('button[aria-label="Load 50 more of 50 remaining"]')
      if (!b) throw new Error('no load-more row')
      return b
    })
    await click(more)
    await waitFor(() => expect(inStore('s149')).toBe(true))
    expect(fetched).toEqual(['wh', 'wh'])
    await waitFor(() => expect(document.querySelector('button[aria-label^="Load "]')).toBeNull())
  }, 30000)
})
