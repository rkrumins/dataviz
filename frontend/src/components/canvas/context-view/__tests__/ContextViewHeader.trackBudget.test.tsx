/**
 * The toolbar row's WIDTH BUDGET — the fourth click-freeze class.
 *
 * Measured on the live app at 1600px, before the fix: the row is
 * `grid-cols-[auto_1fr_auto]`; the 1fr track's automatic minimum was the
 * search field's min-content (305px) and the third track was sized to the
 * actions cluster's max-content (978px in View, 1170 in Edit). On a 1296px
 * row that is 1,445px of demand, so the left track — the only one with
 * anything left to give — collapsed to 52px around a 130px branch switcher.
 * The switcher overflowed its own track and the search box, later in the DOM,
 * painted over its right-hand half: 62 of 130px swallowed every click. In Edit
 * mode the track went to 0px and the actions cluster overflowed the grid by
 * 158px, pushing Review & Save and Done off the right edge.
 *
 * WHAT JSDOM CAN AND CANNOT SEE HERE. jsdom has no layout engine: it does not
 * implement CSS grid, it never resolves a track size, and `offsetWidth` /
 * `getBoundingClientRect()` answer 0 for every element on this page. It also
 * never loads Tailwind, so class names carry no computed style. Nothing in
 * this file can therefore measure a track, an overflow, or a dead pixel — a
 * test that claimed to would be asserting on zeros.
 *
 * What CAN be checked here, and what actually broke, is the CSS CONTRACT: the
 * row's track list, and which element in each track is allowed to give way.
 * Every one of the three fixes is a shrink permission, and each of them is a
 * single class that is trivially deleted by an unrelated edit:
 *
 *   - the SEARCH BOX is the row's elastic element (`min-w-0`). Without it the
 *     middle track cannot fall below the field's min-content and the budget
 *     goes negative again.
 *   - the SWITCHER truncates its NAME rather than overflowing (`min-w-0` on
 *     the label, `min-w-0 max-w-full` on the trigger — a <button>'s
 *     `width: auto` is shrink-to-fit, so min-width alone never narrows it —
 *     and `shrink-0` on the icon and chevron so a clickable body always
 *     survives).
 *   - IMPORT / EXPORT, the longest label on the least-used control, stands
 *     its words down below 2000px while keeping its accessible name.
 *
 * Driven on the real header in both modes, with the REAL BranchSwitcher (the
 * existing ContextViewHeader.test.tsx replaces it with a stub div, so it
 * cannot see any of this). Only the switcher's DATA is stubbed, by seeding
 * the query cache the real hooks read.
 */
import { render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ViewSearchSessionContext } from '@/components/canvas/search/session/ViewSearchSessionContext'
import { stubSession } from '@/test/stubSearchSession'
import { VERSIONING_KEYS } from '@/features/versioning/hooks/useVersioning'
import { useBranchStore } from '@/store/branchStore'
import { useAuthStore } from '@/store/auth'
import { ContextViewHeader, type ContextViewHeaderProps } from '../ContextViewHeader'

const WS = 'ws-1'
const DS = 'ds-1'

function baseProps(overrides: Partial<ContextViewHeaderProps> = {}): ContextViewHeaderProps {
  return {
    showLineageFlow: true,
    onToggleLineageFlow: vi.fn(),
    showEdgeDirection: false,
    onToggleEdgeDirection: vi.fn(),
    lineageRenderMode: 'stubs',
    onSetLineageRenderMode: vi.fn(),
    traceActive: false,
    canTrace: true,
    onStartTrace: vi.fn(),
    onExitTrace: vi.fn(),
    lineageReady: true,
    traceUpstreamDepth: 3,
    traceDownstreamDepth: 3,
    onSetTraceDepth: vi.fn(),
    isDraft: false,
    canManage: true,
    canEnterEdit: true,
    onEnterEdit: vi.fn(),
    onExitEdit: vi.fn(),
    onTogglePropertyManager: vi.fn(),
    propertyManagerOpen: false,
    branchWorkspaceId: WS,
    branchDataSourceId: DS,
    syncStatus: 'idle',
    onRetrySync: vi.fn(),
    pendingChangeCount: 2,
    onOpenStagedChanges: vi.fn(),
    onImport: vi.fn(),
    onExport: vi.fn(),
    canUndo: true,
    canRedo: true,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    canvasZoom: 1,
    onSetCanvasZoom: vi.fn(),
    canvasDensity: 'spacious',
    onSetCanvasDensity: vi.fn(),
    showCanvasTypeBadge: true,
    onToggleCanvasTypeBadge: vi.fn(),
    subtleCanvasTreeLines: false,
    onToggleSubtleCanvasTreeLines: vi.fn(),
    onResetCanvasDisplaySettings: vi.fn(),
    ...overrides,
  }
}

