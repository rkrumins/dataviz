/**
 * LineageLens — the lens on the WALK MODEL.
 *
 * Every test here hands the component the same thing production does: a
 * `WalkEntry` (the accumulated union of one-hop closure responses) and
 * the four calls that grow it. There is no canvas store, no store-derived
 * neighbour records, no second source of numbers — which is the point of
 * the rebuild, and what these tests exist to hold.
 *
 * The fixtures are hand-authored merged walk models. One test loads the
 * SHARED wire fixture (`trace_closure_walk_fixture.json`, which the
 * backend's own contract test validates) through the real adapter, so a
 * drift between the wire and this component fails a suite rather than a
 * demo.
 */
import type { ComponentProps } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { LineageLens, type LensWalkSeed } from '../LineageLens'
import { usePreferencesStore } from '@/store/preferences'
import { useSchemaStore } from '@/store/schema'
import { decodeLensShare } from '../lens/shareCodec'
import { FRAME_CONTENT_W } from '../lens/focus-cards'
import type { WalkEntry } from '@/hooks/useLensWalk'
import {
  toLensClosure,
  mergeClosures,
  type LensWalkModel,
  type LensWalkNode,
} from '../lens/closure-adapter'
import type { LensFrontierEntry } from '../lens/lens-subgraph'
import { walkStatusKey } from '../lens/focus-layout'
import type { GraphNode, GraphEdge, TraceV2Result, LensClosureExtras } from '@/providers/GraphDataProvider'

// ── Walk-model fixture kit ───────────────────────────────────────────
// The same shapes `mergeClosures` produces, written by hand so a test
// can state the picture it is about in ten lines.

const wnode = (
  urn: string,
  type = 'dataset',
  label = urn,
  extra: Record<string, unknown> = {},
): LensWalkNode => ({
  id: urn,
  type: 'generic',
  position: { x: 0, y: 0 },
  data: { urn, label, type, ...extra },
  urn,
  displayName: label,
  entityType: type,
}) as unknown as LensWalkNode

/** A lineage hop. Direction is verbatim: source flows INTO target. */
const hop = (source: string, target: string, edgeType = 'DERIVES_FROM') =>
  ({ id: `h:${source}>${target}`, sourceUrn: source, targetUrn: target, edgeType })

/** parent → child containment. Never a hop; only ever nesting. */
const holds = (parent: string, child: string) => ({ sourceUrn: parent, targetUrn: child })

const frontier = (urn: string, totalCount: number | null, nextCursor: string | null = null): LensFrontierEntry =>
  ({ urn, totalCount, nextCursor })

function walkModel(focusUrn: string, parts: Partial<Omit<LensWalkModel, 'focusUrn'>>): LensWalkModel {
  return {
    focusUrn,
    nodes: [],
    lineageEdges: [],
    containmentEdges: [],
    upstreamUrns: new Set(),
    downstreamUrns: new Set(),
    frontierUp: [],
    frontierDown: [],
    truncated: false,
    truncationReason: null,
    seedTruncated: false,
    ...parts,
  }
}

const doneWalk = (
  model: LensWalkModel,
  extendStatus?: Map<string, 'loading' | 'error'>,
  // The depth THIS fixture's walk was fetched at. Defaults to the depth
  // preference's own default (1).
  depth = 1,
): WalkEntry => ({
  model, status: 'done', error: null, extendStatus: extendStatus ?? new Map(),
  depth,
})

const makeApi = () => ({
  extend: vi.fn(),
  page: vi.fn(),
  retry: vi.fn(),
})

type Api = ReturnType<typeof makeApi>

function renderLens(
  entries: string[],
  walk: WalkEntry | null,
  extra: Partial<ComponentProps<typeof LineageLens>> = {},
  api: Api = makeApi(),
) {
  const utils = render(
    <LineageLens
      history={{ entries, cursor: extra.history?.cursor ?? entries.length - 1 }}
      walk={walk}
      walkApi={api}
      onRecenter={vi.fn()}
      onBack={vi.fn()}
      onForward={vi.fn()}
      onClose={vi.fn()}
      {...extra}
    />,
  )
  return { ...utils, api }
}

/** Cards on the board, by their rendered name. */
const onBoard = (label: string) => screen.queryAllByText(label).length > 0

// ── THE BUSINESS JOURNEY ─────────────────────────────────────────────

/**
 * The reported estate, as the walk returns it: a seven-level spine with
 * CONTAINER repeated, and the answer five containment steps below the
 * only thing the focus can see.
 *
 *   Finance ⊃ RiskApp ⊃ PROD ⊃ CURATED ⊃ RISK_DB ⊃ loan_positions
 *   Sales   ⊃ {orders_raw, refunds_raw}          (a branchy domain)
 *   fin_marts ⊃ collaterals (the focus) → risk_exposure_daily
 *
 * This is the shape that used to render as one "Finance" card opening
 * onto nothing.
 */
const collateralsEstate = () => walkModel('F', {
  nodes: [
    wnode('DOM', 'DATADOMAIN', 'Finance', { childCount: 4 }),
    wnode('APP', 'APPLICATION', 'RiskApp', { childCount: 2 }),
    wnode('CTR1', 'CONTAINER', 'PROD', { childCount: 3 }),
    wnode('CTR2', 'CONTAINER', 'CURATED', { childCount: 6 }),
    wnode('DB', 'DATABASE', 'RISK_DB', { childCount: 12 }),
    wnode('t0', 'dataset', 'loan_positions'),
    wnode('SALES', 'DATADOMAIN', 'Sales', { childCount: 40 }),
    wnode('s1', 'dataset', 'orders_raw'),
    wnode('s2', 'dataset', 'refunds_raw'),
    wnode('FT', 'dataset', 'fin_marts', { childCount: 9 }),
    wnode('F', 'dataset', 'collaterals', { description: 'Collateral positions, daily' }),
    wnode('OUT', 'dataset', 'risk_exposure_daily'),
  ],
  containmentEdges: [
    holds('DOM', 'APP'), holds('APP', 'CTR1'), holds('CTR1', 'CTR2'), holds('CTR2', 'DB'),
    holds('DB', 't0'),
    holds('SALES', 's1'), holds('SALES', 's2'),
    holds('FT', 'F'),
  ],
  lineageEdges: [hop('t0', 'F'), hop('s1', 'F'), hop('s2', 'F'), hop('F', 'OUT')],
  upstreamUrns: new Set(['t0', 's1', 's2']),
  downstreamUrns: new Set(['OUT']),
  // The data source says loan_positions has six more producers it has
  // not shipped yet — the one honest reason to offer an ⊕ extend.
  frontierUp: [frontier('t0', 6)],
})

