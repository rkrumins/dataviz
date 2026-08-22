/**
 * LineageLens — the walk surface (2026-08-21: hands-free in both modes).
 *
 * The hook drives the walk; the lens's job here is to SAY where it stands
 * — the immediate lineage loading, the full flow walking, complete — with
 * counts ticking (never a percent), and to offer only the two valves that
 * can still stop a walk: the one-time memory checkpoint ("Continue") and a
 * retry for failed steps. There is no "Keep walking", no "Load everything",
 * no "Load more contents": nothing at hop 1 ever needs a click. Every
 * state below is a prop; the driver itself is covered in useLensWalk.test.ts.
 */
import type { ComponentProps } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { LineageLens } from '../LineageLens'
import { chooseView, viewValue } from '@/test/lensView'
import type { WalkEntry, WalkProgress } from '@/hooks/useLensWalk'
import type { LensWalkModel, LensWalkNode } from '../lens/closure-adapter'

const wnode = (urn: string, type = 'dataset'): LensWalkNode => ({
  id: urn,
  type: 'generic',
  position: { x: 0, y: 0 },
  data: { urn, label: urn, type },
  urn,
  displayName: urn,
  entityType: type,
}) as unknown as LensWalkNode

function walkModel(focusUrn: string, nodes: LensWalkNode[]): LensWalkModel {
  return {
    focusUrn,
    nodes,
    lineageEdges: [],
    containmentEdges: [],
    upstreamUrns: new Set(),
    downstreamUrns: new Set(),
    frontierUp: [],
    frontierDown: [],
    truncated: false,
    truncationReason: null,
    seedTruncated: false,
    seedCursor: null,
  }
}

const doneWalk = (model: LensWalkModel): WalkEntry => ({
  model, status: 'done', error: null, extendStatus: new Map(), depth: 25,
})

const progress = (parts: Partial<WalkProgress>): WalkProgress => ({
  phase: 'done', nodes: 2, flows: 0, requests: 1, pending: 0, unbounded: false, error: null, ...parts,
})

function renderLens(extra: Partial<ComponentProps<typeof LineageLens>> = {}) {
  const walk = doneWalk(walkModel('F', [wnode('F'), wnode('up1')]))
  return render(
    <LineageLens
      history={{ entries: ['F'], cursor: 0 }}
      walk={walk}
      walkApi={{ extend: vi.fn(), page: vi.fn(), retry: vi.fn() }}
      onRecenter={vi.fn()}
      onBack={vi.fn()}
      onForward={vi.fn()}
      onClose={vi.fn()}
      {...extra}
    />,
  )
}

describe('LineageLens — the walk narrates itself', () => {
  it('one hop: says the immediate lineage is loading, with counts ticking', () => {
    renderLens({ fullWalkEnabled: false, walkProgress: progress({ phase: 'seeding', nodes: 1240, flows: 3100, requests: 3 }) })
    expect(screen.getByTestId('lens-walk-narration')).toHaveTextContent('loading the immediate lineage · 1,240 nodes · 3,100 flows · 3 requests')
  })

  it('full flow: says it is walking the full flow, with counts ticking', () => {
    renderLens({ fullWalkEnabled: true, walkProgress: progress({ phase: 'walking', nodes: 12400, flows: 8910, requests: 17 }) })
    expect(screen.getByTestId('lens-walk-narration')).toHaveTextContent('walking the full flow · 12,400 nodes · 8,910 flows · 17 requests')
  })

  it('never shows a percentage — the total is unknowable', () => {
    renderLens({ fullWalkEnabled: true, walkProgress: progress({ phase: 'walking', nodes: 5 }) })
    expect(screen.queryByText(/%/)).toBeNull()
  })

  it('says the full flow is drawn once the walk completes', () => {
    renderLens({ fullWalkEnabled: true, walkProgress: progress({ phase: 'done' }) })
    expect(screen.getByText(/full flow drawn/i)).toBeInTheDocument()
  })

  it('one hop: says the immediate lineage is complete when more than one page was needed', () => {
    renderLens({ fullWalkEnabled: false, walkProgress: progress({ phase: 'done', requests: 4 }) })
    expect(screen.getByText(/immediate lineage complete/i)).toBeInTheDocument()
  })

  it('never offers "Keep walking", "Load everything" or "Load more contents"', () => {
    const walk = doneWalk({
      ...walkModel('F', [wnode('F'), wnode('w1')]),
      truncated: true, truncationReason: 'max_nodes', seedTruncated: true, seedCursor: 's:w1',
    })
    renderLens({ walk, fullWalkEnabled: false, walkProgress: progress({ phase: 'seeding', pending: 1 }), onFullWalkToggle: vi.fn() })
    expect(screen.queryByRole('button', { name: /keep walking/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /load everything/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /load more contents/i })).toBeNull()
  })
})

