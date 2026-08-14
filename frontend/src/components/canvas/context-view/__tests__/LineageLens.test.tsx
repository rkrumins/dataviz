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
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { LineageLens, type LensWalkSeed } from '../LineageLens'
import { usePreferencesStore } from '@/store/preferences'
import { useSchemaStore } from '@/store/schema'
import { decodeLensShare } from '../lens/shareCodec'
import type { WalkEntry } from '@/hooks/useLensWalk'
import {
  toLensClosure,
  mergeClosures,
  type LensWalkModel,
  type LensWalkNode,
} from '../lens/closure-adapter'
import type { LensFrontierEntry } from '../lens/lens-subgraph'
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

const doneWalk = (model: LensWalkModel, extendStatus?: Map<string, 'loading' | 'error'>): WalkEntry => ({
  model, status: 'done', error: null, extendStatus: extendStatus ?? new Map(),
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
    fireEvent.click(screen.getByTitle(/Walk one hop further upstream of loan_positions \(6 more connections\)/))
    expect(api.extend).toHaveBeenCalledWith('t0', 'up', ['t0'])
  })

  it('double-clicking a card re-centers the walk there', () => {
    const onRecenter = vi.fn()
    renderLens(['F'], doneWalk(collateralsEstate()), { onRecenter })
    fireEvent.doubleClick(screen.getByText('loan_positions'))
    expect(onRecenter).toHaveBeenCalledWith('t0')
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
    fireEvent.click(screen.getByTitle(/Show 2 more upstream connections — already loaded, nothing to fetch/))
    expect(onBoard('source_12')).toBe(true)
    expect(onBoard('source_13')).toBe(true)
    expect(api.extend).not.toHaveBeenCalled()
    expect(api.page).not.toHaveBeenCalled()
  })

  it('a page carries the server\'s own cursor back verbatim', () => {
    const { api } = renderLens(['F'], doneWalk(pillCatalogue()))
    fireEvent.click(screen.getByTitle(/Load the rest of what is upstream of partially_loaded/))
    expect(api.page).toHaveBeenCalledWith('PAGED', 'up', 'eyJvZmZzZXQiOjMwfQ==')
    expect(api.extend).not.toHaveBeenCalled()
  })

  it('an exact remainder is stated; an unknown one is never invented', () => {
    renderLens(['F'], doneWalk(pillCatalogue()))
    const exact = screen.getByTitle(/Walk one hop further upstream of has_48_more \(48 more connections\)/)
    expect(exact.textContent).toContain('48')
    // The server did not report a total. A countless chevron, not a
    // fabricated number.
    const countless = screen.getByTitle('Walk one hop further upstream of count_unknown')
    expect(countless.textContent?.trim()).toBe('')
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
  const extendChain = (withConsumer: boolean) => doneWalk(walkModel('F', {
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
    // The server says 246 more connections hang off GOLD downstream.
    frontierDown: [{ urn: 'GOLD', totalCount: 246, nextCursor: null }],
  }))

  it('ONE click on an extend ⊕ delivers a VISIBLE cohort — no second click', () => {
    const api = makeApi()
    const { rerender } = renderLens(['F'], extendChain(false), {}, api)
    expect(onBoard('mart_tickets_daily')).toBe(false)

    fireEvent.click(screen.getByTitle(/Walk one hop further downstream of GOLD/))
    expect(api.extend).toHaveBeenCalledTimes(1)
    expect(api.extend).toHaveBeenCalledWith('GOLD', 'down', ['GOLD'])

    // The merged response lands, exactly as `useLensWalk` would hand it over.
    rerender(
      <LineageLens
        history={{ entries: ['F'], cursor: 0 }}
        walk={extendChain(true)}
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
    // one of the 246 connections is now drawn, so 245 remain. It does not
    // flip to a card count and read as changing its mind.
    expect(screen.getByTitle(/Walk one hop further downstream of GOLD \(245 more connections\)/)).toBeTruthy()
  })

  it('the ⊕ badge counts CONNECTIONS in every state — one pill, one unit', () => {
    // The defect's other half: "+246" (unfetched connections) became "+1"
    // (groups in hand) in the same place on the same card, so the number
    // appeared to change its mind about the size of what was out there.
    // Every state now counts the thing the rest of the board counts — the
    // band headers, the card ×N, the focal's in/out are all connections.
    renderLens(['F'], extendChain(false))
    // 247 the server knows about, one already drawn.
    const extend = screen.getByTitle(/Walk one hop further downstream of GOLD \(246 more connections\)/)
    expect(extend.textContent).toContain('246')

    cleanup()
    // A reveal: fourteen sources, twelve drawn, two waiting — and those two
    // carry one connection each, which is what the badge says.
    renderLens(['F'], doneWalk(crowdedFanIn()))
    const reveal = screen.getByTitle(/Show 2 more upstream connections — already loaded, nothing to fetch/)
    expect(reveal.textContent).toContain('2')

    cleanup()
    renderLens(['F'], doneWalk(pillCatalogue()))
    expect(screen.getByTitle(/Load the rest of what is upstream of partially_loaded \(96 more connections\)/)).toBeTruthy()
  })

  it('offers no ⊕ at all until the focal\'s own model has landed', () => {
    // `useLensWalk` holds an EMPTY model until the first response, and
    // ignores an extend before the focal is 'done' — so there is
    // nothing to hang a pill on, and no dead click to make.
    renderLens(['F'], { model: walkModel('F', {}), status: 'loading', error: null, extendStatus: new Map() })
    expect(screen.queryByTitle(/Walk one hop further/)).toBeNull()
    expect(screen.queryByTitle(/Show .* more upstream/)).toBeNull()
  })
})

// ── STATUS SURFACES ──────────────────────────────────────────────────

describe('what the lens says while it cannot answer', () => {
  beforeEach(() => usePreferencesStore.setState({ lensViewMode: 'graph' }))
  afterEach(() => cleanup())

  it('narrates the walk instead of claiming "no connections"', () => {
    renderLens(['F'], { model: walkModel('F', {}), status: 'loading', error: null, extendStatus: new Map() })
    expect(screen.getByText(/Walking the lineage from the data source/)).toBeTruthy()
  })

  it('surfaces a failure with its reason, and a Retry that re-kicks the walk', () => {
    const { api } = renderLens(['F'], {
      model: walkModel('F', {}), status: 'error', error: 'provider unreachable', extendStatus: new Map(),
    })
    expect(screen.getByText(/provider unreachable/)).toBeTruthy()
    fireEvent.click(screen.getByText('Retry'))
    expect(api.retry).toHaveBeenCalledWith('F')
  })

  it('says plainly when the data source cannot walk lineage at all', () => {
    renderLens(['F'], { model: walkModel('F', {}), status: 'unsupported', error: null, extendStatus: new Map() })
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
    // NOT be marked as a floor just because the other side is.
    expect(screen.getByText(/Reach: 2\+ upstream · 1 downstream/)).toBeTruthy()
  })

  it('drops the floor mark once nothing is left to walk', () => {
    usePreferencesStore.setState({ lensViewMode: 'list' })
    renderLens(['F'], doneWalk(reachModel(false)))
    expect(screen.getByText(/Reach: 2 upstream · 1 downstream$/)).toBeTruthy()
  })

  it('claims no reach at all while the walk is still running', () => {
    usePreferencesStore.setState({ lensViewMode: 'list' })
    renderLens(['F'], { model: reachModel(true), status: 'loading', error: null, extendStatus: new Map() })
    expect(screen.queryByText(/Reach:/)).toBeNull()
    expect(screen.getByText(/Walking the lineage…/)).toBeTruthy()
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
    // clicked, which is what E deleted it for.
    expect(screen.getByText(/Reach: 2 upstream/)).toBeTruthy()
    expect(screen.getByText(/1 downstream/)).toBeTruthy()
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
    fireEvent.click(screen.getByTitle(/Opened containers show everything inside/))
    expect(usePreferencesStore.getState().lensFrameChildren).toBe('all')
    usePreferencesStore.setState({ lensFrameChildren: 'connected' })
  })

  it('offers the picture as an image without throwing', () => {
    usePreferencesStore.setState({ lensViewMode: 'graph' })
    renderLens(['b'], simple())
    const download = screen.getByTitle('Download this lineage as an image (for decks and docs)')
    expect(() => fireEvent.click(download)).not.toThrow()
  })

  it('offers the walk as JSON and CSV downloads, beside the image export', () => {
    usePreferencesStore.setState({ lensViewMode: 'graph' })
    renderLens(['b'], simple())
    expect(() => fireEvent.click(screen.getByLabelText('Export lineage data as JSON'))).not.toThrow()
    expect(() => fireEvent.click(screen.getByLabelText('Export lineage data as CSV'))).not.toThrow()
  })

  it('the initial-depth control is a preference, and touches no walk call', () => {
    usePreferencesStore.setState({ lensViewMode: 'graph', lensInitialDepth: 1 })
    const { api } = renderLens(['b'], simple())
    fireEvent.click(screen.getByTitle(/Fetch 2 hops each way/))
    expect(usePreferencesStore.getState().lensInitialDepth).toBe(2)
    // Changing it never touches the CURRENT focal's walk — only what a
    // future focus fetches.
    expect(api.extend).not.toHaveBeenCalled()
    expect(api.retry).not.toHaveBeenCalled()
    usePreferencesStore.setState({ lensInitialDepth: 1 })
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

  it('the share link encodes the exploration on screen as v2', () => {
    usePreferencesStore.setState({ lensViewMode: 'graph', lensInitialDepth: 2 })
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderLens(['F'], doneWalk(collateralsEstate()))
    fireEvent.click(screen.getByTitle('Show only what feeds this entity — upstream'))
    fireEvent.click(screen.getByLabelText('Copy exploration link'))

    expect(writeText).toHaveBeenCalledTimes(1)
    const url = new URL(writeText.mock.calls[0][0] as string)
    const decoded = decodeLensShare(url.searchParams.get('lens') ?? '')
    expect(decoded?.v).toBe(2)
    if (decoded?.v !== 2) throw new Error('expected a v2 token')
    expect(decoded.entries).toEqual(['F'])
    expect(decoded.mode).toBe('graph')
    expect(decoded.depth).toBe(2)
    expect(decoded.direction).toBe('in')
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
    // columns are rows of.
    const frame = document.querySelector('.react-flow__node-focusFrame')
    expect(frame?.className).toContain('draggable')
    // The column rides along as a child node, so dragging the table
    // moves the whole thing — a table never sheds a column.
    const child = screen.getByText('order_id').closest('.react-flow__node')
    expect(child).toBeTruthy()
    expect(child!.className).not.toContain('draggable')
  })

  it('reveals every neighbour on the canvas by urn, and closes on the way', () => {
    usePreferencesStore.setState({ lensViewMode: 'list' })
    const onLocateAll = vi.fn()
    const onClose = vi.fn()
    renderLens(['b'], simple(), { onLocateAll, onClose })
    fireEvent.click(screen.getByText('Reveal all on canvas'))
    expect(onClose).toHaveBeenCalled()
    expect(onLocateAll).toHaveBeenCalledWith(['a', 'c'])
  })
})

// ── PATH-TO-FOCUS HIGHLIGHT ──────────────────────────────────────────

describe('hovering or selecting a card highlights its path to the focus', () => {
  beforeEach(() => usePreferencesStore.setState({ lensViewMode: 'graph' }))
  afterEach(() => cleanup())

  const simple = () => doneWalk(walkModel('b', {
    nodes: [wnode('a', 'dataset', 'label-a'), wnode('b', 'dataset', 'label-b'), wnode('c', 'dataset', 'label-c')],
    lineageEdges: [hop('a', 'b'), hop('b', 'c')],
    upstreamUrns: new Set(['a']),
    downstreamUrns: new Set(['c']),
  }))
  // The card's OWN root (role="button") carries the dimmed opacity class;
  // `.react-flow__node` is React Flow's wrapper one level further out.
  // A SELECTED card's label is also echoed in the detail strip below the
  // board, so disambiguate by picking the match that lives on the board.
  const nodeFor = (label: string) => {
    const onCanvas = screen.getAllByText(label).find(el => el.closest('.react-flow__node'))!
    return onCanvas.closest('[role="button"]')!
  }

  /** The off-path floor a SELECTION quiets to. Deliberately not the old
   *  30%: a highlight that turns the rest of the board into grey ghosts
   *  costs the reader the context they were reading the path against. */
  const QUIET = 'opacity-60'
  /** What being ON the path looks like. */
  const LIT = 'ring-1 ring-accent-lineage/70'

  it('selecting a card quiets what is off its path — to a floor that is still readable', () => {
    renderLens(['b'], simple())
    fireEvent.click(screen.getByText('label-a'))
    // 'a' is one direct hop from the focus 'b' — 'c' is not on that path.
    expect(nodeFor('label-c').className).toContain(QUIET)
    expect(nodeFor('label-c').className).not.toContain('opacity-30')
    expect(nodeFor('label-a').className).not.toContain(QUIET)
  })

  it('deselecting (pane click) clears the highlight — nothing stays quieted', () => {
    renderLens(['b'], simple())
    fireEvent.click(screen.getByText('label-a'))
    expect(nodeFor('label-c').className).toContain(QUIET)
    fireEvent.click(document.querySelector('.react-flow__pane')!)
    expect(nodeFor('label-c').className).not.toContain(QUIET)
  })

  it('hovering (past the 150ms intent delay) LIGHTS the path and dims nothing, and clears on mouse leave', () => {
    vi.useFakeTimers()
    try {
      renderLens(['b'], simple())
      fireEvent.mouseEnter(nodeFor('label-a'))
      act(() => { vi.advanceTimersByTime(149) })
      expect(nodeFor('label-a').className).not.toContain(LIT)
      act(() => { vi.advanceTimersByTime(1) })
      // The path is stated by lighting it up...
      expect(nodeFor('label-a').className).toContain(LIT)
      // ...and a pointer sweeping the board never washes the board out.
      expect(nodeFor('label-c').className).not.toContain(QUIET)
      expect(nodeFor('label-c').className).not.toContain('opacity-30')
      fireEvent.mouseLeave(nodeFor('label-a'))
      expect(nodeFor('label-a').className).not.toContain(LIT)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a diamond highlights both branches', () => {
    // H is two hops from the focus, so it needs A's and B's own pages
    // revealed too — a seed is the simplest way to land it on the board
    // without a click standing in for the thing under test.
    const walkSeed: LensWalkSeed = {
      nodeId: 'F', direction: 'both',
      revealed: [['in:F', 1], ['out:F', 1], ['in:A', 1], ['in:B', 1]],
      opened: [], collapsed: [], frameAll: [], framePages: [], frameQueries: [],
    }
    renderLens(['F'], doneWalk(walkModel('F', {
      nodes: [wnode('H', 'dataset', 'hub'), wnode('A', 'dataset', 'branch_a'), wnode('B', 'dataset', 'branch_b'), wnode('F', 'dataset', 'the_focus')],
      lineageEdges: [hop('H', 'A'), hop('A', 'F'), hop('H', 'B'), hop('B', 'F')],
      upstreamUrns: new Set(['H', 'A', 'B']),
    })), { walkSeed })
    fireEvent.click(screen.getByText('hub'))
    expect(nodeFor('branch_a').className).not.toContain('opacity-30')
    expect(nodeFor('branch_b').className).not.toContain('opacity-30')
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

  it('says a roster is not an answer when nothing inside is on the lineage', () => {
    // The focus connects at TABLE grain — none of its own columns carries
    // this lineage. Opening "everything inside" then fills the stack with
    // rows that connect to nothing, and a list of columns under a lineage
    // picture reads as the answer unless the frame says it is not one.
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
    // Before the roster: the stack is open and says the answer is nothing,
    // rather than not being there at all.
    // And it names the entity it is about — the stack heads itself
    // "Inside orders", never a bare "Contains" that names a box.
    expect(screen.getByText(/Nothing inside orders is on this lineage/)).toBeTruthy()
    expect(screen.getByText('Inside')).toBeTruthy()
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
      { model: walkModel('F', {}), status: 'loading', error: null, extendStatus: new Map() },
      { onLoadChildrenOf },
    )
    expect(onLoadChildrenOf).not.toHaveBeenCalled()
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
    expect(within(panel as HTMLElement).getByText(/in raw_orders/)).toBeTruthy()
    expect(within(panel as HTMLElement).getByText(/Natural key from the source system/)).toBeTruthy()
    // Lineage, counted off the walk model rather than measured again.
    expect(within(panel as HTMLElement).getByText(/1 flow in this walk/)).toBeTruthy()
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

  it('Escape closes the peek — and does NOT close the lens under it', () => {
    const onClose = vi.fn()
    renderLens(['F'], table(), { onClose })
    fireEvent.click(row('order_id'))
    expect(peek()).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(peek()).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    // With nothing to dismiss, Escape means what it always meant.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
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
    // or the letters would dim every row against a query with nowhere to
    // be seen or cleared.
    renderLens(['F'], manyColumns())
    const region = screen.getByLabelText(/^Rows inside raw_orders\./)
    fireEvent.focus(region)
    fireEvent.keyDown(region, { key: 'z' })
    expect((screen.getByLabelText('Filter what is inside raw_orders') as HTMLInputElement).value).toBe('z')
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