describe('the business journey — a table\'s lineage through a seven-level estate', () => {
  beforeEach(() => usePreferencesStore.setState({ lensViewMode: 'graph', lensFrameChildren: 'connected' }))
  afterEach(() => cleanup())

  it('shows the upstream TABLE immediately, with its whole spine as breadcrumb', () => {
    renderLens(['F'], doneWalk(collateralsEstate()))

    // The ANSWER — the actual upstream table — is visible without a
    // single click, because every level above it is a pass-through.
    expect(onBoard('loan_positions')).toBe(true)
    // `RISK_DB` is where that hop ends, so it is the frame the answer is
    // a row of — countable and searchable in place. The four levels above
    // it are drawn as nothing at all: they are its breadcrumb, and only
    // the deepest of them is named beside it (the rest are in its
    // tooltip).
    expect(onBoard('RISK_DB')).toBe(true)
    for (const wrapper of ['Finance', 'RiskApp', 'PROD']) {
      expect(onBoard(wrapper)).toBe(false)
    }
    // The focus itself, and its consumer.
    expect(screen.getAllByText('collaterals').length).toBeGreaterThan(0)
    expect(onBoard('risk_exposure_daily')).toBe(true)
  })

  it('states honest counts for what a container holds, at both grains', () => {
    renderLens(['F'], doneWalk(collateralsEstate()))
    // Sales holds forty things; exactly two of them are on this lineage.
    // Both numbers, or the card is either a lie or a mystery.
    expect(screen.getByText(/2 on this lineage · of 40/)).toBeTruthy()
  })

  it('a branchy domain arrives with its lineage children in it, and shuts on one click', () => {
    const { api } = renderLens(['F'], doneWalk(collateralsEstate()))
    // Both of Sales's connected tables are where hops END, so Sales is
    // the grain they are presented at and they are its rows — there is
    // nothing to click to see the answer.
    expect(onBoard('orders_raw')).toBe(true)
    expect(onBoard('refunds_raw')).toBe(true)
    // Shutting it is still one click, and still a re-projection: the
    // model already holds them, so neither direction costs a round trip.
    fireEvent.click(screen.getByLabelText('Collapse Sales'))
    expect(onBoard('orders_raw')).toBe(false)
    expect(api.extend).not.toHaveBeenCalled()
    expect(api.page).not.toHaveBeenCalled()
  })

  it('the ⊕ extend asks the server from the card\'s own leaves', () => {
    const { api } = renderLens(['F'], doneWalk(collateralsEstate()))
    // "6 more upstream of loan_positions" — the remainder the data
    // source reported, minus what is already in hand.
    // T24 F7 — a row-level pill names its scope ("(RISK_DB) only").
    fireEvent.click(screen.getByTitle(/Loads the next hop upstream of loan_positions \(RISK_DB\) only · 6 data flows recorded/))
    expect(api.extend).toHaveBeenCalledWith('t0', 'up', ['t0'])
  })

  it('double-clicking a card re-centers the walk there', () => {
    const onRecenter = vi.fn()
    renderLens(['F'], doneWalk(collateralsEstate()), { onRecenter })
    fireEvent.doubleClick(screen.getByText('loan_positions'))
    expect(onRecenter).toHaveBeenCalledWith('t0')
  })

  // T25 C — a real double-click is two native clicks close together, and
  // a browser only fuses them into one `dblclick` if the second lands on
  // the SAME element the first did. `fireEvent.doubleClick` above just
  // dispatches one synthetic `dblclick` straight at the handler, so it
  // would keep passing even if a real double-click could never reach
  // this element — jsdom cannot synthesize the two-click sequence to
  // catch that. What it CAN check is the one precondition a real
  // double-click depends on: that the single click every double-click
  // starts with — which runs the SAME row's onSelect+onIsolate here —
  // never tears the clicked element down and rebuilds it. A rebuilt
  // node is a new target under the second physical click, and no native
  // `dblclick` would ever fire on it.
  it('T25 C — the row a click just selected is not torn down and rebuilt', () => {
    renderLens(['F'], doneWalk(collateralsEstate()))
    const row = screen.getByText('loan_positions').closest('[role="option"]')
    expect(row).not.toBeNull()
    fireEvent.click(row!)
    expect(document.body.contains(row)).toBe(true)
    expect(row!.textContent).toContain('loan_positions')
  })

  // T25 C1 review round 1 — a SECOND, VERIFIED remount mechanism, found
  // while re-checking C1 for the "couldn't reproduce is not a closing
  // state" mandate. `holdsRows(card)` (focus-cards.ts) — `card.kind ===
  // 'frame' || 'focal'` — used to drive the React Flow node TYPE a card
  // rendered through (`FocusGraphView.tsx`'s `baseNodes`: `type:
  // holdsRows(card) ? 'focusFrame' : ... : 'focusCard'`). A card's
  // `kind` legitimately flips from 'entity' to 'frame' the moment its
  // FIRST child is admitted (an existing test two files over — "renders
  // through a merge that changes what every card IS" — already
  // documents this exact transition, just without checking DOM
  // identity). React Flow keys its node wrapper by `id`, but the
  // COMPONENT it renders for that id is looked up by `type` — a
  // different type for the same id is a different React component,
  // which React cannot update in place: it unmounts the old one and
  // mounts the new one. VERIFIED directly (a throwaway DOM-identity
  // probe, not assumed): the SAME 'upstream_table' card's DOM node used
  // to be gone — `document.body.contains` false — after a rerender
  // whose only change was that card gaining its first child. A
  // double-click that straddles this exact transition (the clicked
  // card's OWN children arriving, from an in-flight fetch, between the
  // first and second click) would break for the same reason — the
  // browser's dblclick synthesis needs the second click to land on the
  // SAME element the first one did.
  //
  // FIXED by T27 — 'focusFrame' and 'focusCard' are unified into one
  // stable React Flow node type (`FocusNode`, registered as the sole
  // 'focusCard') that dispatches on `card.kind` internally instead of
  // switching type; the outer element carrying the id/role/gesture
  // handlers is now written once and reused across a kind flip
  // regardless of which content (`EntityContent`/`RowContent`/
  // `FrameContent`) is nested inside it. Unskipped as that task's own
  // definition of done.
  it('T25 C1 review round 1 — a card gaining its first child is NOT remounted (T27)', () => {
    const { rerender } = renderLens(['F'], doneWalk(walkModel('F', {
      nodes: [wnode('F', 'dataset', 'orders_enriched'), wnode('u', 'dataset', 'upstream_table')],
      lineageEdges: [hop('u', 'F')],
      upstreamUrns: new Set(['u']),
    })))
    const before = screen.getByText('upstream_table').closest('[role="button"], [role="option"]')
    expect(before).not.toBeNull()
    rerender(
      <LineageLens
        history={{ entries: ['F'], cursor: 0 }}
        walk={doneWalk(walkModel('F', {
          nodes: [
            wnode('F', 'dataset', 'orders_enriched'),
            wnode('u', 'dataset', 'upstream_table', { childCount: 4 }),
            wnode('u:col', 'schemaField', 'order_id'),
          ],
          containmentEdges: [holds('u', 'u:col')],
          lineageEdges: [hop('u', 'F'), hop('u:col', 'F')],
          upstreamUrns: new Set(['u', 'u:col']),
        }))}
        walkApi={{ extend: () => {}, page: () => {}, retry: () => {} }}
        onRecenter={() => {}}
        onBack={() => {}}
        onForward={() => {}}
        onClose={() => {}}
      />,
    )
    expect(document.body.contains(before)).toBe(true)
  })

  // T27 R2 — the actual gesture the DOM-identity pin above exists to
  // protect: a double-click whose two physical clicks straddle the exact
  // kind transition (this card's OWN children arriving, from an
  // in-flight fetch, between the first click and the second) must still
  // fire `onFocus`. Driven deterministically the same way every other
  // async arrival in this file is — the caller controls `walk` one
  // state transition at a time via `rerender`, so "between the two
  // clicks" is a literal render this test commands, not a timer or a
  // promise it has to win a race against. `fireEvent.click` then
  // `fireEvent.doubleClick`, both against the SAME captured element
  // reference: a real browser's second click would land on whatever
  // element currently occupies that screen position, which is only the
  // ORIGINAL element if — as T27 guarantees — the kind flip never tore
  // it down.
  it('T27 R2 — a double-click straddling a kind transition still fires onFocus', () => {
    const onRecenter = vi.fn()
    const { rerender } = renderLens(['F'], doneWalk(walkModel('F', {
      nodes: [wnode('F', 'dataset', 'orders_enriched'), wnode('u', 'dataset', 'upstream_table')],
      lineageEdges: [hop('u', 'F')],
      upstreamUrns: new Set(['u']),
    })), { onRecenter })
    const before = screen.getByText('upstream_table').closest('[role="button"], [role="option"]')!
    // First click of the pair — the card is still 'entity' kind here.
    fireEvent.click(before)
    // Its own child arrives mid-gesture: the exact transition T25 C1
    // pinned as the remount trigger.
    rerender(
      <LineageLens
        history={{ entries: ['F'], cursor: 0 }}
        walk={doneWalk(walkModel('F', {
          nodes: [
            wnode('F', 'dataset', 'orders_enriched'),
            wnode('u', 'dataset', 'upstream_table', { childCount: 4 }),
            wnode('u:col', 'schemaField', 'order_id'),
          ],
          containmentEdges: [holds('u', 'u:col')],
          lineageEdges: [hop('u', 'F'), hop('u:col', 'F')],
          upstreamUrns: new Set(['u', 'u:col']),
        }))}
        walkApi={{ extend: () => {}, page: () => {}, retry: () => {} }}
        onRecenter={onRecenter}
        onBack={() => {}}
        onForward={() => {}}
        onClose={() => {}}
      />,
    )
    // Second click of the pair, on the SAME element reference — a real
    // dblclick's second click would find nowhere else to land.
    fireEvent.doubleClick(before)
    expect(onRecenter).toHaveBeenCalledWith('u')
  })

  // T27 fix round 1 — code review caught a real, undisclosed regression:
  // every header sub-control (chevron, Connected|All, Find + its own
  // input, the per-frame Focus button, the focal's own name button)
  // only ever called `stopPropagation` inside its OWN `onClick` —
  // `click` and `dblclick` are independent native events with
  // independent propagation, so a double-click landing on any of them
  // bubbled straight past the header to `FocusNode`'s new outer
  // `onDoubleClick` and re-anchored the board out from under the click.
  // Most hostile case: double-clicking a word while typing into Find.
  // Fixed with one `onDoubleClick` guard on the header container itself
  // (`FocusGraphView.tsx`), which every one of these pins would fail
  // without. The complete algebra: header controls never re-anchor: a
  // double-click on the frame's own BLANK chrome still does (the
  // disclosed, intentional new behaviour); and a row inside a frame
  // focuses ITSELF, never its host frame (rows are React Flow siblings
  // of their frame, not DOM descendants, so this was never at risk from
  // the same bug — pinned anyway, since it is the other half of "which
  // element does a double-click in here actually mean").
  it('T27 fix round 1 — double-click on a frame\'s header chevron does not re-anchor the board', () => {
    const onRecenter = vi.fn()
    renderLens(['F'], doneWalk(collateralsEstate()), { onRecenter })
    // "Collapse Sales" — Sales' rows are open by default (T24's own
    // branchy-domain behaviour), so this is the chevron's live label.
    fireEvent.doubleClick(screen.getByLabelText('Collapse Sales'))
    expect(onRecenter).not.toHaveBeenCalled()
  })

  it('T27 fix round 1 — double-click on a frame\'s header Find input does not re-anchor the board', () => {
    const onRecenter = vi.fn()
    // A container wide enough that Find is offered at rest (win.scrollable
    // needs more rows than the frame's own window, FRAME_WINDOW = 8) —
    // no toggle click required to reach a real <input>.
    const nine = Array.from({ length: 9 }, (_, i) => `r${i}`)
    renderLens(['F'], doneWalk(walkModel('F', {
      nodes: [
        wnode('F', 'dataset', 'orders_enriched'),
        wnode('BIG', 'dataset', 'wide_container', { childCount: 9 }),
        ...nine.map(id => wnode(id, 'schemaField', id)),
      ],
      containmentEdges: nine.map(id => holds('BIG', id)),
      lineageEdges: nine.map(id => hop(id, 'F')),
      upstreamUrns: new Set(nine),
    })), { onRecenter })
    // Collapsed to its icon until asked for — a real click opens it,
    // the same way a reader's first click would.
    fireEvent.click(screen.getByLabelText('Find inside wide_container'))
    const find = screen.getByLabelText('Find inside wide_container')
    expect(find.tagName).toBe('INPUT')
    fireEvent.doubleClick(find)
    expect(onRecenter).not.toHaveBeenCalled()
  })

  it('T27 fix round 1 — double-click on a frame\'s own blank chrome still re-anchors it', () => {
    const onRecenter = vi.fn()
    renderLens(['F'], doneWalk(collateralsEstate()), { onRecenter })
    // The outer shell itself, not any header control inside it — see
    // `FocusNode`'s own doc comment for why this one is intentional.
    const outer = screen.getByText('Sales').closest('.pointer-events-none')!
    fireEvent.doubleClick(outer)
    expect(onRecenter).toHaveBeenCalledWith('SALES')
  })

  it('T27 fix round 1 — double-click on a row inside a frame focuses the ROW, not the frame', () => {
    const onRecenter = vi.fn()
    renderLens(['F'], doneWalk(collateralsEstate()), { onRecenter })
    fireEvent.doubleClick(screen.getByText('orders_raw'))
    expect(onRecenter).toHaveBeenCalledWith('s1')
    expect(onRecenter).not.toHaveBeenCalledWith('SALES')
  })

  it('stepping Back to an already-walked focal is instant — no loading state', () => {
    const onBack = vi.fn()
    const { rerender, api } = renderLens(
      ['prev', 'F'],
      doneWalk(collateralsEstate()),
      { onBack },
    )
    fireEvent.click(screen.getByText('Back'))
    expect(onBack).toHaveBeenCalled()

    // The parent moves the cursor; the previous focal's model is still
    // in the hook's session cache, so it arrives already 'done'.
    const previous = doneWalk(walkModel('prev', {
      nodes: [wnode('prev', 'dataset', 'previous_focus'), wnode('up', 'dataset', 'its_source')],
      lineageEdges: [hop('up', 'prev')],
      upstreamUrns: new Set(['up']),
    }))
    rerender(
      <LineageLens
        history={{ entries: ['prev', 'F'], cursor: 0 }}
        walk={previous}
        walkApi={api}
        onRecenter={vi.fn()}
        onBack={onBack}
        onForward={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.queryByText(/Walking the lineage from the data source/)).toBeNull()
    expect(onBoard('its_source')).toBe(true)
    // Task 20, P5: a cache hit renders synchronously — ZERO loading-UI
    // frames, not merely no fetch. Nothing was ever loading here, so
    // neither the extend-ghost nor a spinner has any business appearing.
    expect(document.querySelectorAll('.ghost-shimmer').length).toBe(0)
    expect(document.querySelectorAll('.animate-spin').length).toBe(0)
  })

  it('an extend click acknowledges immediately — a ghost card, not silence, where the arrival lands', () => {
    // BEFORE: nothing in flight, nothing ghosted.
    const { rerender, api } = renderLens(['F'], doneWalk(collateralsEstate()))
    expect(document.querySelectorAll('.ghost-shimmer').length).toBe(0)

    // The click itself (`onExtend` → `api.extend('t0', 'up', ['t0'])`) is
    // pinned elsewhere ("the ⊕ extend asks the server..."); this is the
    // state right after — the SAME `extendStatus` the walk hook sets
    // synchronously with the request, before any response has landed.
    rerender(
      <LineageLens
        history={{ entries: ['F'], cursor: 0 }}
        walk={doneWalk(collateralsEstate(), new Map([[walkStatusKey('in', 't0'), 'loading']]))}
        walkApi={api}
        onRecenter={vi.fn()}
        onBack={vi.fn()}
        onForward={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    // AFTER: the delivery zone says something, not nothing — while the
    // pill's own spinner (pinned elsewhere) is unchanged.
    expect(document.querySelectorAll('.ghost-shimmer').length).toBeGreaterThan(0)

    // On merge — the fetch landed, extendStatus clears and the model
    // carries the new upstream table — the ghost is gone and the real
    // card is up, with no separate "swap" step the reader has to wait
    // through.
    const merged = collateralsEstate()
    rerender(
      <LineageLens
        history={{ entries: ['F'], cursor: 0 }}
        walk={doneWalk(walkModel('F', {
          ...merged,
          nodes: [...merged.nodes, wnode('t0up', 'dataset', 'its_own_source')],
          lineageEdges: [...merged.lineageEdges, hop('t0up', 't0')],
          upstreamUrns: new Set([...merged.upstreamUrns, 't0up']),
        }))}
        walkApi={api}
        onRecenter={vi.fn()}
        onBack={vi.fn()}
        onForward={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(document.querySelectorAll('.ghost-shimmer').length).toBe(0)
  })

  it('a mid-walk share restores the same picture — revealed, opened, preset, depth 2 — with no fetch beyond the initial', () => {
    // What a colleague's link actually carries: they opened Sales's
    // branch (which stays collapsed by default — see the "opens a
    // branchy domain" test above) and filtered to Root cause only.
    const walkSeed: LensWalkSeed = {
      nodeId: 'F',
      direction: 'in',
      revealed: [['in:F', 1], ['out:F', 1]],
      opened: ['FT', 'F', 'DOM', 'APP', 'CTR1', 'CTR2', 'DB', 'SALES'],
      collapsed: [],
      frameAll: [],
      framePages: [],
      frameQueries: [],
      pinned: [], condensedOpen: [],
    }
    const { api } = renderLens(['F'], doneWalk(collateralsEstate()), { walkSeed })

    // Opened by the seed, with no click.
    expect(onBoard('orders_raw')).toBe(true)
    expect(onBoard('refunds_raw')).toBe(true)
    // Root cause only: the downstream card the preset hides.
    expect(onBoard('risk_exposure_daily')).toBe(false)
    // …and the header counts THIS picture. Three producers are drawn and
    // the one consumer is not, so "4 connections" beside a board showing
    // three would be the only number on screen describing something else.
    expect(screen.getByText(/^3 connections/)).toBeTruthy()
    // A seed is a re-projection over the model already fetched — never a
    // round trip, however much it opens.
    expect(api.extend).not.toHaveBeenCalled()
    expect(api.page).not.toHaveBeenCalled()
  })

  it('the header counts every side again when the preset is Both', () => {
    renderLens(['F'], doneWalk(collateralsEstate()))
    expect(screen.getByText(/^4 connections/)).toBeTruthy()
  })
})

// ── PILL HONESTY ─────────────────────────────────────────────────────

/** Every ⊕ state on one board: a reveal that costs nothing, a page with
 *  the server's own cursor, an exact extend, a countless one, one in
 *  flight, one that failed, and a direction that genuinely ended. */
const pillCatalogue = () => {
  const nodes = [
    wnode('F', 'dataset', 'orders_enriched'),
    wnode('EXACT', 'dataset', 'has_48_more'),
    wnode('UNKNOWN', 'dataset', 'count_unknown'),
    wnode('PAGED', 'dataset', 'partially_loaded'),
    wnode('ENDED', 'dataset', 'end_of_lineage'),
    wnode('BUSY', 'dataset', 'fetching_now'),
    wnode('FAILED', 'dataset', 'fetch_failed'),
    wnode('DOWN', 'dataset', 'one_consumer'),
  ]
  const lineageEdges = [
    hop('EXACT', 'F'), hop('UNKNOWN', 'F'), hop('PAGED', 'F'),
    hop('ENDED', 'F'), hop('BUSY', 'F'), hop('FAILED', 'F'), hop('F', 'DOWN'),
  ]
  return walkModel('F', {
    nodes,
    lineageEdges,
    upstreamUrns: new Set(['EXACT', 'UNKNOWN', 'PAGED', 'ENDED', 'BUSY', 'FAILED']),
    downstreamUrns: new Set(['DOWN']),
    frontierUp: [
      frontier('EXACT', 48),
      frontier('UNKNOWN', null),
      frontier('PAGED', 96, 'eyJvZmZzZXQiOjMwfQ=='),
      frontier('BUSY', 12),
      frontier('FAILED', 9),
      // ENDED gets NO entry at all — that is what a dead end is.
    ],
  })
}


/** Fourteen upstream groups against a REVEAL_PAGE of twelve, so the
 *  focus's own ⊕ has a remainder to offer from data already in hand. */
const crowdedFanIn = () => {
  const nodes = [wnode('F', 'dataset', 'dim_customer')]
  const lineageEdges = []
  for (let i = 0; i < 14; i++) {
    const urn = `s${String(i).padStart(2, '0')}`
    nodes.push(wnode(urn, 'dataset', `source_${String(i).padStart(2, '0')}`))
    lineageEdges.push(hop(urn, 'F'))
  }
  return walkModel('F', { nodes, lineageEdges, upstreamUrns: new Set(nodes.slice(1).map(n => n.urn)) })
}

describe('the ⊕ tells the truth about what it costs', () => {
  beforeEach(() => usePreferencesStore.setState({ lensViewMode: 'graph' }))
  afterEach(() => cleanup())

  it('a reveal is instant: more cards, no request', () => {
    const { api } = renderLens(['F'], doneWalk(crowdedFanIn()))
    // Twelve of fourteen fit on the first page.
    expect(onBoard('source_12')).toBe(false)
    fireEvent.click(screen.getByTitle(/Shows the next hop upstream of dim_customer only · 2 data flows recorded/))
    expect(onBoard('source_12')).toBe(true)
    expect(onBoard('source_13')).toBe(true)
    expect(api.extend).not.toHaveBeenCalled()
    expect(api.page).not.toHaveBeenCalled()
  })

  it('a page carries the server\'s own cursor back verbatim', () => {
    // T23 R3 — a LOCAL, smaller-count model: `pillCatalogue`'s own PAGED
    // (96) now legitimately opens the hub-triage list instead (see the
    // 'hub triage' describe block below, which proves exactly that on
    // this same fixture) — this test's own concern is the cursor
    // forwarding mechanic, which needs a delivery UNDER the triage gate
    // to exercise the page click at all.
    const smallPage = walkModel('F', {
      nodes: [wnode('F', 'dataset', 'orders_enriched'), wnode('PAGED', 'dataset', 'partially_loaded')],
      lineageEdges: [hop('PAGED', 'F')],
      upstreamUrns: new Set(['PAGED']),
      frontierUp: [frontier('PAGED', 20, 'eyJvZmZzZXQiOjMwfQ==')],
    })
    const { api } = renderLens(['F'], doneWalk(smallPage))
    fireEvent.click(screen.getByTitle(/Loads the next hop upstream of partially_loaded/))
    expect(api.page).toHaveBeenCalledWith('PAGED', 'up', 'eyJvZmZzZXQiOjMwfQ==')
    expect(api.extend).not.toHaveBeenCalled()
  })

  it('an exact remainder is stated; an unknown one is never invented', () => {
    renderLens(['F'], doneWalk(pillCatalogue()))
    // The exact remainder lives in the hover (R1: the control's own face
    // speaks in verbs, never a raw connection count).
    // T24 F7 — no containment parent here, so only the "only" scope
    // word is added (no parenthetical).
    const exact = screen.getByTitle(/Loads the next hop upstream of has_48_more only · 48 data flows recorded/)
    expect(exact.title).toContain('48')
    // The server did not report a total — no flow count in the hover at
    // all, and never a fabricated number anywhere on the control.
    const countless = screen.getByTitle('Loads the next hop upstream of count_unknown only')
    expect(countless.textContent).not.toMatch(/\d/)
  })

  it('an in-flight extend spins on its own pill; a failed one offers the same click again', () => {
    const { api } = renderLens(['F'], doneWalk(
      pillCatalogue(),
      new Map([['up:BUSY', 'loading'], ['up:FAILED', 'error']]),
    ))
    expect(screen.getByLabelText('Fetching upstream lineage')).toBeTruthy()

    const retry = screen.getByLabelText('Retry fetching upstream of fetch_failed')
    fireEvent.click(retry)
    // Retry IS the action that failed — same key, same call — so the
    // two can never drift out of step.
    expect(api.extend).toHaveBeenCalledWith('FAILED', 'up', ['FAILED'])
  })

  it('a genuinely drained direction is marked as ended, not left blank', () => {
    renderLens(['F'], doneWalk(pillCatalogue()))
    expect(screen.getAllByLabelText('End of upstream lineage').length).toBeGreaterThan(0)
  })

  /**
   * ONE CLICK, ONE VISIBLE DELIVERY — the reported defect, as the user hit it.
   *
   * `GOLD` sits downstream of the focus with a frontier the server reported
   * and NOTHING of its own left to reveal locally. Clicking its ⊕ fetched:
   * the model grew, the card's ×N grew, the focal's reach grew — and the
   * board did not change, because admitting a card's neighbours needs a
   * REVEAL PAGE on that card and an extend click never opened one. The pill
   * then flipped to a reveal of "1", and only the SECOND click drew anything.
   */
  // T23 R3 — `total` defaults to the original 246 (every OTHER caller
  // below still asserts that exact number in its own hover text); the
  // "ONE click" test passes a smaller one, since 246 now legitimately
  // opens the hub-triage list instead (see the 'hub triage' describe
  // block, which proves exactly that on this same shape) and this
  // test's own concern — one click, one visible delivery — needs a
  // delivery UNDER the gate to reach the extend click at all.
  const extendChain = (withConsumer: boolean, total = 246) => doneWalk(walkModel('F', {
    nodes: [
      wnode('F', 'dataset', 'clean_tickets'),
      wnode('GOLD', 'CONTAINER', 'GOLD', { childCount: 8 }),
      ...(withConsumer ? [wnode('MART', 'dataset', 'mart_tickets_daily')] : []),
    ],
    lineageEdges: [
      hop('F', 'GOLD'),
      ...(withConsumer ? [hop('GOLD', 'MART')] : []),
    ],
    downstreamUrns: new Set(withConsumer ? ['GOLD', 'MART'] : ['GOLD']),
    // The server says `total` more connections hang off GOLD downstream.
    frontierDown: [{ urn: 'GOLD', totalCount: total, nextCursor: null }],
  }))

  it('ONE click on an extend ⊕ delivers a VISIBLE cohort — no second click', () => {
    const api = makeApi()
    const { rerender } = renderLens(['F'], extendChain(false, 20), {}, api)
    expect(onBoard('mart_tickets_daily')).toBe(false)

    fireEvent.click(screen.getByTitle(/Loads the next hop downstream of GOLD only/))
    expect(api.extend).toHaveBeenCalledTimes(1)
    expect(api.extend).toHaveBeenCalledWith('GOLD', 'down', ['GOLD'])

    // T25 A — the fetch is IN FLIGHT (exactly what `useLensWalk` shows
    // the instant this click's own request starts): the reveal page now
    // opens only once the arrival is KNOWN, not pre-emptively at click
    // time, so nothing should be visible yet — still no second CLICK,
    // just the render the response's own arrival causes.
    rerender(
      <LineageLens
        history={{ entries: ['F'], cursor: 0 }}
        walk={{ ...extendChain(false, 20), extendStatus: new Map([['down:GOLD', 'loading']]) }}
        walkApi={api}
        onRecenter={vi.fn()}
        onBack={vi.fn()}
        onForward={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(onBoard('mart_tickets_daily')).toBe(false)

    // The merged response lands, exactly as `useLensWalk` would hand it over.
    rerender(
      <LineageLens
        history={{ entries: ['F'], cursor: 0 }}
        walk={extendChain(true, 20)}
        walkApi={api}
        onRecenter={vi.fn()}
        onBack={vi.fn()}
        onForward={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    // VISIBLE. Not fetched-but-unrevealed, and not one click short.
    expect(onBoard('mart_tickets_daily')).toBe(true)
    // ...in its own hop band, at the grain the layout presents it.
    expect(screen.getByText(/Consumers · hop 2/)).toBeTruthy()
    // And no second click was needed to get there.
    expect(api.extend).toHaveBeenCalledTimes(1)
    // The residual pill is honest and in the SAME unit it started in —
    // one of the 20 connections is now drawn, so 19 remain. It does not
    // flip to a card count and read as changing its mind.
    expect(screen.getByTitle(/Loads the next hop downstream of GOLD only · 19 data flows recorded/)).toBeTruthy()
  })

  it('the ⊕ speaks in verbs at rest; the hover states connections consistently, whatever the kind', () => {
    // The defect's other half: "+246" (unfetched connections) became "+1"
    // (groups in hand) in the same place on the same card, so the number
    // appeared to change its mind about the size of what was out there.
    // T21 moves the raw count OFF the control's own face for a fetch
    // (extend/page) entirely — it now lives, honestly and consistently,
    // in the hover; the face speaks a verb, with a card-count for a
    // reveal only (a visible arrival, not a flow).
    renderLens(['F'], extendChain(false))
    const extend = screen.getByTitle(/Loads the next hop downstream of GOLD only · 246 data flows recorded/)
    expect(extend.textContent).not.toMatch(/\d/)

    cleanup()
    // A reveal: fourteen sources, twelve drawn, two waiting — and those
    // two carry one connection each. The FACE shows the card count (2,
    // a visible arrival); the hover states the same two as flows.
    renderLens(['F'], doneWalk(crowdedFanIn()))
    const reveal = screen.getByTitle(/Shows the next hop upstream of dim_customer only · 2 data flows recorded/)
    expect(reveal.textContent).toContain('2')

    cleanup()
    renderLens(['F'], doneWalk(pillCatalogue()))
    expect(screen.getByTitle(/Loads the next hop upstream of partially_loaded only · 96 data flows recorded/)).toBeTruthy()
  })

  it('offers no ⊕ at all until the focal\'s own model has landed', () => {
    // `useLensWalk` holds an EMPTY model until the first response, and
    // ignores an extend before the focal is 'done' — so there is
    // nothing to hang a pill on, and no dead click to make.
    renderLens(['F'], { model: walkModel('F', {}), status: 'loading', error: null, extendStatus: new Map(), depth: 1 })
    expect(screen.queryByTitle(/Loads the next hop/)).toBeNull()
    expect(screen.queryByTitle(/Shows the next hop/)).toBeNull()
  })
})

describe('F1 — the follow pill never blocks the row it sits on', () => {
  beforeEach(() => usePreferencesStore.setState({ lensViewMode: 'graph' }))
  afterEach(() => cleanup())

  const nestedColumnWithPill = () => doneWalk(walkModel('F', {
    nodes: [
      wnode('F', 'dataset', 'stg_orders'),
      wnode('T', 'dataset', 'raw_orders', { childCount: 2 }),
      wnode('c1', 'schemaField', 'shipping_address', { childCount: 1 }),
      wnode('c1a', 'schemaField', 'postal_code'),
      wnode('c2', 'schemaField', 'placed_at'),
    ],
    containmentEdges: [holds('T', 'c1'), holds('T', 'c2'), holds('c1', 'c1a')],
    // `c1a` carries its own two-hop lineage into `c1`, so it is a real
    // population member — visible once `c1`'s chevron opens it, not
    // just a structural child the walk never asked about.
    lineageEdges: [hop('c1a', 'c1'), hop('c1', 'F'), hop('c2', 'F')],
    upstreamUrns: new Set(['c1', 'c2', 'c1a']),
    // The one honest reason `c1`'s row also carries a follow pill.
    frontierUp: [frontier('c1', 5)],
  }))

  it('clicking the row\'s ContentsChevron toggles ITS contents, never the follow pill', () => {
    // jsdom dispatches this click straight at the chevron element, so it
    // cannot exercise the actual paint-order occlusion the bug was (a
    // real browser routing the click to whichever element visually sits
    // on top) — that is what the harness screenshot verifies. The two
    // tests below (own-hover-only, outward growth) are the real
    // regression guards: they pin the CSS that stops the pill from
    // covering the chevron in the first place, reviewed round 1.
    usePreferencesStore.setState({ lensViewMode: 'graph', lensFrameChildren: 'all' })
    const onLoadAllChildren = vi.fn()
    const { api } = renderLens(['F'], nestedColumnWithPill(), { onLoadAllChildren })
    const chevron = screen.getByLabelText("Show what's inside shipping_address")
    const row = chevron.closest('[role="option"]')!
    // The row-wide hover the old code keyed off — present, but inert now.
    fireEvent.mouseEnter(row)
    fireEvent.click(chevron)
    expect(onLoadAllChildren).toHaveBeenCalledWith('c1')
    expect(api.extend).not.toHaveBeenCalled()
    expect(api.page).not.toHaveBeenCalled()
    usePreferencesStore.setState({ lensFrameChildren: 'connected' })
  })

  it('the follow pill expands on its own hover/focus only, never the row\'s ambient one', () => {
    renderLens(['F'], nestedColumnWithPill())
    const pill = screen.getByTitle(/Loads the next hop upstream of shipping_address/)
    // The row's `group` class used to be the trigger (`group-hover:`) —
    // ANY hover on the row, including the chevron, expanded it.
    expect(pill.className).not.toMatch(/(^|\s)group-hover:/)
    expect(pill.className).toMatch(/(^|\s)hover:w-auto\b/)
    expect(pill.className).toMatch(/(^|\s)focus-visible:w-auto\b/)
  })

  it('an in-frame pill\'s expanded state grows OUTWARD past the row edge, never into row content', () => {
    renderLens(['F'], nestedColumnWithPill())
    const pill = screen.getByTitle(/Loads the next hop upstream of shipping_address/)
    // Upstream, in-frame: the rest anchor (`left-1`) is untouched, but
    // the hover/focus state gives up `left` for a `right` pinned to the
    // SAME visual point — so the only edge free to move is the one
    // furthest from the row's content, and it can only move outward.
    expect(pill.className).toMatch(/hover:left-auto\b/)
    expect(pill.className).toMatch(/hover:right-\[var\(--pill-outer\)\]/)
    expect(pill.style.getPropertyValue('--pill-outer')).toBeTruthy()
  })

  const massiveFanIn = () => {
    const nodes = [wnode('F', 'dataset', 'dim_customer')]
    const lineageEdges = []
    for (let i = 0; i < 1234; i++) {
      const urn = `s${i}`
      nodes.push(wnode(urn, 'dataset', `source_${i}`))
      lineageEdges.push(hop(urn, 'F'))
    }
    return walkModel('F', { nodes, lineageEdges, upstreamUrns: new Set(nodes.slice(1).map(n => n.urn)) })
  }

  it('a reveal pill with a 4-digit count stays inside PILL_ZONE at rest, degrading honestly', () => {
    renderLens(['F'], doneWalk(massiveFanIn()))
    const pill = screen.getByTitle(/Shows the next hop upstream of dim_customer/)
    expect(pill.className).toMatch(/max-w-\[36px\]/)
    // Ellipsis-clipped digits would silently claim a SMALLER, WRONG
    // count ("1,2…" reads as a different number); compact notation
    // ("1.2K") stays honest while fitting the capped rest width. The
    // exact count is still what the hover title states in full.
    expect(pill.textContent).toContain('1.2K')
  })
  // A HOVER THAT MOVES THE CONTROL OUT FROM UNDER THE POINTER FLICKERS
  // FOREVER. Reported live: "it non stop keeps flicking until mouse is
  // on the right location as if there is a deadzone". The expansion
  // pins the pill's REST edge and grows the far edge outward — but the
  // pinned value assumed the icon-only rest width, while a pill showing
  // a count rests up to 36px wide. The strip between the two was inside
  // the rest box and outside the expanded one: enter, expand away,
  // leave, shrink back under the pointer, enter again.
  //
  // The invariant, asserted on the CSS the pill actually carries: the
  // expanded box's pinned edge is at least the rest box's own outer
  // edge, so the expanded box always CONTAINS the box the pointer
  // entered.
  it('a counted pill expands outward from its OWN rest edge, never from a narrower one', () => {
    // A pill INSIDE a frame (only those expand outward) that shows a
    // COUNT at rest (only those rest wider than the icon).
    renderLens(['F'], doneWalk(walkModel('F', {
      nodes: [
        wnode('F', 'dataset', 'stg_orders'),
        wnode('T', 'dataset', 'raw_orders', { childCount: 1 }),
        wnode('c1', 'schemaField', 'order_id'),
        ...Array.from({ length: 40 }, (_, i) => wnode(`s${i}`, 'dataset', `source_${i}`)),
      ],
      containmentEdges: [holds('T', 'c1')],
      lineageEdges: [hop('c1', 'F'), ...Array.from({ length: 40 }, (_, i) => hop(`s${i}`, 'c1'))],
      upstreamUrns: new Set(['c1', ...Array.from({ length: 40 }, (_, i) => `s${i}`)]),
    })))
    const pill = screen.getByTitle(/upstream of order_id/)
    expect(pill.className).toMatch(/max-w-\[36px\]/)   // it really is a counted rest state
    const outer = pill.style.getPropertyValue('--pill-outer')
    expect(outer).not.toBe('')
    // `--pill-outer` is `cardWidth - restEdge`, so a SMALLER value means
    // a pinned edge further from the row's left edge. The counted pill's
    // rest box can reach 40px (left-1 + max-w-[36px]); the pin must be
    // at least that far out or the strip between them is a dead zone.
    const cardW = FRAME_CONTENT_W
    expect(cardW - Number.parseFloat(outer)).toBeGreaterThanOrEqual(40)
  })

})

// ── F7 — PARENT ⊕ VS ROW ⊕: SCOPE-NAMING + "ALL" TAG ─────────────────

describe('F7 — a frame-level follow control names its scope; a row-level one names its own (T24 F7)', () => {
  beforeEach(() => usePreferencesStore.setState({ lensViewMode: 'graph' }))
  afterEach(() => cleanup())

  // T holds two columns, BOTH with their own upstream frontier — so T's
  // OWN pill genuinely seeds from two distinct entities (customer_id,
  // order_id), and customer_id's own pill seeds from just itself.
  const frameAndRowPills = () => doneWalk(walkModel('F', {
    nodes: [
      wnode('F', 'dataset', 'orders_enriched'),
      wnode('T', 'dataset', 'raw_orders', { childCount: 2 }),
      wnode('c1', 'schemaField', 'customer_id'),
      wnode('c2', 'schemaField', 'order_id'),
    ],
    containmentEdges: [holds('T', 'c1'), holds('T', 'c2')],
    lineageEdges: [hop('c1', 'F'), hop('c2', 'F')],
    upstreamUrns: new Set(['c1', 'c2']),
    frontierUp: [frontier('c1', 5), frontier('c2', 3)],
  }))

  it('the frame-level control names its scope and the exact entity count it will seed from', () => {
    renderLens(['F'], frameAndRowPills())
    // While raw_orders is OPEN, its own ⊕ defers to the finer grain —
    // its columns already offer this individually (`drawnInsideOffers`,
    // the exact mechanism lensSeam.test.tsx pins for this same shape).
    // Collapsing it is what brings the frame's OWN pill back.
    fireEvent.click(screen.getByLabelText('Collapse raw_orders'))
    // Reported: "Load upstream for everything in PaymentGateway
    // (3 entities)" — here, raw_orders (T) genuinely seeds from BOTH
    // its columns (5 + 3 = 8 flows), so R1c holds: 2, never a guess.
    expect(screen.getByTitle('Load upstream for everything in raw_orders (2 entities) · 8 data flows recorded')).toBeTruthy()
  })

  it('the row-level control names ONLY its own entity, qualified by its parent', () => {
    renderLens(['F'], frameAndRowPills())
    // Reported: "Loads the next hop upstream of Customers (Payment)
    // only" — customer_id seeds from nobody but itself.
    expect(screen.getByTitle('Loads the next hop upstream of customer_id (raw_orders) only · 5 data flows recorded')).toBeTruthy()
  })

  it('the small "all" tag renders ONLY on the frame-level control, never the row-level one', () => {
    renderLens(['F'], frameAndRowPills())
    const rowPill = screen.getByTitle('Loads the next hop upstream of customer_id (raw_orders) only · 5 data flows recorded')
    expect(within(rowPill).queryByText('ALL')).toBeNull()

    fireEvent.click(screen.getByLabelText('Collapse raw_orders'))
    const framePill = screen.getByTitle('Load upstream for everything in raw_orders (2 entities) · 8 data flows recorded')
    expect(within(framePill).getByText('ALL')).toBeTruthy()
  })
})

// ── STATUS SURFACES ──────────────────────────────────────────────────

describe('what the lens says while it cannot answer', () => {
  beforeEach(() => usePreferencesStore.setState({ lensViewMode: 'graph' }))
  afterEach(() => cleanup())

  it('narrates the walk instead of claiming "no connections"', () => {
    renderLens(['F'], { model: walkModel('F', {}), status: 'loading', error: null, extendStatus: new Map(), depth: 1 })
    expect(screen.getByText(/Walking the lineage from the data source/)).toBeTruthy()
  })

  it('surfaces a failure with its reason, and a Retry that re-kicks the walk', () => {
    const { api } = renderLens(['F'], {
      model: walkModel('F', {}), status: 'error', error: 'provider unreachable', extendStatus: new Map(),
      depth: 1,
    })
    expect(screen.getByText(/provider unreachable/)).toBeTruthy()
    fireEvent.click(screen.getByText('Retry'))
    expect(api.retry).toHaveBeenCalledWith('F')
  })

  it('says plainly when the data source cannot walk lineage at all', () => {
    renderLens(['F'], { model: walkModel('F', {}), status: 'unsupported', error: null, extendStatus: new Map(), depth: 1 })
    expect(screen.getByText(/can't walk lineage/)).toBeTruthy()
    // NOT the empty-direction whisper: that is a claim about what the
    // data source said, and it was never asked.
    expect(screen.queryByText(/No upstream sources in the data source/)).toBeNull()
  })

  it('says when the data source stopped early, so the counts read as floors', () => {
    const model = walkModel('F', {
      nodes: [wnode('F'), wnode('u')],
      lineageEdges: [hop('u', 'F')],
      truncated: true,
      truncationReason: 'node budget reached',
    })
    renderLens(['F'], doneWalk(model))
    expect(screen.getByText(/stopped early \(node budget reached\)/)).toBeTruthy()
  })
})

// ── REACH ────────────────────────────────────────────────────────────

describe('reach — how far the walk got, and whether that is all of it', () => {
  afterEach(() => cleanup())

  const reachModel = (withFrontier: boolean) => walkModel('F', {
    nodes: [wnode('F'), wnode('u1'), wnode('u2'), wnode('d1')],
    lineageEdges: [hop('u1', 'F'), hop('u2', 'F'), hop('F', 'd1')],
    upstreamUrns: new Set(['u1', 'u2']),
    downstreamUrns: new Set(['d1']),
    frontierUp: withFrontier ? [frontier('u1', 9)] : [],
  })

  it('counts what the data source named, and marks them as floors while a frontier is open', () => {
    usePreferencesStore.setState({ lensViewMode: 'list' })
    renderLens(['F'], doneWalk(reachModel(true)))
    // Upstream has an open frontier; downstream is drained, and must
    // NOT be marked as a floor just because the other side is. u1/u2
    // carry no containment of their own, so each is its own system.
    expect(screen.getByText(/Fed by 2\+ sources across 2 systems/)).toBeTruthy()
    expect(screen.getByText(/feeds 1 consumer$/)).toBeTruthy()
  })

  it('drops the floor mark once nothing is left to walk', () => {
    usePreferencesStore.setState({ lensViewMode: 'list' })
    renderLens(['F'], doneWalk(reachModel(false)))
    expect(screen.getByText(/Fed by 2 sources across 2 systems/)).toBeTruthy()
    expect(screen.getByText(/feeds 1 consumer$/)).toBeTruthy()
  })

  it('claims no reach at all while the walk is still running', () => {
    usePreferencesStore.setState({ lensViewMode: 'list' })
    renderLens(['F'], { model: reachModel(true), status: 'loading', error: null, extendStatus: new Map(), depth: 1 })
    expect(screen.queryByText(/Fed by|feeds/)).toBeNull()
    expect(screen.getByText(/Walking the lineage…/)).toBeTruthy()
  })

  /** Nothing has been fetched upstream (reach.up === 0) but the server
   *  recorded 66 flows on the focus itself — no lineage edge anywhere in
   *  the model, so the "0 of 66" shape lives entirely in the frontier. */
  const whollyUnfetchedModel = () => walkModel('F', {
    nodes: [wnode('F', 'dataset', 'orders_iot')],
    frontierUp: [frontier('F', 66)],
  })

  it('fix round 1 — a side with a real frontier but nothing fetched yet never claims "no sources" (list body)', () => {
    usePreferencesStore.setState({ lensViewMode: 'list' })
    renderLens(['F'], doneWalk(whollyUnfetchedModel()))
    // The false negative this pin rules out: "No upstream sources"
    // rendered right beside a control offering to load exactly what it
    // just denied existed.
    expect(screen.queryByText('No upstream sources')).toBeNull()
    expect(screen.getByText(/nothing loaded upstream yet/)).toBeTruthy()
  })

  it('fix round 1 — the same honesty in the graph body\'s own orientation sentence', () => {
    usePreferencesStore.setState({ lensViewMode: 'graph' })
    renderLens(['F'], doneWalk(whollyUnfetchedModel()))
    expect(screen.queryByText(/No upstream sources/)).toBeNull()
    expect(screen.getByText(/nothing loaded upstream yet/)).toBeTruthy()
  })
})

// ── ONE MODEL, TWO BODIES ────────────────────────────────────────────

describe('the list body and the graph body are two renderings of one model', () => {
  afterEach(() => cleanup())

  const model = () => walkModel('F', {
    nodes: [
      wnode('F', 'dataset', 'stg_orders'),
      wnode('T', 'dataset', 'raw_orders'),
      wnode('c1', 'schemaField', 'order_id'),
      wnode('c2', 'schemaField', 'customer_id'),
      wnode('OUT', 'dataset', 'fct_orders'),
    ],
    containmentEdges: [holds('T', 'c1'), holds('T', 'c2')],
    lineageEdges: [hop('c1', 'F'), hop('c2', 'F'), hop('F', 'OUT')],
    upstreamUrns: new Set(['c1', 'c2']),
    downstreamUrns: new Set(['OUT']),
  })

  it('agrees about the counts whichever body is on screen', () => {
    usePreferencesStore.setState({ lensViewMode: 'graph' })
    const { unmount } = renderLens(['F'], doneWalk(model()))
    // The focal card, in the graph. Its number is REACH — what the data
    // source named around this entity — not the walk's own loaded degree:
    // "2 in / 1 out" used to sit here and grew every time the user
    // clicked, which is what E deleted it for. c1/c2 both live inside T,
    // one system; OUT has no parent, its own system.
    expect(screen.getByText(/Fed by 2 sources/)).toBeTruthy()
    expect(screen.getByText(/feeds 1 consumer/)).toBeTruthy()
    unmount()

    usePreferencesStore.setState({ lensViewMode: 'list' })
    renderLens(['F'], doneWalk(model()))
    const sourcesHeader = screen.getByText('Data Sources').closest('div')!
    expect(within(sourcesHeader).getByText('2')).toBeTruthy()
    // The same two columns, named — grouped under the table that holds
    // them, which is the structural story the graph tells by nesting.
    expect(screen.getByText('order_id')).toBeTruthy()
    expect(screen.getByText('customer_id')).toBeTruthy()
    expect(screen.getByText('raw_orders')).toBeTruthy()
  })

  it('re-centers from a list row', () => {
    usePreferencesStore.setState({ lensViewMode: 'list' })
    const onRecenter = vi.fn()
    renderLens(['F'], doneWalk(model()), { onRecenter })
    fireEvent.click(screen.getByText('fct_orders'))
    expect(onRecenter).toHaveBeenCalledWith('OUT')
  })

  it('a type chip hides entities and keeps saying how many', () => {
    usePreferencesStore.setState({ lensViewMode: 'graph' })
    renderLens(['F'], doneWalk(walkModel('F', {
      nodes: [wnode('F'), wnode('v', 'view', 'reporting_view'), wnode('d', 'dataset', 'fct_orders')],
      lineageEdges: [hop('v', 'F'), hop('F', 'd')],
      upstreamUrns: new Set(['v']),
      downstreamUrns: new Set(['d']),
    })))
    expect(onBoard('reporting_view')).toBe(true)
    fireEvent.click(screen.getByTitle('Click to hide view entities (1)'))
    expect(onBoard('reporting_view')).toBe(false)
    // Removed, and SAID — a chip never loses anything silently.
    expect(screen.getByText('1 hidden by the type chips')).toBeTruthy()
  })
})

// ── THE SHELL ────────────────────────────────────────────────────────

describe('the shell around the picture', () => {
  afterEach(() => cleanup())

  const simple = () => doneWalk(walkModel('b', {
    nodes: [wnode('a', 'dataset', 'label-a'), wnode('b', 'dataset', 'label-b'), wnode('c', 'dataset', 'label-c')],
    lineageEdges: [hop('a', 'b'), hop('b', 'c')],
    upstreamUrns: new Set(['a']),
    downstreamUrns: new Set(['c']),
  }))

  it('renders nothing when the history is empty', () => {
    renderLens([], null)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('is a labelled dialog naming what it is about', () => {
    usePreferencesStore.setState({ lensViewMode: 'list' })
    renderLens(['b'], simple())
    expect(screen.getByRole('dialog', { name: 'Connections of label-b' })).toBeTruthy()
  })

  it('Escape closes the lens', () => {
    const onClose = vi.fn()
    renderLens(['b'], simple(), { onClose })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('ArrowRight steps forward; ignored while typing in the filter input', () => {
    const onForward = vi.fn()
    renderLens(['a', 'b'], simple(), { history: { entries: ['a', 'b'], cursor: 0 }, onForward })
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(onForward).toHaveBeenCalledTimes(1)

    const input = screen.getByPlaceholderText('Filter connections…')
    fireEvent.keyDown(input, { key: 'ArrowRight' })
    expect(onForward).toHaveBeenCalledTimes(1)
  })

  it('restores a shared path: every hop a chip, the cursor where the link left it', () => {
    const onJumpTo = vi.fn()
    renderLens(['a', 'b', 'c'], simple(), { history: { entries: ['a', 'b', 'c'], cursor: 1 }, onJumpTo })
    expect(screen.getByText('Path')).toBeTruthy()
    // The forward side of the history stays visible and clickable —
    // browser history, not a destructive stack.
    fireEvent.click(screen.getByTitle(/Jump to label-c/))
    expect(onJumpTo).toHaveBeenCalledWith(2)
  })

  it('the PATH bar\'s own link action produces the identical URL the header button does (T24 F3)', () => {
    // The working share mechanism (`copyShareLink`) used to live ONLY
    // in the header — invisible from the PATH bar, where "Copy path"
    // only ever copied plain TEXT. Reported: a reader scanning the path
    // for "how do I share this" found no link action there at all.
    usePreferencesStore.setState({ lensViewMode: 'graph', lensInitialDepth: 2 })
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderLens(['a', 'b', 'c'], simple(), { history: { entries: ['a', 'b', 'c'], cursor: 1 }, onJumpTo: vi.fn() })

    fireEvent.click(screen.getByLabelText('Copy exploration link'))
    fireEvent.click(screen.getByTitle(/Copy a LINK to this view/))
    expect(writeText).toHaveBeenCalledTimes(2)
    // Byte-identical: the SAME call (`copyShareLink`), not a second
    // codec path that could quietly drift from the header's.
    expect(writeText.mock.calls[0][0]).toBe(writeText.mock.calls[1][0])

    // "Copy path" is a DIFFERENT action (plain text, not a link) —
    // distinct labels keep the two from reading as one offer twice.
    fireEvent.click(screen.getByTitle(/Copy this path as TEXT/))
    expect(writeText).toHaveBeenCalledTimes(3)
    expect(writeText.mock.calls[2][0]).not.toContain('http')

    usePreferencesStore.setState({ lensInitialDepth: 1 })
  })

  it('the body toggle switches to the list and persists the preference', () => {
    usePreferencesStore.setState({ lensViewMode: 'graph' })
    renderLens(['b'], simple())
    expect(screen.queryByText('Upstream')).toBeNull()
    fireEvent.click(screen.getByTitle('List — scan all connections as columns'))
    expect(screen.getByText('Upstream')).toBeTruthy()
    expect(usePreferencesStore.getState().lensViewMode).toBe('list')
  })

  it('the container default is a preference, persisted like the body mode', () => {
    usePreferencesStore.setState({ lensViewMode: 'graph', lensFrameChildren: 'connected' })
    renderLens(['b'], simple())
    fireEvent.click(screen.getByTitle(/Containers you open next show everything inside/))
    expect(usePreferencesStore.getState().lensFrameChildren).toBe('all')
    usePreferencesStore.setState({ lensFrameChildren: 'connected' })
  })

  it('offers the picture as an image without throwing', () => {
    usePreferencesStore.setState({ lensViewMode: 'graph' })
    renderLens(['b'], simple())
    const download = screen.getByLabelText('Download this lineage as an image')
    expect(() => fireEvent.click(download)).not.toThrow()
  })

  // A HOVER LABEL THAT ITS OWN CONTAINER CLIPS IS NO LABEL AT ALL. The
  // control stack used to carry `overflow-hidden` (to clip the buttons'
  // corners into its rounded border), which swallowed every one of the
  // labels positioned just outside their left edges — leaving only the
  // browser's own `title` box a second later, reported as "massively
  // delayed and takes ages to appear compared to other sections". The
  // corners are rounded on the end buttons instead.
  it('the board control stack does not clip its own hover labels', () => {
    usePreferencesStore.setState({ lensViewMode: 'graph' })
    renderLens(['b'], simple())
    const zoom = screen.getByLabelText('Zoom in')
    // The label is a sibling of the button it explains...
    const label = zoom.parentElement!.querySelector('span[role="presentation"]')
    expect(label?.textContent).toBe('Zoom in')
    // ...and nothing between it and the board clips it away.
    for (let el = zoom.parentElement; el; el = el.parentElement) {
      expect(el.className).not.toMatch(/\boverflow-hidden\b/)
      if (el.classList.contains('react-flow')) break
    }
  })

  it('offers the walk as JSON and CSV downloads, beside the image export', () => {
    usePreferencesStore.setState({ lensViewMode: 'graph' })
    renderLens(['b'], simple())
    expect(() => fireEvent.click(screen.getByLabelText('Export lineage data as JSON'))).not.toThrow()
    expect(() => fireEvent.click(screen.getByLabelText('Export lineage data as CSV'))).not.toThrow()
  })

  it('the header-level Connected|All control states its scope, not hover-only (T24 F6)', () => {
    // Reported: this control wears the SAME icons as the per-frame
    // Connected|All pair on an open frame, but seeds only the NEXT
    // container opened — it never touches one already open — and read
    // as a global toggle because nothing on its face said otherwise.
    usePreferencesStore.setState({ lensViewMode: 'graph' })
    renderLens(['b'], simple())
    const group = screen.getByLabelText(/What containers you open next will show/)
    expect(within(group).getByText('Next')).toBeTruthy()
  })

  it('the direction preset filters the board view-side, with no fetch, and toggles back cleanly', () => {
    usePreferencesStore.setState({ lensViewMode: 'graph' })
    const { api } = renderLens(['b'], simple())
    expect(onBoard('label-a')).toBe(true)
    expect(onBoard('label-c')).toBe(true)

    fireEvent.click(screen.getByTitle('Show only what feeds this entity — upstream'))
    expect(onBoard('label-a')).toBe(true)
    expect(onBoard('label-c')).toBe(false)
    expect(api.extend).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTitle('Show upstream and downstream'))
    expect(onBoard('label-a')).toBe(true)
    expect(onBoard('label-c')).toBe(true)
  })

  it('the share link encodes the exploration on screen as v3 (T23 — pinned/condensedOpen; T28 R3 — railWindow always null now)', () => {
    usePreferencesStore.setState({ lensViewMode: 'graph', lensInitialDepth: 2 })
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderLens(['F'], doneWalk(collateralsEstate()))
    fireEvent.click(screen.getByTitle('Show only what feeds this entity — upstream'))
    fireEvent.click(screen.getByLabelText('Copy exploration link'))

    expect(writeText).toHaveBeenCalledTimes(1)
    const url = new URL(writeText.mock.calls[0][0] as string)
    const decoded = decodeLensShare(url.searchParams.get('lens') ?? '')
    expect(decoded?.v).toBe(3)
    if (decoded?.v !== 3) throw new Error('expected a v3 token')
    expect(decoded.entries).toEqual(['F'])
    expect(decoded.mode).toBe('graph')
    expect(decoded.depth).toBe(2)
    expect(decoded.direction).toBe('in')
    // Nothing placed, nothing unfolded — a plain exploration's own v3
    // fields are the same empty/null they open with. `railWindow` is
    // ALWAYS null now (T28 R3 — encodeLensShare writes nothing for it).
    expect(decoded.pinned).toEqual([])
    expect(decoded.railWindow).toBeNull()
    expect(decoded.condensedOpen).toEqual([])
    usePreferencesStore.setState({ lensInitialDepth: 1 })
  })

  it('every card is movable, and a frame carries its children rather than shedding them', () => {
    usePreferencesStore.setState({ lensViewMode: 'graph' })
    renderLens(['F'], doneWalk(walkModel('F', {
      nodes: [
        wnode('F', 'dataset', 'stg_orders'),
        wnode('T', 'dataset', 'raw_orders', { childCount: 4 }),
        wnode('c1', 'schemaField', 'order_id'),
        wnode('c2', 'schemaField', 'placed_at'),
      ],
      containmentEdges: [holds('T', 'c1'), holds('T', 'c2')],
      lineageEdges: [hop('c1', 'F'), hop('c2', 'F')],
      upstreamUrns: new Set(['c1', 'c2']),
    })))

    // The table is where the hops end, so it arrives as the frame its
    // columns are rows of. T27 — 'focusFrame' is retired (frame/focal
    // and entity/row now share one React Flow type, 'focusCard', so a
    // card's kind never remounts it); found by its own name instead.
    const frame = screen.getByText('raw_orders').closest('.react-flow__node')
    expect(frame?.className).toContain('draggable')
    // The column rides along as a child node, so dragging the table
    // moves the whole thing — a table never sheds a column.
    const child = screen.getByText('order_id').closest('.react-flow__node')
    expect(child).toBeTruthy()
    expect(child!.className).not.toContain('draggable')
  })

  // The footer's "Reveal N on canvas" and "Trace from here" buttons were
  // withdrawn (user, 2026-08-17): both leave the lens to act on the
  // canvas behind it, which is a different job from walking lineage.
  // `onLocateAll` stays on the contract for its other callers, and the
  // per-card "Show on the canvas behind" action still reveals one
  // entity — which is what the reveal was actually wanted for.
  it('no longer offers a whole-neighbourhood reveal from the footer', () => {
    usePreferencesStore.setState({ lensViewMode: 'list' })
    const onLocateAll = vi.fn()
    renderLens(['b'], simple(), { onLocateAll })
    expect(screen.queryByText(/Reveal \d+ on canvas/)).toBeNull()
    expect(screen.queryByText('Trace from here')).toBeNull()
    expect(onLocateAll).not.toHaveBeenCalled()
  })
})

// ── ISOLATION ────────────────────────────────────────────────────────

describe('pointing at an element isolates its lineage cone', () => {
  beforeEach(() => usePreferencesStore.setState({ lensViewMode: 'graph' }))
  afterEach(() => cleanup())

  /**
   *   a ─▶ b(focus) ─▶ c
   *   d ─▶ b
   *
   * `d` is the whole test: a SIBLING producer of the focus. It is one
   * hop from `a` in an undirected reading of this board and NOT on `a`'s
   * cone in a directed one — which is the difference between isolation
   * meaning something and lighting the whole picture.
   */
  const siblings = () => doneWalk(walkModel('b', {
    nodes: [
      wnode('a', 'dataset', 'label-a'), wnode('b', 'dataset', 'label-b'),
      wnode('c', 'dataset', 'label-c'), wnode('d', 'dataset', 'label-d'),
    ],
    lineageEdges: [hop('a', 'b'), hop('b', 'c'), hop('d', 'b')],
    upstreamUrns: new Set(['a', 'd']),
    downstreamUrns: new Set(['c']),
  }))

  // The card's OWN root (role="button") carries the treatment;
  // `.react-flow__node` is React Flow's wrapper one level further out.
  // A SELECTED card's label is also echoed in the detail strip below the
  // board, so disambiguate by picking the match that lives on the board.
  const nodeFor = (label: string) => {
    const onCanvas = screen.getAllByText(label).find(el => el.closest('.react-flow__node'))!
    return onCanvas.closest('[role="button"]')! as HTMLElement
  }

  /** The off-cone floor. Deliberately not the old 30%: a highlight that
   *  turns the rest of the board into grey ghosts costs the reader the
   *  context they were reading the cone against. Desaturated as well as
   *  dimmed, because opacity alone flattens the board — desaturation is a
   *  precomputed muted colour now (Task 20, P2), not a CSS filter class,
   *  so it shows up as a DIFFERENT `borderLeftColor` rather than a class. */
  const QUIET = 'opacity-60'
  /** On the cone: lifted with its own type colour. */
  const lit = (el: HTMLElement) => el.style.boxShadow !== ''

  it('clicking an element lights its cone and quiets a sibling producer', () => {
    renderLens(['b'], siblings())
    fireEvent.click(screen.getByText('label-a'))

    // Downstream all the way through the focus...
    expect(lit(nodeFor('label-a'))).toBe(true)
    expect(lit(nodeFor('label-c'))).toBe(true)
    // ...and NOT the other producer of the same target.
    expect(nodeFor('label-d').className).toContain(QUIET)
    // Same entity type as the lit `label-a` (both `dataset`), so their
    // full-saturation accent is identical — a DIFFERENT rendered colour
    // on the off-cone one is the desaturation, applied without a filter.
    expect(nodeFor('label-d').style.borderLeftColor).not.toBe(nodeFor('label-a').style.borderLeftColor)
    // Quiet, never invisible: the floor holds.
    expect(nodeFor('label-d').className).not.toContain('opacity-30')
    expect(nodeFor('label-a').className).not.toContain(QUIET)
  })

  it('says what is isolated, and offers the way out', () => {
    renderLens(['b'], siblings())
    fireEvent.click(screen.getByText('label-a'))
    expect(screen.getByText(/its lineage within this walk/)).toBeTruthy()
    expect(screen.getByText('Esc to clear')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Clear isolation'))
    expect(screen.queryByText(/its lineage within this walk/)).toBeNull()
    expect(nodeFor('label-d').className).not.toContain(QUIET)
  })

  it('clicking the board behind everything clears it', () => {
    renderLens(['b'], siblings())
    fireEvent.click(screen.getByText('label-a'))
    expect(nodeFor('label-d').className).toContain(QUIET)
    // One layer per click, innermost first: the selection this click also
    // made goes first, then the isolation.
    fireEvent.click(document.querySelector('.react-flow__pane')!)
    fireEvent.click(document.querySelector('.react-flow__pane')!)
    expect(nodeFor('label-d').className).not.toContain(QUIET)
  })

  it('hovering isolates after 250ms of intent, and letting go restores', () => {
    vi.useFakeTimers()
    try {
      renderLens(['b'], siblings())
      fireEvent.mouseEnter(nodeFor('label-a'))
      act(() => { vi.advanceTimersByTime(249) })
      // A pointer crossing the board never strobes it.
      expect(nodeFor('label-d').className).not.toContain(QUIET)
      act(() => { vi.advanceTimersByTime(1) })
      expect(nodeFor('label-d').className).toContain(QUIET)
      expect(lit(nodeFor('label-a'))).toBe(true)
      // No chip while it is only a hover — letting go IS the exit.
      expect(screen.queryByText(/its lineage within this walk/)).toBeNull()

      // The release is deferred by a hair so that moving to the NEXT
      // card hands the cone over instead of clearing the whole board and
      // lighting it again (the test below) — it is still gone within a
      // frame or two of a real departure.
      fireEvent.mouseLeave(nodeFor('label-a'))
      act(() => { vi.advanceTimersByTime(60) })
      expect(nodeFor('label-d').className).not.toContain(QUIET)
    } finally {
      vi.useRealTimers()
    }
  })

  it('moving from one card to the next HANDS THE CONE OVER — the board never blanks between them', () => {
    // The board-wide fact "is anything isolated at all?" is the one
    // change every card must answer, so passing through "nothing is"
    // between two hovers re-rendered all 151 cards of the measured
    // wide-hub board, twice, for a single pointer move. Going straight
    // from one cone to the next re-renders only the cards whose own
    // answer changed. Pinned on the observable: `d` is off `a`'s cone,
    // so it must stay quiet for the whole crossing.
    vi.useFakeTimers()
    try {
      renderLens(['b'], siblings())
      fireEvent.mouseEnter(nodeFor('label-a'))
      act(() => { vi.advanceTimersByTime(250) })
      expect(nodeFor('label-d').className).toContain(QUIET)

      // Leave `a` and arrive at `d` the way a pointer actually does:
      // the leave first, the enter immediately after.
      fireEvent.mouseLeave(nodeFor('label-a'))
      fireEvent.mouseEnter(nodeFor('label-d'))
      // Past the release, well short of the next card's own intent.
      act(() => { vi.advanceTimersByTime(61) })
      // `a`'s cone is still what is drawn — the board did not blank.
      expect(nodeFor('label-d').className).toContain(QUIET)
      expect(lit(nodeFor('label-a'))).toBe(true)

      // ...and the hand-over completes on `d`'s own intent.
      act(() => { vi.advanceTimersByTime(250) })
      expect(nodeFor('label-d').className).not.toContain(QUIET)
      expect(lit(nodeFor('label-d'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a hover outranks the stuck isolation, and releasing it falls back', () => {
    vi.useFakeTimers()
    try {
      renderLens(['b'], siblings())
      // Stick on `a`: `d` is off the cone.
      fireEvent.click(screen.getByText('label-a'))
      expect(nodeFor('label-d').className).toContain(QUIET)

      // Now rest the pointer on `d`: ITS cone is what is drawn, so `a`
      // is the one that quiets.
      fireEvent.mouseEnter(nodeFor('label-d'))
      act(() => { vi.advanceTimersByTime(250) })
      expect(nodeFor('label-d').className).not.toContain(QUIET)
      expect(nodeFor('label-a').className).toContain(QUIET)

      // Let go, and the click's own isolation is back — never nothing.
      fireEvent.mouseLeave(nodeFor('label-d'))
      act(() => { vi.advanceTimersByTime(60) })
      expect(nodeFor('label-d').className).toContain(QUIET)
    } finally {
      vi.useRealTimers()
    }
  })

  it('isolates just the same under reduced motion', () => {
    // The wires' own drift is not assertable here: React Flow draws no
    // edges at all until its nodes have been MEASURED, and jsdom measures
    // nothing (the harness screenshot is where the drift itself is
    // actually looked at). A certain (column-true) wire never carries a
    // flow class at all any more (review round 1, T24 — grain is a
    // static base-stroke fact, and only a coarse wire ever animates), so
    // there is nothing left to gate here for THIS fixture's plain edges;
    // `edgeGrainVisual`'s own unit tests pin the reduced-motion behaviour
    // directly. What this integration-level check still verifies is that
    // the isolation state machinery itself is unaffected by the motion
    // preference.
    usePreferencesStore.setState({ lensViewMode: 'graph', reducedMotion: true })
    try {
      renderLens(['b'], siblings())
      fireEvent.click(screen.getByText('label-a'))
      // The cone is still isolated, motion or not.
      expect(nodeFor('label-d').className).toContain(QUIET)
      expect(lit(nodeFor('label-a'))).toBe(true)
    } finally {
      usePreferencesStore.setState({ reducedMotion: false })
    }
  })

  it('a diamond lights both branches', () => {
    // H is two hops from the focus, so it needs A's and B's own pages
    // revealed too — a seed is the simplest way to land it on the board
    // without a click standing in for the thing under test.
    const walkSeed: LensWalkSeed = {
      nodeId: 'F', direction: 'both',
      revealed: [['in:F', 1], ['out:F', 1], ['in:A', 1], ['in:B', 1]],
      opened: [], collapsed: [], frameAll: [], framePages: [], frameQueries: [],
      pinned: [], condensedOpen: [],
    }
    renderLens(['F'], doneWalk(walkModel('F', {
      nodes: [wnode('H', 'dataset', 'hub'), wnode('A', 'dataset', 'branch_a'), wnode('B', 'dataset', 'branch_b'), wnode('F', 'dataset', 'the_focus')],
      lineageEdges: [hop('H', 'A'), hop('A', 'F'), hop('H', 'B'), hop('B', 'F')],
      upstreamUrns: new Set(['H', 'A', 'B']),
    })), { walkSeed })
    fireEvent.click(screen.getByText('hub'))
    expect(lit(nodeFor('branch_a'))).toBe(true)
    expect(lit(nodeFor('branch_b'))).toBe(true)
    expect(nodeFor('branch_a').className).not.toContain(QUIET)
    expect(nodeFor('branch_b').className).not.toContain(QUIET)
  })

  it('the band headers say how much of each column the cone runs through', () => {
    renderLens(['b'], siblings())
    expect(screen.queryByText(/on this path/)).toBeNull()
    fireEvent.click(screen.getByText('label-a'))
    // One of the two upstream cards is on it; the downstream column's
    // only card is too.
    expect(screen.getAllByText(/· 1 on this path/).length).toBe(2)
  })

  // ── THE SPOTLIGHT CHIP (R0) ──────────────────────────────────────────

  /** U is upstream of F with nothing of its own drawn yet — the server
   *  says six connections exist, all still to fetch. */
  const spotlightEstate = () => doneWalk(walkModel('F', {
    nodes: [wnode('F', 'dataset', 'focus_entity'), wnode('U', 'dataset', 'upstream_one')],
    lineageEdges: [hop('U', 'F')],
    upstreamUrns: new Set(['U']),
    frontierUp: [frontier('U', 6)],
  }))

  /** The chip's own card, scoped so `getByText('Focus here')` cannot
   *  collide with the detail strip's identical button — a top-level
   *  card's click both selects (opens the strip) and isolates (opens
   *  the chip) at once. */
  const spotlightChip = () => screen.getByText(/its lineage within this walk/).closest('.rounded-2xl')! as HTMLElement

  it('R1b — THE EMPTY SIDE MUST SPEAK: a wholly unfetched side states its frontier, never silent darkness', () => {
    // The exact repro shape: U's upstream has NOTHING drawn (0 fetched)
    // but the server recorded 6 flows. The old chip either fell silent
    // about this side entirely, or (before that) claimed it honestly as
    // "0 of 6" — R1b's own wording is more direct: name the zero as
    // UNFETCHED, not drained, with the load action right there.
    renderLens(['F'], spotlightEstate())
    fireEvent.click(screen.getByText('upstream_one'))
    const chip = spotlightChip()
    expect(within(chip).getByText(/upstream_one/)).toBeTruthy()
    expect(within(chip).getByText('nothing loaded upstream yet · 6 flows recorded')).toBeTruthy()
  })

  it('the bridge control follows the anchor\'s remaining lineage, element-precise', () => {
    const api = makeApi()
    renderLens(['F'], spotlightEstate(), {}, api)
    fireEvent.click(screen.getByText('upstream_one'))
    fireEvent.click(within(spotlightChip()).getByText('Load upstream'))
    // Seeded from U alone — the same call U's own ⊕ would make, not the
    // focus's.
    expect(api.extend).toHaveBeenCalledWith('U', 'up', ['U'])
  })

  it('the second bridge control re-anchors the board on the spotlighted element', () => {
    const onRecenter = vi.fn()
    renderLens(['F'], spotlightEstate(), { onRecenter })
    fireEvent.click(screen.getByText('upstream_one'))
    fireEvent.click(within(spotlightChip()).getByText('Focus here'))
    expect(onRecenter).toHaveBeenCalledWith('U')
  })

  it('offers no bridge control once a direction is fully drained — never a dead click', () => {
    renderLens(['b'], siblings())
    fireEvent.click(screen.getByText('label-a'))
    const chip = spotlightChip()
    // label-a's own upstream is drained in this fixture (no frontier
    // configured) — the honest floor states every one is already on the
    // board, and there is nothing left to promise a fetch for.
    expect(within(chip).getByText(/known upstream flows? — every one on this board/)).toBeTruthy()
    expect(within(chip).queryByText(/^Load /)).toBeNull()
  })

  it('R1b — the chip still speaks when the CONE finds no drawn wire at all, not just when one side is empty', () => {
    // A focal utterly alone on the board (zero lineage edges anywhere)
    // but with its own recorded, unfetched frontier — `isolationCone`
    // returns null for an anchor touching no drawn wire (nothing to
    // isolate), which used to take the chip down with it: the reader
    // clicked the focus's own name and got total silence, exactly the
    // "no lineage" misread the user reported. The focus's isolate
    // control is real (its own name is a button) — this is a genuine
    // click path, not a synthetic one.
    renderLens(['F'], doneWalk(walkModel('F', {
      nodes: [wnode('F', 'dataset', 'lonely_focus')],
      frontierUp: [frontier('F', 66)],
    })))
    fireEvent.click(screen.getByLabelText('lonely_focus — isolate the lineage running through it'))
    const chip = spotlightChip()
    expect(within(chip).getByText('nothing loaded upstream yet · 66 flows recorded')).toBeTruthy()
    expect(within(chip).getByText('Load upstream')).toBeTruthy()
    // The other side is drained (never fetched, never reported by the
    // server either) and says so too — never dropped from the chip.
    expect(within(chip).getByText(/0 known downstream flows? — every one on this board/)).toBeTruthy()
  })

  // ── THE GRAIN SEAM's own honesty (Task 22, R1 rule 3) ────────────────

  it('R1 rule 3 — the chip states what is drawn is at table grain, matching the seam it paints on the wire', () => {
    // The focus's own downstream (its NATURAL side, always shown) lands
    // on MID — a table that HOLDS THINGS (childCount), so the wire is
    // coarse (see `holdsThings`, focus-layout.ts). The chip's count line
    // must say so, in the same words the wire is painted with, not just
    // "known".
    renderLens(['F'], doneWalk(walkModel('F', {
      nodes: [
        wnode('F', 'dataset', 'focus_entity'),
        wnode('MID', 'dataset', 'gold_table', { childCount: 5 }),
      ],
      lineageEdges: [hop('F', 'MID')],
      downstreamUrns: new Set(['MID']),
    })))
    fireEvent.click(screen.getByLabelText('focus_entity — isolate the lineage running through it'))
    const chip = spotlightChip()
    expect(within(chip).getByText('1 known downstream flow — every one on this board (1 at table grain)')).toBeTruthy()
  })

  it('R1 rule 3 — a genuinely column-certain side never gains the clause', () => {
    // The mirror: MID declares nothing — a leaf — so the wire is
    // column-certain and the chip says only what it always said.
    renderLens(['F'], doneWalk(walkModel('F', {
      nodes: [
        wnode('F', 'dataset', 'focus_entity'),
        wnode('MID', 'dataset', 'plain_sink'),
      ],
      lineageEdges: [hop('F', 'MID')],
      downstreamUrns: new Set(['MID']),
    })))
    fireEvent.click(screen.getByLabelText('focus_entity — isolate the lineage running through it'))
    const chip = spotlightChip()
    expect(within(chip).getByText('1 known downstream flow — every one on this board')).toBeTruthy()
    expect(within(chip).queryByText(/at table grain/)).toBeNull()
  })
})

// ── THE TRAIL ────────────────────────────────────────────────────────

describe('THE TRAIL — cards the reader has explicitly walked through', () => {
  beforeEach(() => usePreferencesStore.setState({ lensViewMode: 'graph' }))
  afterEach(() => cleanup())

  const TRAIL_TITLE = "Part of the path you've walked"
  /** Whether the card drawn for `label` carries the mark. */
  const marked = (label: string) => {
    const card = screen.getAllByText(label).find(el => el.closest('.react-flow__node'))!.closest('.react-flow__node')!
    return card.querySelector(`[title="${TRAIL_TITLE}"]`) !== null
  }

  it('marks a card the reader focused earlier in this session, and not a stranger to it', () => {
    // U was the PRIOR focal (focus history); W was never visited.
    renderLens(['U', 'F'], doneWalk(walkModel('F', {
      nodes: [wnode('F', 'dataset', 'collaterals'), wnode('U', 'dataset', 'prior_stop'), wnode('W', 'dataset', 'never_visited')],
      lineageEdges: [hop('U', 'F'), hop('W', 'F')],
      upstreamUrns: new Set(['U', 'W']),
    })))
    expect(marked('prior_stop')).toBe(true)
    expect(marked('never_visited')).toBe(false)
    // The current focal is also somewhere the reader has explicitly
    // walked to — it is where they are standing.
    expect(marked('collaterals')).toBe(true)
  })

  it('marks a card an extend/page click grew the board from, even one that never became the focal', () => {
    const api = makeApi()
    renderLens(['F'], doneWalk(walkModel('F', {
      nodes: [wnode('F', 'dataset', 'focus_entity'), wnode('U', 'dataset', 'upstream_one')],
      lineageEdges: [hop('U', 'F')],
      upstreamUrns: new Set(['U']),
      frontierUp: [frontier('U', 6)],
    })), {}, api)
    expect(marked('upstream_one')).toBe(false)
    fireEvent.click(screen.getByTitle(/Loads the next hop upstream of upstream_one/))
    expect(marked('upstream_one')).toBe(true)
  })
})

// ── EVERYTHING INSIDE ────────────────────────────────────────────────

describe('what is really inside a container', () => {
  beforeEach(() => usePreferencesStore.setState({ lensViewMode: 'graph', lensFrameChildren: 'connected' }))
  afterEach(() => cleanup())

  // TWO columns on the lineage, so the table is the grain the answer is
  // presented at — a level with a single connected child is chrome the
  // walk sees through, and is never drawn as a box.
  const tableWithColumns = () => doneWalk(walkModel('F', {
    nodes: [
      wnode('F', 'dataset', 'stg_orders'),
      wnode('T', 'dataset', 'raw_orders', { childCount: 4 }),
      wnode('c1', 'schemaField', 'order_id'),
      wnode('c2', 'schemaField', 'placed_at'),
    ],
    containmentEdges: [holds('T', 'c1'), holds('T', 'c2')],
    lineageEdges: [hop('c1', 'F'), hop('c2', 'F')],
    upstreamUrns: new Set(['c1', 'c2']),
  }))

  it('flips a frame to everything inside, and asks the server for the roster', () => {
    const onLoadAllChildren = vi.fn()
    renderLens(['F'], tableWithColumns(), { onLoadAllChildren })
    fireEvent.click(screen.getByLabelText('Everything inside, lineage marked'))
    expect(onLoadAllChildren).toHaveBeenCalledWith('T')
  })

  it('shows an unconnected child as present, and claiming nothing', () => {
    const onLoadAllChildren = vi.fn()
    const { rerender, api } = renderLens(['F'], tableWithColumns(), { onLoadAllChildren })
    fireEvent.click(screen.getByLabelText('Everything inside, lineage marked'))

    rerender(
      <LineageLens
        history={{ entries: ['F'], cursor: 0 }}
        walk={tableWithColumns()}
        walkApi={api}
        childrenAll={new Map([['T', {
          children: [
            { id: 'c1', data: { label: 'order_id', type: 'schemaField' } },
            { id: 'c9', data: { label: 'internal_notes', type: 'schemaField' } },
          ],
          hasMore: false,
          total: 2,
        }]]) as never}
        childrenAllStatus={new Map([['T', 'done' as const]])}
        onLoadAllChildren={onLoadAllChildren}
        onRecenter={vi.fn()}
        onBack={vi.fn()}
        onForward={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('internal_notes')).toBeTruthy()
    // It lives in there, but it must never read as a connection.
    expect(screen.getByText('no lineage')).toBeTruthy()
  })

  it('a provider that cannot list contents says so, with no dead Retry (T24 F6)', () => {
    // Reported: 'unsupported' fell through to the SAME `fetch: null`
    // an entity that was never asked at all carries, so the frame just
    // sat there — wired, but dead: no spinner, no error, no retry.
    const onLoadAllChildren = vi.fn()
    const { rerender, api } = renderLens(['F'], tableWithColumns(), { onLoadAllChildren })
    fireEvent.click(screen.getByLabelText('Everything inside, lineage marked'))

    rerender(
      <LineageLens
        history={{ entries: ['F'], cursor: 0 }}
        walk={tableWithColumns()}
        walkApi={api}
        childrenAllStatus={new Map([['T', 'unsupported' as const]])}
        onLoadAllChildren={onLoadAllChildren}
        onRecenter={vi.fn()}
        onBack={vi.fn()}
        onForward={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText(/This source can't list contents here/)).toBeTruthy()
    // Not a transient failure — retrying could never satisfy it, so no
    // dead Retry is offered for it (unlike the genuine 'error' case).
    expect(screen.queryByText('Retry')).toBeNull()
  })

  it('confirms nothing more exists once "everything inside" turns up nothing new (T24 F6)', () => {
    // Reported: flipping Connected -> All and finding NOTHING beyond
    // what was already connected looks IDENTICAL to the toggle having
    // silently failed — the row list does not change either way.
    const onLoadAllChildren = vi.fn()
    const { rerender, api } = renderLens(['F'], tableWithColumns(), { onLoadAllChildren })
    fireEvent.click(screen.getByLabelText('Everything inside, lineage marked'))

    rerender(
      <LineageLens
        history={{ entries: ['F'], cursor: 0 }}
        walk={tableWithColumns()}
        walkApi={api}
        // The server's own roster is EXACTLY the two columns already
        // connected — nothing extra, and fully drained (no more pages).
        childrenAll={new Map([['T', {
          children: [
            { id: 'c1', data: { label: 'order_id', type: 'schemaField' } },
            { id: 'c2', data: { label: 'placed_at', type: 'schemaField' } },
          ],
          hasMore: false,
          total: 2,
        }]]) as never}
        childrenAllStatus={new Map([['T', 'done' as const]])}
        onLoadAllChildren={onLoadAllChildren}
        onRecenter={vi.fn()}
        onBack={vi.fn()}
        onForward={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText(/everything inside is already on this lineage/)).toBeTruthy()
  })

  it('says a roster is not an answer when nothing inside is on the lineage', () => {
    // The focus connects at TABLE grain — none of its own columns carries
    // this lineage. Opening "everything inside" then fills it with rows
    // that connect to nothing, and a list of columns inside a lineage
    // picture reads as the answer unless the node says it is not one.
    const onLoadAllChildren = vi.fn()
    const walk = doneWalk(walkModel('F', {
      nodes: [
        wnode('F', 'dataset', 'orders', { childCount: 2 }),
        wnode('U', 'dataset', 'raw_orders'),
      ],
      lineageEdges: [hop('U', 'F')],
      upstreamUrns: new Set(['U']),
    }))
    const { rerender, api } = renderLens(['F'], walk, { onLoadAllChildren })
    // Before the roster: the focus is open and says the answer is
    // nothing, rather than not being there at all. It needs no "Inside X"
    // label to say whose contents these are — since R7 they are ITS OWN
    // rows, inside the node that carries its name.
    expect(screen.getByText(/Nothing inside orders is on this lineage/)).toBeTruthy()
    expect(screen.queryByText('Inside')).toBeNull()
    expect(screen.getByText(/0 on this lineage · of 2/)).toBeTruthy()

    fireEvent.click(screen.getByLabelText('Everything inside, lineage marked'))
    expect(onLoadAllChildren).toHaveBeenCalledWith('F')

    rerender(
      <LineageLens
        history={{ entries: ['F'], cursor: 0 }}
        walk={walk}
        walkApi={api}
        childrenAll={new Map([['F', {
          children: [
            { id: 'k0', data: { label: 'order_total', type: 'schemaField' } },
            { id: 'k1', data: { label: 'placed_at', type: 'schemaField' } },
          ],
          hasMore: false,
          total: 2,
        }]]) as never}
        childrenAllStatus={new Map([['F', 'done' as const]])}
        onLoadAllChildren={onLoadAllChildren}
        onRecenter={vi.fn()}
        onBack={vi.fn()}
        onForward={vi.fn()}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('order_total')).toBeTruthy()
    expect(screen.getByText(/nothing here is on this lineage · showing everything inside/)).toBeTruthy()
  })

  /**
   * R7 — the focus is ONE node, in the same language as its partners.
   *
   * Reported (user screenshot, circled): a compact focal card floating
   * above a detached "Inside int_clean_products_t2" panel, while the
   * partners either side of it were each a single frame with rows in it.
   * The wires landed on the panel's rows, so the thing the whole picture
   * is about read as an orphan sitting above its own contents.
   */
  const focusWithColumns = () => doneWalk(walkModel('F', {
    nodes: [
      wnode('F', 'dataset', 'int_clean_products_t2', { childCount: 3 }),
      wnode('fc', 'schemaField', 'product_id'),
      wnode('T', 'dataset', 'raw_products', { childCount: 4 }),
      wnode('c1', 'schemaField', 'id'),
    ],
    containmentEdges: [holds('F', 'fc'), holds('T', 'c1')],
    lineageEdges: [hop('c1', 'fc')],
    upstreamUrns: new Set(['T', 'c1']),
  }))

  it('R7: the focus is one node with its contents as rows inside it', () => {
    renderLens(['F'], focusWithColumns())

    // Same node LANGUAGE as the partner frame beside it. T27 unified
    // 'focusFrame'/'focusCard' into one React Flow type ('focusCard' for
    // both — React Flow's own wrapper carries that class regardless of
    // kind now), so this is no longer a distinct class name to look for
    // there; the frame's own chrome (a pointer-events-none outer shell,
    // never an entity card's role="button") is the structural signature
    // that survives the unification. Found by `title` rather than
    // `getByText`: at 22 characters this name crosses
    // `MiddleTruncateName`'s split floor (Task 20, P6), so its text is
    // two adjacent spans — invisible to a plain text query, which only
    // reads an element's own direct text children. The title always
    // carries the whole name regardless of how it renders.
    const focal = document.querySelector('[title="int_clean_products_t2"]')!
      .closest('.pointer-events-none')
    expect(focal).not.toBeNull()
    expect(focal!.getAttribute('role')).not.toBe('button')

    // Its column is a ROW of it: an option of the focus's own list, not
    // a row of some panel underneath.
    const row = screen.getAllByText('product_id')
      .find(el => el.closest('[role="option"]'))!
      .closest('[role="option"]')!
    expect(document.getElementById('lens-rows-F')?.getAttribute('aria-owns'))
      .toContain(row.id)

    // And no second box speaking for the focus's contents.
    expect(screen.queryByText('Inside')).toBeNull()
    // The focus never offers to re-center on itself.
    expect(screen.queryByLabelText(/Focus on int_clean_products_t2 —/)).toBeNull()
    expect(screen.getByLabelText(/Focus on raw_products —/)).toBeTruthy()
  })

  /**
   * Task 20, P6 — reported: a frame named `INTERMEDIATE_T1` rendered
   * as `…TERMEDIATE_T1`, its identifying "IN" prefix silently gone.
   * `TailName`'s front-clip is right for a name that differs at the
   * END (`_t1` vs `_t2`, the case it was built for) but wrong for one
   * that differs at the START — this codebase's own naming has both.
   */
  it('a frame name past the middle-truncate floor keeps both identifying ends', () => {
    const longName = doneWalk(walkModel('F', {
      nodes: [
        wnode('F', 'dataset', 'focal_table'),
        wnode('LONG', 'dataset', 'INTERMEDIATE_T1', { childCount: 1 }),
        wnode('col', 'schemaField', 'a_column'),
      ],
      containmentEdges: [holds('LONG', 'col')],
      lineageEdges: [hop('col', 'F')],
      upstreamUrns: new Set(['LONG', 'col']),
    }))
    renderLens(['F'], longName)
    // Found by title, not getByText — see the R7 test just above for why.
    const el = document.querySelector('[title="INTERMEDIATE_T1"]')!
    // Two spans (a shrinkable head, a tail that never gives up room) —
    // the structural half of "middle, not front-only" that jsdom (no
    // real layout) can actually observe; the visual half is the
    // harness screenshot.
    expect(el.children.length).toBe(2)
    // Nothing lost either way: the reported defect was never about
    // missing TEXT, only about which END read as missing.
    expect(el.textContent).toBe('INTERMEDIATE_T1')
  })

  it('a short frame name is untouched by the split — one run, same as before this task', () => {
    renderLens(['F'], doneWalk(collateralsEstate()))
    const el = document.querySelector('[title="RISK_DB"]')!
    expect(el.querySelector('bdi')).toBeTruthy()
    expect(el.children.length).toBe(1) // the bdi alone, no head/tail spans
  })

  it('R7: the one node still carries the focal chrome — the orientation sentence, kind, contents', () => {
    renderLens(['F'], focusWithColumns())
    // The orientation sentence is the focus's macro number, and it stays
    // on the focus.
    expect(screen.getByText(/Fed by|No upstream sources/)).toBeTruthy()
    // What it is, and what is in it — both on the one node.
    expect(screen.getAllByText('dataset').length).toBeGreaterThan(0)
    expect(screen.getByText(/1 on this lineage · of 3/)).toBeTruthy()
  })

  /**
   * A wide table, its roster half-loaded: one server page of a hundred
   * children in hand, and more waiting. Ten render windows of ten fit
   * inside what is already loaded.
   */
  const wideTable = () => doneWalk(walkModel('F', {
    nodes: [
      wnode('F', 'dataset', 'stg_orders'),
      wnode('T', 'dataset', 'raw_orders', { childCount: 400 }),
      wnode('c1', 'schemaField', 'order_id'),
      wnode('c2', 'schemaField', 'placed_at'),
    ],
    containmentEdges: [holds('T', 'c1'), holds('T', 'c2')],
    lineageEdges: [hop('c1', 'F'), hop('c2', 'F')],
    upstreamUrns: new Set(['c1', 'c2']),
  }))

  const hundredLoaded = new Map([['T', {
    children: Array.from({ length: 100 }, (_, i) => ({
      id: `col_${i}`,
      data: { label: `col_${i}`, type: 'schemaField' },
    })),
    hasMore: true,
    total: null,
  }]]) as never

  type LoadRoster = Mock<(urn: string, searchQuery?: string) => void>

  /** Flip the frame to "everything inside" and hand it the loaded page,
   *  which is the state a scroll actually happens in. Returns a way to
   *  re-render with a different roster status — a fetch that is in
   *  flight is the state the scroll-end guard is about. */
  const openWideTable = (onLoadAllChildren: LoadRoster) => {
    const { rerender, api } = renderLens(['F'], wideTable(), { onLoadAllChildren })
    fireEvent.click(screen.getByLabelText('Everything inside, lineage marked'))
    const show = (status: 'loading' | 'done') => rerender(
      <LineageLens
        history={{ entries: ['F'], cursor: 0 }}
        walk={wideTable()}
        walkApi={api}
        childrenAll={hundredLoaded}
        childrenAllStatus={new Map([['T', status]])}
        onLoadAllChildren={onLoadAllChildren}
        onRecenter={vi.fn()}
        onBack={vi.fn()}
        onForward={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    show('done')
    // The flip itself asks for the roster; the scrolling is what these
    // tests are about.
    onLoadAllChildren.mockClear()
    return { show }
  }

  /** The frame's own list region — one tab stop, and the thing a wheel
   *  gesture and the arrow keys both act on.
   *
   *  Found by its label rather than by role: React Flow leaves an
   *  UNMEASURED node `visibility: hidden`, and jsdom measures nothing, so
   *  every card on the board is invisible to `getByRole`. The role is
   *  asserted here instead, which keeps the a11y contract pinned without
   *  depending on a layout jsdom will never do. */
  const rowsRegion = (label: string) => {
    const el = screen.getByLabelText(new RegExp(`^Rows inside ${label}\\.`))
    expect(el.getAttribute('role')).toBe('listbox')
    return el
  }

  /** Scroll a frame by `notches` mouse notches (100px each). */
  const wheelRows = (label: string, notches: number) => {
    const region = rowsRegion(label)
    for (let i = 0; i < notches; i++) fireEvent.wheel(region, { deltaY: 100 })
  }

  it('scrolls inside the loaded set without asking the server', () => {
    const onLoadAllChildren: LoadRoster = vi.fn()
    openWideTable(onLoadAllChildren)
    // Ten notches ≈ 38 rows of travel, all of them inside the hundred
    // children already in hand. One server page backs many rows of
    // scrolling — asking per row would spend a round trip on a list the
    // frame is already holding.
    wheelRows('raw_orders', 10)
    expect(screen.getByText(/39–48 of/)).toBeTruthy()
    expect(onLoadAllChildren).not.toHaveBeenCalled()
  })

  it('asks exactly once per page as the scroll nears the end of what is loaded', () => {
    const onLoadAllChildren: LoadRoster = vi.fn()
    const { show } = openWideTable(onLoadAllChildren)
    // Past row 82 the next window would run out of loaded rows, so the
    // page after it is fetched while there is still list to read.
    wheelRows('raw_orders', 22)
    expect(onLoadAllChildren).toHaveBeenCalledTimes(1)
    expect(onLoadAllChildren).toHaveBeenCalledWith('T', '')
    // A scroll crosses that line on several consecutive steps. While the
    // page it asked for is in flight, none of them asks again — one page
    // is one round trip, however long the gesture is.
    show('loading')
    wheelRows('raw_orders', 8)
    expect(onLoadAllChildren).toHaveBeenCalledTimes(1)
  })

  it('says the next page is on its way, where the reader is already looking', () => {
    // A shimmer ROW could not: the rows are React Flow siblings drawn
    // above the frame, and the page is fetched a windowful early — so it
    // sat under them, at a moment the window was never resting on. The
    // position readout beside the thumb is uncovered and always in view.
    const onLoadAllChildren: LoadRoster = vi.fn()
    const { show } = openWideTable(onLoadAllChildren)
    expect(screen.queryByText(/loading…/)).toBeNull()
    show('loading')
    expect(screen.getByText(/loading…/)).toBeTruthy()
    show('done')
    expect(screen.queryByText(/loading…/)).toBeNull()
  })

  it('empty space inside a frame still dismisses, like the board around it', () => {
    // The list region covers the frame body to catch a wheel and hold the
    // keyboard focus — which also put it in front of the pane, whose job
    // it is to drop what is open when you click away from it.
    renderLens(['F'], tableWithColumns())
    fireEvent.click(screen.getByText('order_id').closest('[role="option"]')!)
    expect(document.querySelector('[aria-label^="Preview of"]')).toBeTruthy()
    fireEvent.click(screen.getByLabelText(/^Rows inside raw_orders\./))
    expect(document.querySelector('[aria-label^="Preview of"]')).toBeNull()
  })

  it('the window never runs past the rows in hand, however hard it is spun', () => {
    const onLoadAllChildren: LoadRoster = vi.fn()
    openWideTable(onLoadAllChildren)
    wheelRows('raw_orders', 200)
    // 102 rows in hand (a hundred roster + the two connected columns) —
    // so the last window is 93–102 and no amount of spinning banks an
    // offset the frame would have to scroll back through.
    expect(screen.getByText(/93–102 of/)).toBeTruthy()
  })

  /**
   * R5.2 — a list that windows has to SAY so.
   *
   * Reported: a frame showing 8 of 14 rows announced it with a hairline
   * scrollbar and 9px of grey text in a corner, and the reader found the
   * scrolling by accident.
   */
  it('a windowing list offers a click that pages it, and says what that click delivers', () => {
    const onLoadAllChildren: LoadRoster = vi.fn()
    openWideTable(onLoadAllChildren)
    // Ten rows on screen, ninety-two more in hand: one click takes the
    // next windowful, and the control promises exactly that many.
    const next = screen.getByLabelText('Show next 10 rows')
    expect(next.tagName).toBe('BUTTON')
    // Nothing to go back to yet, so nothing offers to.
    expect(screen.queryByLabelText(/^Show previous/)).toBeNull()

    fireEvent.click(next)
    expect(screen.getByText(/11–20 of/)).toBeTruthy()
    expect(screen.getByLabelText('Show previous 10 rows')).toBeTruthy()
    // ...and paging the window costs no round trip, exactly as scrolling
    // it inside the loaded set does not.
    expect(onLoadAllChildren).not.toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText('Show previous 10 rows'))
    expect(screen.getByText(/1–10 of/)).toBeTruthy()
  })

  it('offers none of it where there is nothing hidden', () => {
    // Two connected columns, both on screen: no window, no chip, no step.
    renderLens(['F'], tableWithColumns())
    expect(screen.queryByLabelText(/^Show next/)).toBeNull()
    expect(screen.queryByLabelText(/^Show previous/)).toBeNull()
    expect(screen.queryByText(/1–2 of/)).toBeNull()
  })

  /**
   * A HEADER LISTENS ONLY TO ITSELF.
   *
   * A frame header is a place to point at the container — and for one
   * release it was also a `role="button"` with an Enter/Space handler on
   * it. Its controls stop a CLICK, but a keydown bubbles regardless, and
   * the ancestor's `preventDefault` suppressed the default action of
   * whatever was actually focused: a space could not be typed into Find,
   * and Enter on the chevron selected and isolated the frame instead of
   * opening it. These three are that class, from the reader's side.
   */
  it('a space typed into a frame\'s Find reaches the Find', async () => {
    const user = userEvent.setup()
    openWideTable(vi.fn())
    await user.click(screen.getByLabelText('Search inside raw_orders'))
    const find = screen.getByLabelText('Search inside raw_orders') as HTMLInputElement
    expect(find.tagName).toBe('INPUT')
    await user.type(find, 'a b')
    expect(find.value).toBe('a b')
  })

  it('Enter on the chevron shuts the frame — it does not isolate it', async () => {
    const user = userEvent.setup()
    renderLens(['F'], tableWithColumns())
    screen.getByLabelText('Collapse raw_orders').focus()
    await user.keyboard('{Enter}')
    // The key did the CONTROL's job — the frame is shut, and offers to
    // open again...
    expect(screen.getByLabelText('Show what\'s inside raw_orders')).toBeTruthy()
    expect(screen.queryByLabelText('Collapse raw_orders')).toBeNull()
    // ...and not the header's, which is what used to swallow it.
    expect(screen.queryByText(/its lineage within this walk/)).toBeNull()
  })

  it('Enter on the focus\'s own name isolates the lineage through it', async () => {
    const user = userEvent.setup()
    openWideTable(vi.fn())
    // The focus keeps a keyboard way in — a real button carrying its
    // name, rather than a header pretending to be one.
    const hit = screen.getByLabelText('stg_orders — isolate the lineage running through it')
    expect(hit.tagName).toBe('BUTTON')
    hit.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByText(/its lineage within this walk/)).toBeTruthy()
    expect(screen.getByText('stg_orders', { selector: 'bdi' })).toBeTruthy()
  })

  it('asks a focal that HOLDS things for its own roster, once', () => {
    const onLoadChildrenOf = vi.fn()
    renderLens(['T'], doneWalk(walkModel('T', {
      nodes: [
        wnode('T', 'dataset', 'raw_orders', { childCount: 400 }),
        wnode('c1', 'schemaField', 'order_id'),
        wnode('F', 'dataset', 'stg_orders'),
      ],
      containmentEdges: [holds('T', 'c1')],
      lineageEdges: [hop('c1', 'F')],
      downstreamUrns: new Set(['F']),
    })), { onLoadChildrenOf })
    expect(onLoadChildrenOf).toHaveBeenCalledWith('T')
    expect(onLoadChildrenOf).toHaveBeenCalledTimes(1)
  })

  it('does not ask on behalf of a focal that holds nothing', () => {
    // A column is the commonest thing this lens is opened on. Asking
    // what is inside one spent a round trip on every hop of every walk
    // to be told "nothing", every time.
    const onLoadChildrenOf = vi.fn()
    renderLens(['F'], tableWithColumns(), { onLoadChildrenOf })
    expect(onLoadChildrenOf).not.toHaveBeenCalled()
  })

  it('does not ask before the walk has landed — there is nothing to be inside yet', () => {
    const onLoadChildrenOf = vi.fn()
    renderLens(
      ['F'],
      { model: walkModel('F', {}), status: 'loading', error: null, extendStatus: new Map(), depth: 1 },
      { onLoadChildrenOf },
    )
    expect(onLoadChildrenOf).not.toHaveBeenCalled()
  })

  // ── F2 — FIND FILTERS AND FETCHES, IN BOTH MODES ─────────────────────

  /** Twelve connected columns — more than either window (Connected
   *  FRAME_WINDOW=8, All FRAME_WINDOW_ALL=10) — none of them a match for
   *  the queries below, so a hit can only be seen if the fix actually
   *  filters (or fetches) rather than merely dimming whatever the fixed
   *  window already had on screen. */
  const wideConnectedTable = () => doneWalk(walkModel('F', {
    nodes: [
      wnode('F', 'dataset', 'stg_orders'),
      wnode('T', 'dataset', 'raw_orders', { childCount: 400 }),
      ...Array.from({ length: 12 }, (_, i) => wnode(`c${i}`, 'schemaField', `column_${i}`)),
    ],
    containmentEdges: Array.from({ length: 12 }, (_, i) => holds('T', `c${i}`)),
    lineageEdges: Array.from({ length: 12 }, (_, i) => hop(`c${i}`, 'F')),
    upstreamUrns: new Set(Array.from({ length: 12 }, (_, i) => `c${i}`)),
  }))

  /** A row's name, not by its own exact text (an unconnected row's own
   *  title carries extra trailing words — "X — inside this, but no
   *  lineage…" — so an EXACT text/title match on the name alone can
   *  miss it) but by which option row CONTAINS it. */
  const rowNamed = (name: string) =>
    [...document.querySelectorAll('[role="option"]')].find(el => el.textContent?.includes(name))

  it('a match on a page the walk never fetched surfaces in Connected mode (T24 F2)', () => {
    vi.useFakeTimers()
    try {
      const onLoadAllChildren: LoadRoster = vi.fn()
      const walkSeed: LensWalkSeed = {
        // `opened: ['T']` — a seed REPLACES the view wholesale rather
        // than layering onto `initialLensViewState`'s own spine
        // auto-open, so a seed that leaves it out closes a frame that
        // would otherwise be open by default.
        nodeId: 'F', direction: 'both', revealed: [['in:F', 1]], opened: ['T'], collapsed: [],
        frameAll: [], framePages: [], frameQueries: [['T', 'ship']],
        pinned: [], condensedOpen: [],
      }
      const { rerender, api } = renderLens(['F'], wideConnectedTable(), { onLoadAllChildren, walkSeed })
      act(() => { vi.advanceTimersByTime(300) })
      // Connected mode used to never ask the server at all — the walk
      // model is all it consulted, and this entity is not in it.
      expect(onLoadAllChildren).toHaveBeenCalledWith('T', 'ship')

      // The server answers with an entity the walk never carried.
      rerender(
        <LineageLens
          history={{ entries: ['F'], cursor: 0 }}
          walk={wideConnectedTable()}
          walkApi={api}
          walkSeed={walkSeed}
          childrenAll={new Map([['T', {
            children: [{ id: 'shipping_zone', data: { label: 'shipping_zone', type: 'schemaField' } }],
            hasMore: false, total: 1, query: 'ship',
          }]]) as never}
          childrenAllStatus={new Map([['T', 'done' as const]])}
          onLoadAllChildren={onLoadAllChildren}
          onRecenter={vi.fn()}
          onBack={vi.fn()}
          onForward={vi.fn()}
          onClose={vi.fn()}
        />,
      )
      // A full citizen: it renders on the board, not merely in a count.
      expect(rowNamed('shipping_zone')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a server hit renders in All mode instead of being buried past the window (T24 F2)', () => {
    // Reported: server hits landed in rosterExtras AFTER the unfiltered
    // connected rows — twelve connected non-matches filled the ten-row
    // All-mode window before the one real hit ever got a turn.
    const walkSeed: LensWalkSeed = {
      nodeId: 'F', direction: 'both', revealed: [['in:F', 1]], opened: ['T'], collapsed: [],
      frameAll: ['T'], framePages: [], frameQueries: [['T', 'ship']],
      pinned: [], condensedOpen: [],
    }
    renderLens(['F'], wideConnectedTable(), {
      walkSeed,
      childrenAll: new Map([['T', {
        children: [
          ...Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, data: { label: `column_${i}`, type: 'schemaField' } })),
          { id: 'shipping_zone', data: { label: 'shipping_zone', type: 'schemaField' } },
        ],
        hasMore: false, total: 13, query: 'ship',
      }]]) as never,
      childrenAllStatus: new Map([['T', 'done' as const]]),
    })
    expect(rowNamed('shipping_zone')).toBeTruthy()
    // And the twelve non-matches are gone, not dimmed beside it — this
    // IS the filtering, not a lucky window position.
    expect(screen.queryByText('column_0')).toBeNull()
  })

  it('clearing the query restores the normal list (T24 F2)', () => {
    const walkSeed: LensWalkSeed = {
      nodeId: 'F', direction: 'both', revealed: [['in:F', 1]], opened: ['T'], collapsed: [],
      frameAll: [], framePages: [], frameQueries: [['T', 'zzz']],
      pinned: [], condensedOpen: [],
    }
    renderLens(['F'], wideConnectedTable(), { walkSeed })
    // Nothing among the twelve columns contains "zzz".
    expect(screen.queryByText('column_0')).toBeNull()
    fireEvent.change(screen.getByLabelText('Find inside raw_orders'), { target: { value: '' } })
    expect(screen.getByText('column_0')).toBeTruthy()
  })

  it('the match-count line never claims fewer searched than the server already returned (R1c)', () => {
    const walkSeed: LensWalkSeed = {
      nodeId: 'F', direction: 'both', revealed: [['in:F', 1]], opened: ['T'], collapsed: [],
      frameAll: [], framePages: [], frameQueries: [['T', 'ship']],
      pinned: [], condensedOpen: [],
    }
    renderLens(['F'], wideConnectedTable(), {
      walkSeed,
      childrenAll: new Map([['T', {
        children: [{ id: 'shipping_zone', data: { label: 'shipping_zone', type: 'schemaField' } }],
        hasMore: false,
        // A stale/wrong declared total SMALLER than what the server
        // already handed back — the honest floor is the returned count,
        // never this.
        total: 0,
        query: 'ship',
      }]]) as never,
      childrenAllStatus: new Map([['T', 'done' as const]]),
    })
    // Twelve connected (none matching) + the one server hit = 13
    // searched — never "0" (the stale declared total).
    expect(screen.getByText(/1 match · 13 searched/)).toBeTruthy()
  })
})

// ── THE WIRE, END TO END ─────────────────────────────────────────────

/** Mirrors what `normalizeTraceV2` does on the real provider before the
 *  adapter ever sees a response: Set-ify the direction urns. */
interface RawClosureDoc {
  nodes: GraphNode[]
  edges: GraphEdge[]
  containmentEdges: GraphEdge[]
  upstreamUrns: string[]
  downstreamUrns: string[]
  [k: string]: unknown
}
const toResponse = (doc: RawClosureDoc) => ({
  ...doc,
  upstreamUrns: new Set(doc.upstreamUrns),
  downstreamUrns: new Set(doc.downstreamUrns),
}) as unknown as TraceV2Result & LensClosureExtras

// ── BROWSING WHAT IS INSIDE: PEEK AND KEYBOARD ───────────────────────

/**
 * One click on a row now has ONE meaning — show me this — and the panel
 * that answers is not sitting in the way of the ⊕ beside it, which is
 * what the retired hover toolbar was.
 *
 * The frame's rows are React Flow siblings of their frame, so the list is
 * addressed here the way it is addressed by assistive tech: one labelled
 * region that OWNS its rows and names the cursor with
 * `aria-activedescendant`. Queried by label rather than by role — React
 * Flow leaves an unmeasured node `visibility: hidden` and jsdom measures
 * nothing, so the board is invisible to `getByRole`.
 */
describe('browsing what is inside — the peek and the keyboard', () => {
  beforeEach(() => usePreferencesStore.setState({ lensViewMode: 'graph' }))
  afterEach(() => cleanup())

  /** A table of four columns, two of them on this lineage — the shape a
   *  reader opens a frame to browse. */
  const table = () => doneWalk(walkModel('F', {
    nodes: [
      wnode('F', 'dataset', 'stg_orders'),
      wnode('T', 'dataset', 'raw_orders', { childCount: 4 }),
      wnode('c1', 'schemaField', 'order_id', {
        description: 'Natural key from the source system',
        lastSyncedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
      }),
      wnode('c2', 'schemaField', 'placed_at'),
    ],
    containmentEdges: [holds('T', 'c1'), holds('T', 'c2')],
    lineageEdges: [hop('c1', 'F'), hop('c2', 'F')],
    upstreamUrns: new Set(['c1', 'c2']),
    frontierUp: [frontier('c1', 9)],
  }))

  /** The same table with more columns than one window holds — the only
   *  shape that offers a Find box at all. */
  const manyColumns = () => {
    const nodes = [wnode('F', 'dataset', 'stg_orders'), wnode('T', 'dataset', 'raw_orders', { childCount: 40 })]
    const containmentEdges: ReturnType<typeof holds>[] = []
    const lineageEdges: ReturnType<typeof hop>[] = []
    for (let i = 0; i < 14; i++) {
      nodes.push(wnode(`k${i}`, 'schemaField', `column_${i}`))
      containmentEdges.push(holds('T', `k${i}`))
      lineageEdges.push(hop(`k${i}`, 'F'))
    }
    return doneWalk(walkModel('F', {
      nodes, containmentEdges, lineageEdges,
      upstreamUrns: new Set(nodes.slice(2).map(n => n.urn)),
    }))
  }

  const rowsRegion = () => screen.getByLabelText(/^Rows inside raw_orders\./)
  const row = (label: string) => screen.getByText(label).closest('[role="option"]')!
  const peek = () => screen.queryByRole('dialog', { name: /^Preview of/ })
    ?? document.querySelector('[aria-label^="Preview of"]')

  it('a click on a row opens a peek that states what the row IS', () => {
    renderLens(['F'], table())
    expect(peek()).toBeNull()
    fireEvent.click(row('order_id'))
    const panel = peek()!
    expect(panel).toBeTruthy()
    expect(panel.getAttribute('aria-label')).toBe('Preview of order_id')
    // Identity, where it lives, what it says about itself.
    expect(within(panel as HTMLElement).getByText('schemaField')).toBeTruthy()
    // WHERE IT LIVES, and a way to GO there: each crumb is its own
    // control now, so a reader looking at a column can make its table
    // the subject of the lens without hunting for the table's own card.
    expect(within(panel as HTMLElement).getByTitle(/Focus on raw_orders —/)).toBeTruthy()
    expect(within(panel as HTMLElement).getByText(/Natural key from the source system/)).toBeTruthy()
    // WHAT IT IS CONNECTED TO — what the wires on this card stand for,
    // PLUS whatever the data source says is still unfetched. Both halves
    // were reported wrong: a table whose columns carry its lineage read
    // "0 in · 0 out" beside its own wires, and a column with unfetched
    // upstream read "0 in" until the reader clicked to go and get it
    // ("we should really know about it upfront").
    const counts = within(panel as HTMLElement)
    expect(counts.getByTitle(/0 on this board, 9 not fetched yet/)).toBeTruthy()
    expect(counts.getByTitle('1 on this board')).toBeTruthy()
    expect(counts.getByText(/1 of them drawn so far/)).toBeTruthy()
    expect(within(panel as HTMLElement).getByText(/9 more upstream connections not fetched yet/)).toBeTruthy()
    expect(within(panel as HTMLElement).getByText(/Last synced 3h ago/)).toBeTruthy()
  })

  it('the peek walks from the row it is about, with the row as the seed', () => {
    const api = makeApi()
    renderLens(['F'], table(), {}, api)
    fireEvent.click(row('order_id'))
    fireEvent.click(within(peek() as HTMLElement).getByText(/Walk further upstream/))
    // Card-anchored, seeded by what is underneath it — the same contract
    // the ⊕ on the row itself obeys.
    expect(api.extend).toHaveBeenCalledWith('c1', 'up', ['c1'])
    // And it gets out of the way once it has done its job.
    expect(peek()).toBeNull()
  })

  // The peek's own follow button is a follow control like any other: it
  // dispatches the pill it is showing, through the same `actOnPill` the
  // gutter pill uses. (It used to run a `resolveFollowDelivery` gate in
  // front of that, which decided whether a big cohort opened the
  // hub-triage list instead — the list is gone, so a click on a big
  // cohort now reveals it in place like every other click.)
  it('the peek\'s own follow button dispatches the pill it is showing', () => {
    const nodes = [
      wnode('F', 'dataset', 'stg_orders'),
      wnode('T', 'dataset', 'raw_orders', { childCount: 1 }),
      wnode('c1', 'schemaField', 'order_id'),
      ...Array.from({ length: 40 }, (_, i) => wnode(`s${String(i).padStart(3, '0')}`, 'dataset', `source_${String(i).padStart(3, '0')}`)),
    ]
    const lineageEdges = [
      hop('c1', 'F'),
      ...Array.from({ length: 40 }, (_, i) => hop(`s${String(i).padStart(3, '0')}`, 'c1')),
    ]
    renderLens(['F'], doneWalk(walkModel('F', {
      nodes,
      containmentEdges: [holds('T', 'c1')],
      lineageEdges,
      upstreamUrns: new Set(['c1', ...Array.from({ length: 40 }, (_, i) => `s${String(i).padStart(3, '0')}`)]),
    })))
    fireEvent.click(row('order_id'))
    fireEvent.click(within(peek() as HTMLElement).getByText(/Walk further upstream/))
    // ONE CLICK, ONE VISIBLE DELIVERY: the cohort lands on the board.
    expect(onBoard('source_000')).toBe(true)
  })

  // FOCUS THE PARENT, FROM A ROW (user, 2026-08-17: "shouldn't I be
  // offered an ability to switch the focus not just only on the column
  // but also the entire parent entity?"). A CARD could always be
  // double-clicked or focused from its own header; a ROW could not —
  // and the peek was already naming its parents in words it would not
  // let anyone act on.
  it('the peek\'s breadcrumb focuses the PARENT, not the row', () => {
    const onRecenter = vi.fn()
    renderLens(['F'], table(), { onRecenter })
    fireEvent.click(row('order_id'))
    fireEvent.click(within(peek() as HTMLElement).getByTitle(/Focus on raw_orders —/))
    expect(onRecenter).toHaveBeenCalledWith('T')
  })

  it('the peek focuses where it is, and opens what it holds', () => {
    const onRecenter = vi.fn()
    renderLens(['F'], table(), { onRecenter })
    fireEvent.click(row('order_id'))
    // A leaf holds nothing, so it is never offered an "open inside" that
    // would do nothing.
    expect(within(peek() as HTMLElement).queryByText(/what is inside/)).toBeNull()
    fireEvent.click(within(peek() as HTMLElement).getByText('Focus here'))
    expect(onRecenter).toHaveBeenCalledWith('c1')
  })

  it('Escape peels ONE layer at a time — peek, isolation, then the lens', () => {
    const onClose = vi.fn()
    renderLens(['F'], table(), { onClose })
    // One click on a row does two things: it previews the row, and it
    // isolates what runs through it.
    fireEvent.click(row('order_id'))
    expect(peek()).toBeTruthy()
    expect(screen.getByText(/its lineage within this walk/)).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(peek()).toBeNull()
    // ...and the isolation is still there, because it was opened first.
    expect(screen.getByText(/its lineage within this walk/)).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByText(/its lineage within this walk/)).toBeNull()
    expect(onClose).not.toHaveBeenCalled()

    // With nothing left to dismiss, Escape means what it always meant.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  // ── LEAVING THE ROOM (user, 2026-08-17) ──────────────────────────
  //
  // "if I click anywhere within a window of Focus Lens it has a tendency
  // to close randomly" — the board's own background fell through the
  // dismiss ladder to `onClose()`, and the empty board is the largest
  // target in the room. It now peels a layer and stops, and the ways
  // OUT ask first once there is a walk to lose.

  it('a click on the board background NEVER closes the lens — it peels a layer and stops', () => {
    const onClose = vi.fn()
    renderLens(['F'], table(), { onClose })
    const pane = () => document.querySelector('.react-flow__pane')!
    fireEvent.click(row('order_id'))
    expect(peek()).toBeTruthy()

    fireEvent.click(pane())          // peels the peek
    expect(peek()).toBeNull()
    fireEvent.click(pane())          // peels the isolation
    fireEvent.click(pane())          // ...and now there is nothing left
    fireEvent.click(pane())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('a fresh lens with nothing walked closes straight away — no question worth asking', () => {
    const onClose = vi.fn()
    renderLens(['F'], table(), { onClose })
    fireEvent.click(document.querySelector('.react-flow__pane')!)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('once a walk exists the backdrop ASKS, and only the answer closes it', () => {
    const onClose = vi.fn()
    renderLens(['F', 'B'], table(), { onClose })   // two history entries = walked
    fireEvent.click(document.querySelector('.absolute.inset-0.bg-black\\/50')!)
    const ask = screen.getByRole('alertdialog')
    expect(ask).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()

    // "Keep exploring" puts the reader back where they were.
    fireEvent.click(within(ask).getByText('Keep exploring'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()

    // ...and the other answer is the one that leaves.
    fireEvent.click(document.querySelector('.absolute.inset-0.bg-black\\/50')!)
    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Close the lens'))
    expect(onClose).toHaveBeenCalled()
  })

  it('Escape backs out of the QUESTION rather than answering it', () => {
    const onClose = vi.fn()
    renderLens(['F', 'B'], table(), { onClose })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('alertdialog')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('the row list is one tab stop that owns its rows and names the cursor', () => {
    renderLens(['F'], table())
    const region = rowsRegion()
    expect(region.getAttribute('role')).toBe('listbox')
    expect(region.getAttribute('tabindex')).toBe('0')
    // Owned rather than contained: React Flow renders the rows as the
    // frame's SIBLINGS, so the relationship has to be stated.
    const owned = (region.getAttribute('aria-owns') ?? '').split(' ')
    expect(owned).toHaveLength(2)
    for (const id of owned) expect(document.getElementById(id)).toBeTruthy()
    expect(region.getAttribute('aria-activedescendant')).toBeNull()

    fireEvent.focus(region)
    expect(region.getAttribute('aria-activedescendant')).toBe(owned[0])
    expect(row('order_id').getAttribute('id')).toBe(owned[0])
  })

  it('up and down walk the rows, and stop at the ends', () => {
    renderLens(['F'], table())
    const region = rowsRegion()
    fireEvent.focus(region)
    const first = region.getAttribute('aria-activedescendant')
    fireEvent.keyDown(region, { key: 'ArrowDown' })
    const second = region.getAttribute('aria-activedescendant')
    expect(second).not.toBe(first)
    expect(row('placed_at').getAttribute('id')).toBe(second)
    // The last row is the last row — no wrap, so a held key never
    // silently teleports the reader back to the top.
    fireEvent.keyDown(region, { key: 'ArrowDown' })
    expect(region.getAttribute('aria-activedescendant')).toBe(second)
    fireEvent.keyDown(region, { key: 'ArrowUp' })
    fireEvent.keyDown(region, { key: 'ArrowUp' })
    expect(region.getAttribute('aria-activedescendant')).toBe(first)
  })

  it('Enter previews, Shift+Enter walks there, left arrow steps back out', () => {
    const onRecenter = vi.fn()
    const onBack = vi.fn()
    renderLens(['F', 'G'], table(), { onRecenter, onBack, history: { entries: ['F', 'G'], cursor: 1 } })
    const region = rowsRegion()
    fireEvent.focus(region)
    fireEvent.keyDown(region, { key: 'Enter' })
    expect(peek()).toBeTruthy()
    fireEvent.keyDown(region, { key: 'ArrowLeft', bubbles: true })
    expect(peek()).toBeNull()
    expect(region.getAttribute('aria-activedescendant')).toBeNull()
    // And it did NOT step the lens back a hop: inside a row list the
    // arrows belong to the list.
    expect(onBack).not.toHaveBeenCalled()

    fireEvent.focus(region)
    fireEvent.keyDown(region, { key: 'Enter', shiftKey: true })
    expect(onRecenter).toHaveBeenCalledWith('c1')
  })

  it('leaving the list takes its cursor with it', () => {
    renderLens(['F'], table())
    const region = rowsRegion()
    fireEvent.focus(region)
    expect(region.getAttribute('aria-activedescendant')).toBeTruthy()
    fireEvent.blur(region)
    expect(region.getAttribute('aria-activedescendant')).toBeNull()
  })

  it('typing jumps to the next name that matches, without touching the mouse', () => {
    renderLens(['F'], table())
    const region = rowsRegion()
    fireEvent.focus(region)
    fireEvent.keyDown(region, { key: 'p' })
    expect(region.getAttribute('aria-activedescendant')).toBe(row('placed_at').getAttribute('id'))
    // Consecutive letters compose one search rather than restarting it.
    fireEvent.keyDown(region, { key: 'l' })
    expect(region.getAttribute('aria-activedescendant')).toBe(row('placed_at').getAttribute('id'))
  })

  it('a name no loaded row has hands the letters to the frame\'s own Find', () => {
    // Client-side over the rows in hand; a miss is exactly the case the
    // SERVER search exists for, so the typing becomes the query rather
    // than being swallowed — but only on a frame that offers a Find box,
    // or the letters would filter every row against a query with nowhere
    // to be seen or cleared.
    renderLens(['F'], manyColumns())
    const region = screen.getByLabelText(/^Rows inside raw_orders\./)
    fireEvent.focus(region)
    fireEvent.keyDown(region, { key: 'z' })
    expect((screen.getByLabelText('Find inside raw_orders') as HTMLInputElement).value).toBe('z')
  })

  it('a short list swallows a miss rather than filtering itself to nothing', () => {
    renderLens(['F'], table())
    const region = rowsRegion()
    fireEvent.focus(region)
    fireEvent.keyDown(region, { key: 'z' })
    // Both rows still readable, and no Find box was conjured to explain
    // a query the reader never typed into one.
    expect(screen.getByText('order_id')).toBeTruthy()
    expect(screen.getByText('placed_at')).toBeTruthy()
  })

  it('right arrow opens a row that holds things, and is inert on one that does not', () => {
    // `T` is a table of columns: the columns hold nothing, so the key
    // that opens has nothing to open and says so by doing nothing.
    renderLens(['F'], table())
    const region = rowsRegion()
    fireEvent.focus(region)
    fireEvent.keyDown(region, { key: 'ArrowRight' })
    expect(screen.getByText('order_id')).toBeTruthy()
    expect(peek()).toBeNull()
  })
})

describe('the real wire shape reaches the board', () => {
  beforeEach(() => usePreferencesStore.setState({ lensViewMode: 'graph' }))
  afterEach(() => cleanup())

  it('renders a merged two-response walk built from the shared backend fixture', () => {
    const raw = JSON.parse(readFileSync(
      resolve(__dirname, '../../../../../../backend/tests/fixtures/trace_closure_walk_fixture.json'),
      'utf-8',
    )) as { initial: RawClosureDoc; extension: RawClosureDoc }
    const focus = 'urn:li:table:t_orders'

    // Exactly what `useLensWalk` holds after an open plus one ⊕ extend.
    const merged = mergeClosures(
      toLensClosure(toResponse(raw.initial), focus),
      toResponse(raw.extension),
      { rootUrn: 'urn:li:table:t_raw', direction: 'up' },
    )
    renderLens([focus], doneWalk(merged))

    // The focus, an estate only the INITIAL response named, and one
    // only the EXTENSION named, all on one board — proof the board
    // draws the union rather than the last response.
    expect(screen.getByRole('dialog')).toBeTruthy()
    const board = screen.getByRole('dialog').textContent ?? ''
    expect(board).toContain('Orders')       // the focus
    expect(board).toContain('Raw Orders')   // initial only
    expect(board).toContain('Vendor')       // extension only
  })
})

// ── SCHEMA WORDING ───────────────────────────────────────────────────

describe('relationship wording comes from the ontology', () => {
  afterEach(() => {
    cleanup()
    useSchemaStore.setState({ schema: null } as never)
  })

  it('prints the schema\'s own display name for a relationship, not the raw id', () => {
    useSchemaStore.setState({
      schema: {
        entityTypes: [],
        relationshipTypes: [{ id: 'DERIVES_FROM', name: 'Derives from', description: 'Computed from' }],
      },
    } as never)
    usePreferencesStore.setState({ lensViewMode: 'list' })
    renderLens(['F'], doneWalk(walkModel('F', {
      nodes: [wnode('F'), wnode('u', 'dataset', 'upstream_table')],
      lineageEdges: [hop('u', 'F')],
      upstreamUrns: new Set(['u']),
    })))
    expect(screen.getByText('Derives from')).toBeTruthy()
  })
})

// ── the hook count never depends on what is on the board ─────────────
//
// REPORTED LIVE (P0): the lens error boundary showing "This view
// encountered an error — Rendered more hooks than during the previous
// render." React throws that when a component calls a different NUMBER
// of hooks than it did last time, and the shape here is the classic one:
// `LineageLens` returns early when it has no focal, so any hook written
// below that return exists only on the renders that have one.
//
// These tests drive the transition in both directions. They are about
// the component's hook DISCIPLINE rather than about anything it draws,
// which is why they assert on the absence of a throw and on the focal
// still being there afterwards.

describe('the lens survives gaining and losing its focal', () => {
  const estate = () => doneWalk(walkModel('F', {
    nodes: [wnode('F', 'dataset', 'orders_enriched'), wnode('u', 'dataset', 'upstream_table')],
    lineageEdges: [hop('u', 'F')],
    upstreamUrns: new Set(['u']),
  }))

  const lens = (entries: string[], cursor: number, walk: WalkEntry | null) => (
    <LineageLens
      history={{ entries, cursor }}
      walk={walk}
      walkApi={makeApi()}
      onRecenter={vi.fn()}
      onBack={vi.fn()}
      onForward={vi.fn()}
      onClose={vi.fn()}
    />
  )

  it('renders when a focal ARRIVES after a render without one', () => {
    // No focal: `lensFocalOf` is null and the component returns early.
    const { rerender } = render(lens([], -1, null))
    // ...and then the walk lands on one. This threw before every hook
    // sat above that early return.
    expect(() => rerender(lens(['F'], 0, estate()))).not.toThrow()
    expect(screen.getAllByText('orders_enriched').length).toBeGreaterThan(0)
  })

  it('renders when the focal GOES AWAY again', () => {
    const { rerender } = render(lens(['F'], 0, estate()))
    expect(() => rerender(lens([], -1, null))).not.toThrow()
    // And once more, so the count has to match a third time.
    expect(() => rerender(lens(['F'], 0, estate()))).not.toThrow()
  })

  it('renders through a merge that changes what every card IS', () => {
    // A walk growing flips card kinds under React Flow: a plain upstream
    // card becomes a FRAME when its first column arrives, and that column
    // becomes a ROW inside it. Same board, same node ids, different
    // branches through the card components.
    const { rerender } = render(lens(['F'], 0, estate()))
    const grown = doneWalk(walkModel('F', {
      nodes: [
        wnode('F', 'dataset', 'orders_enriched'),
        wnode('u', 'dataset', 'upstream_table', { childCount: 4 }),
        wnode('u:col', 'schemaField', 'order_id'),
      ],
      containmentEdges: [holds('u', 'u:col')],
      lineageEdges: [hop('u', 'F'), hop('u:col', 'F')],
      upstreamUrns: new Set(['u', 'u:col']),
    }))
    expect(() => rerender(lens(['F'], 0, grown))).not.toThrow()
    expect(screen.getAllByText('order_id').length).toBeGreaterThan(0)
  })
})

// T25 C2 (2/2) — THE DETERMINISTIC RACE, retired with its cause. A
// re-anchor while a fetch was still in flight used to be able to fire
// that fetch's ARRIVAL DECISION (reveal the page, or open the hub-triage
// list) against the NEW focal's card ids, which is why `pendingTriage`
// was nodeId-scoped. The triage list is gone and with it the deferred
// decision: an extend now claims its page at CLICK time, against the
// focal it was clicked on, and `useLensWalk`'s own session guard drops a
// response that outlives its focal. Nothing is left here to race.

// 2026-08-19 — "focal ⊃ 10 nodes ⊃ 100 each shows only the 1st". The
// Contents=All seed puts the FOCAL in frameShowAll with NO click, and the
// roster effect deliberately skipped the first fetch for showAll members
// (assuming the toggle handler had fired it) — so the focal's roster was
// never fetched and only the flow-carrying child drew. The effect must
// fetch a missing first page itself whenever nothing is in flight.
describe('Contents=All focal seed — the roster actually FETCHES', () => {
  beforeEach(() => usePreferencesStore.setState({ lensViewMode: 'graph', lensFrameChildren: 'all' }))
  afterEach(() => usePreferencesStore.setState({ lensFrameChildren: 'connected' }))

  it('a focal seeded into All mode requests its full roster without any click', async () => {
    const onLoadAllChildren = vi.fn()
    renderLens(['F'], doneWalk(collateralsEstate()), { onLoadAllChildren })
    await vi.waitFor(() => expect(onLoadAllChildren).toHaveBeenCalledWith('F'), { timeout: 1500 })
  })

  it('but never re-fires while that first fetch is already in flight', async () => {
    const onLoadAllChildren = vi.fn()
    renderLens(['F'], doneWalk(collateralsEstate()), {
      onLoadAllChildren,
      childrenAllStatus: new Map([['F', 'loading']]),
    })
    await new Promise(r => setTimeout(r, 500))
    expect(onLoadAllChildren).not.toHaveBeenCalled()
  })

  // 2026-08-19, the 673-request storm: a FAILED first fetch leaves the
  // page missing with status 'error' — refiring on "missing" turns one
  // backend failure into an endless children-with-edges loop (the
  // poll-chain-leak class). A failure is an answer: never auto-retry.
  it.each(['error', 'unsupported'] as const)('and never auto-retries after %s — a failure is an answer', async (status) => {
    const onLoadAllChildren = vi.fn()
    renderLens(['F'], doneWalk(collateralsEstate()), {
      onLoadAllChildren,
      childrenAllStatus: new Map([['F', status]]),
    })
    await new Promise(r => setTimeout(r, 500))
    expect(onLoadAllChildren).not.toHaveBeenCalled()
  })
})