describe('LineageLens — the two valves', () => {
  it('the memory checkpoint asks once, wired to Continue', () => {
    const onWalkContinue = vi.fn()
    renderLens({ fullWalkEnabled: true, walkProgress: progress({ phase: 'checkpoint', nodes: 50000, pending: 12 }), onWalkContinue })
    expect(screen.getByText(/larger than 50,000 nodes/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    expect(onWalkContinue).toHaveBeenCalledTimes(1)
  })

  it('a failed step says what is on the board and offers Try again', () => {
    const onWalkRetry = vi.fn()
    const walk = doneWalk({
      ...walkModel('F', [wnode('F'), wnode('up1'), wnode('up2'), wnode('down1')]),
      upstreamUrns: new Set(['up1', 'up2']),
      downstreamUrns: new Set(['down1']),
      truncated: true,
      truncationReason: 'timeout',
    })
    renderLens({ walk, fullWalkEnabled: false, walkProgress: progress({ phase: 'error', pending: 3, error: 'timeout' }), onWalkRetry })
    expect(screen.getByText(/3 steps failed at the data source/i)).toBeInTheDocument()
    expect(screen.getByText(/2 upstream · 1 downstream are on the board/i)).toBeInTheDocument()
    expect(screen.queryByText(/max_nodes|timeout/)).toBeNull()      // never a reason token
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(onWalkRetry).toHaveBeenCalledTimes(1)
  })

  it('renders the Walk mode toggle and reports the switch', () => {
    const onFullWalkToggle = vi.fn()
    renderLens({ fullWalkEnabled: false, walkProgress: null, onFullWalkToggle })
    expect(viewValue('Walk')).toBe('One hop')
    chooseView('Walk', /^Full flow/)
    expect(onFullWalkToggle).toHaveBeenCalledWith(true)
  })

  it('shows none of the walk surface when the feature is not wired', () => {
    renderLens()
    expect(screen.queryByTestId('lens-walk-narration')).toBeNull()
    expect(screen.queryByText(/full flow drawn/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /^Walk: / })).toBeNull()
  })
})

describe('LineageLens — the capsule says it is calculating (2026-08-22)', () => {
  // The header narration is 10px of muted text and a bottom toast was
  // easy to miss: "the user might confuse that for nothing happening".
  // From the moment Focus opens, the board carries the same capsule the
  // canvas trace uses — headline, ticking counts, the sounding line.
  it('opening on a focus with nothing fetched yet: the capsule names the subject', () => {
    renderLens({ walk: { model: walkModel('F', [wnode('F')]), status: 'loading', error: null, extendStatus: new Map(), depth: 1 }, walkProgress: null })
    const capsule = screen.getByRole('status')
    expect(capsule).toHaveTextContent(/Mapping the lineage of F/)
    expect(screen.queryByText(/Walking the lineage from the data source/)).toBeNull()
  })

  it('before the first page lands the subject is the name the canvas knows, never a URN fragment', () => {
    // Until the model holds the focus its label is derived from the URN
    // (`executive_board_dashboard_de06a1ba`) — the canvas that opened the
    // lens already knows the name, and the capsule is the first thing
    // the reader looks at.
    renderLens({
      history: { entries: ['urn:li:dashboard:executive_board_dashboard_de06a1ba'], cursor: 0 },
      walk: { model: walkModel('urn:li:dashboard:executive_board_dashboard_de06a1ba', []), status: 'loading', error: null, extendStatus: new Map(), depth: 1 },
      walkProgress: null,
      labelHintFor: (urn) => urn === 'urn:li:dashboard:executive_board_dashboard_de06a1ba' ? 'Executive Board Dashboard' : null,
    })
    expect(screen.getByRole('status')).toHaveTextContent(/Mapping the lineage of Executive Board Dashboard/)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Executive Board Dashboard')
  })

  it('while the immediate lineage loads: the capsule, with counts ticking, beside the header narration', () => {
    renderLens({ fullWalkEnabled: false, walkProgress: progress({ phase: 'seeding', nodes: 1240, flows: 3100, requests: 3 }) })
    expect(screen.getByRole('status')).toHaveTextContent(/Loading the immediate lineage/)
    expect(document.body.textContent).toMatch(/1,240 nodes · 3,100 flows · 3 requests/)
    expect(screen.getByTestId('lens-walk-narration')).toBeInTheDocument()
  })

  it('the capsule decides nothing: checkpoint and error stay with the strips', () => {
    renderLens({ fullWalkEnabled: true, walkProgress: progress({ phase: 'checkpoint', nodes: 50000, pending: 12 }), onWalkContinue: vi.fn() })
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument()
  })

  it('a focus already walked opens quiet — no capsule, no flash', () => {
    renderLens({ fullWalkEnabled: false, walkProgress: progress({ phase: 'done', requests: 1 }) })
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('LineageLens — the picture forms where the cards will land (2026-08-22)', () => {
  it('an empty board under the first fetch shows the skeleton of the picture, which leaves once cards exist', () => {
    // The driver's entry opens with an EMPTY model (no focus card yet);
    // the skeleton owns exactly that window.
    const { rerender } = render(
      <LineageLens
        history={{ entries: ['F'], cursor: 0 }}
        walk={{ model: walkModel('F', []), status: 'loading', error: null, extendStatus: new Map(), depth: 1 }}
        walkApi={{ extend: vi.fn(), page: vi.fn(), retry: vi.fn() }}
        onRecenter={vi.fn()} onBack={vi.fn()} onForward={vi.fn()} onClose={vi.fn()}
      />,
    )
    expect(screen.getByTestId('lens-skeleton')).toBeInTheDocument()
    rerender(
      <LineageLens
        history={{ entries: ['F'], cursor: 0 }}
        walk={doneWalk(walkModel('F', [wnode('F'), wnode('up1')]))}
        walkApi={{ extend: vi.fn(), page: vi.fn(), retry: vi.fn() }}
        onRecenter={vi.fn()} onBack={vi.fn()} onForward={vi.fn()} onClose={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('lens-skeleton')).toBeNull()
  })
})

describe('LineageLens — the Path names where you have been (2026-08-22)', () => {
  // "gold_af963e43 › Snowflake › INTERMEDIATE_T1 › …": the trail read each
  // chip off the CURRENT model, so a focus you had left — whose node the
  // new model does not carry — fell back to its URN fragment. The lens
  // now remembers every name it has shown, and asks the canvas for the
  // ones it never saw.
  const GOLD = 'urn:li:container:gold_af963e43'
  const named = (urn: string, label: string): LensWalkNode =>
    ({ ...wnode(urn), data: { urn, label, type: 'container' }, displayName: label }) as unknown as LensWalkNode
  const lens = (history: { entries: string[]; cursor: number }, walk: WalkEntry, labelHintFor?: (urn: string) => string | null) => (
    <LineageLens
      history={history}
      walk={walk}
      walkApi={{ extend: vi.fn(), page: vi.fn(), retry: vi.fn() }}
      onRecenter={vi.fn()} onBack={vi.fn()} onForward={vi.fn()} onClose={vi.fn()} onJumpTo={vi.fn()}
      labelHintFor={labelHintFor}
    />
  )
  const trail = () => screen.getByRole('navigation', { name: /path/i }).textContent ?? ''

  it('a focus you have left keeps its name in the trail after the model moves on', () => {
    const { rerender } = render(lens({ entries: [GOLD], cursor: 0 }, doneWalk(walkModel(GOLD, [named(GOLD, 'GOLD')]))))
    rerender(lens({ entries: [GOLD, 'F'], cursor: 1 }, doneWalk(walkModel('F', [wnode('F')]))))
    expect(trail()).toMatch(/GOLD/)
    expect(trail()).not.toMatch(/gold_af963e43/)
  })

  it('a focus the lens never saw is named by the canvas, not by its URN', () => {
    render(lens({ entries: [GOLD, 'F'], cursor: 1 }, doneWalk(walkModel('F', [wnode('F')])), (urn) => (urn === GOLD ? 'GOLD' : null)))
    expect(trail()).toMatch(/GOLD/)
    expect(trail()).not.toMatch(/gold_af963e43/)
  })
})

describe('LineageLens — a name we do not know is not printed (2026-08-23)', () => {
  // A COLD SHARE-LINK OPEN: no canvas node, no model yet, so the only
  // "label" available is a slice of the URN —
  // `executive_board_dashboard_de06a1ba`. That is an identifier, not a
  // name, and printing it as one (in the title, and in the capsule's
  // "Mapping the lineage of …") reads as a broken product. Until a real
  // name arrives the room says it is finding the focus, and the title
  // holds its place.
  const URN = 'urn:li:dashboard:executive_board_dashboard_de06a1ba'
  const cold = (over: Partial<ComponentProps<typeof LineageLens>> = {}) => renderLens({
    history: { entries: [URN], cursor: 0 },
    walk: { model: walkModel(URN, []), status: 'loading', error: null, extendStatus: new Map(), depth: 1 },
    walkProgress: null,
    ...over,
  })

  it('prints no URN fragment: the capsule says it is finding the focus, the title waits', () => {
    cold()
    expect(document.body.textContent).not.toMatch(/executive_board_dashboard/)
    expect(screen.getByRole('status')).toHaveTextContent(/finding the focus/i)
    expect(screen.getByTestId('lens-title-pending')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull()
  })

  it('the moment a real name arrives — from the canvas or the walk — it is used everywhere', () => {
    cold({ labelHintFor: (urn) => (urn === URN ? 'Executive Board Dashboard' : null) })
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Executive Board Dashboard')
    expect(screen.getByRole('status')).toHaveTextContent(/Mapping the lineage of Executive Board Dashboard/)
    expect(screen.queryByTestId('lens-title-pending')).toBeNull()
  })

  it('a walk that lands the focus names it, with no hint at all', () => {
    const named = { ...wnode(URN), data: { urn: URN, label: 'Executive Board Dashboard', type: 'dashboard' } } as unknown as LensWalkNode
    renderLens({
      history: { entries: [URN], cursor: 0 },
      walk: doneWalk(walkModel(URN, [named])),
    })
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Executive Board Dashboard')
    expect(document.body.textContent).not.toMatch(/executive_board_dashboard_de06a1ba/)
  })
})