/** The real header, with the switcher's queries pre-answered rather than mocked. */
function renderHeader(mode: 'view' | 'edit') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(VERSIONING_KEYS.resolve(WS, DS), { graphId: 'g-1', mainHeadCommitSeq: 3 })
  qc.setQueryData(VERSIONING_KEYS.branches(WS, 'g-1'), [])
  qc.setQueryData(VERSIONING_KEYS.mergeRequests(WS, 'g-1'), [])
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ViewSearchSessionContext.Provider value={stubSession()}>
          <ContextViewHeader {...baseProps({ isDraft: mode === 'edit' })} />
        </ViewSearchSessionContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

/** The three-track row itself. */
function row(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[class*="grid-cols-"]')
  if (!el) throw new Error('the toolbar grid row is gone')
  return el
}

const classesOf = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/)

/** The switcher's trigger — the control that was two-thirds dead. */
function switcher(): HTMLElement {
  const el = [...document.querySelectorAll<HTMLElement>('button[aria-haspopup="dialog"]')]
    .find(b => within(b).queryByText(/published|draft/i))
  if (!el) throw new Error('the branch switcher is not in the toolbar')
  return el
}

beforeEach(() => {
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
  useBranchStore.setState({
    workspaceId: WS, dataSourceId: DS, viewId: null, currentBranchId: null, graphId: 'g-1',
  } as never)
})

describe.each(['view', 'edit'] as const)('toolbar width budget — %s mode', (mode) => {
  beforeEach(() => { renderHeader(mode) })

  it('is a three-track row and the SEARCH BOX is the one allowed to give way', () => {
    const r = row()
    expect(classesOf(r)).toContain('grid-cols-[auto_1fr_auto]')
    // Exactly three children, or the track list no longer describes the row.
    expect(r.children).toHaveLength(3)

    // The middle child IS the search box, and it carries min-w-0. Without it a
    // grid item's automatic minimum is its min-content and the 1fr track has a
    // 305px floor it can never go under.
    const middle = r.children[1]
    expect(middle).toBe(document.querySelector('[data-tour="canvas-search"]'))
    expect(classesOf(middle)).toContain('min-w-0')
  })

  it('the switcher truncates its NAME rather than overflowing its track', () => {
    const trigger = switcher()
    // A <button>'s width:auto is shrink-to-fit, so min-width alone never
    // narrows it — both classes are load-bearing.
    expect(classesOf(trigger)).toEqual(expect.arrayContaining(['min-w-0', 'max-w-full']))

    // The NAME is the part that gives: it truncates and may shrink to nothing.
    const label = [...trigger.querySelectorAll('span')]
      .find(s => /published|draft/i.test(s.textContent ?? ''))
    expect(label).toBeDefined()
    expect(classesOf(label!)).toEqual(expect.arrayContaining(['min-w-0', 'truncate']))

    // The icon and the chevron may NOT shrink, so however tight the track
    // gets the control keeps a body a click can land on.
    const glyphs = [...trigger.querySelectorAll('svg')]
    expect(glyphs.length).toBeGreaterThanOrEqual(2)
    for (const g of glyphs) expect(classesOf(g)).toContain('shrink-0')

    // A shrink permission is only as good as the weakest link above it: one
    // wrapper left at `min-width: auto` re-imposes a min-content floor on the
    // whole track and the switcher overflows again. Walk the real chain from
    // the left track down to the trigger and require every link to yield —
    // this also catches a wrapper somebody adds later (the tooltip span
    // between the two is exactly such an addition).
    const left = row().children[0]
    expect(left.contains(trigger)).toBe(true)
    const chain: Element[] = []
    for (let el: Element | null = trigger; el; el = el.parentElement) {
      chain.push(el)
      if (el === left) break
    }
    expect(chain[chain.length - 1]).toBe(left)
    for (const link of chain) {
      expect(classesOf(link), `${link.tagName} in the switcher's track cannot shrink`)
        .toContain('min-w-0')
    }
  })

  it('the actions cluster stands its longest label down below 2000px, keeping its name', () => {
    // Import / Export is the widest label in the cluster and the least-used
    // control in it; its words are the header's content budget.
    const button = screen.getByRole('button', { name: /import \/ export/i })
    const words = [...button.querySelectorAll('span')]
      .find(s => /import \/ export/i.test(s.textContent ?? ''))
    expect(words).toBeDefined()
    expect(classesOf(words!)).toEqual(expect.arrayContaining(['hidden', 'min-[2000px]:inline']))

    // The cluster is the row's third child, and it is not the one that yields:
    // a min-w-0 here would let the buttons overflow it instead of the row
    // being sized to hold them.
    const right = row().children[2]
    expect(right.contains(button)).toBe(true)
    expect(classesOf(right)).not.toContain('min-w-0')
  })
})
