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
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { LineageLens } from '../LineageLens'
import { usePreferencesStore } from '@/store/preferences'
import { useSchemaStore } from '@/store/schema'
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

/** The chevron beside a card's name — "what is inside this". */
const contentsChevron = (label: string) => screen.getByLabelText(`Show what's inside ${label}`)

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

  it('shows the upstream TABLE immediately, nested under its whole spine', () => {
    renderLens(['F'], doneWalk(collateralsEstate()))

    // Every level of the spine is on the board — the walk resolved a
    // structure the old builder collapsed into one card.
    for (const level of ['Finance', 'RiskApp', 'PROD', 'CURATED', 'RISK_DB']) {
      expect(onBoard(level)).toBe(true)
    }
    // And the ANSWER — the actual upstream table — is visible without a
    // single click, because every level above it is a pass-through.
    expect(onBoard('loan_positions')).toBe(true)
    // The focus itself, nested in its own table.
    expect(screen.getAllByText('collaterals').length).toBeGreaterThan(0)
    expect(onBoard('risk_exposure_daily')).toBe(true)
  })

  it('states honest counts for what a container holds, at both grains', () => {
    renderLens(['F'], doneWalk(collateralsEstate()))
    // RISK_DB holds twelve things; exactly one of them is on this
    // lineage. Both numbers, or the card is either a lie or a mystery.
    expect(screen.getByText(/1 on this lineage · of 12/)).toBeTruthy()
    // A branchy domain the walk did NOT open states the same way.
    expect(screen.getByText(/2 on this lineage · of 40/)).toBeTruthy()
  })

  it('opens a branchy domain\'s lineage children in ONE click, with no fetch', () => {
    const { api } = renderLens(['F'], doneWalk(collateralsEstate()))
    // Sales BRANCHES, so the walk stopped there rather than guessing
    // which of its children was the answer.
    expect(onBoard('orders_raw')).toBe(false)

    fireEvent.click(contentsChevron('Sales'))

    expect(onBoard('orders_raw')).toBe(true)
    expect(onBoard('refunds_raw')).toBe(true)
    // The model already held them — expanding is a re-projection, and
    // it must never cost a round trip.
    expect(api.extend).not.toHaveBeenCalled()
    expect(api.page).not.toHaveBeenCalled()
  })

  it('the ⊕ extend asks the server from the card\'s own leaves', () => {
    const { api } = renderLens(['F'], doneWalk(collateralsEstate()))
    // "6 more upstream of loan_positions" — the remainder the data
    // source reported, minus what is already in hand.
    fireEvent.click(screen.getByTitle(/Walk one hop further upstream of loan_positions \(6 more\)/))
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
    fireEvent.click(screen.getByTitle(/Show 2 more upstream — already loaded, nothing to fetch/))
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
    const exact = screen.getByTitle(/Walk one hop further upstream of has_48_more \(48 more\)/)
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
    // The focal card, in the graph.
    expect(screen.getByText('2 in')).toBeTruthy()
    expect(screen.getByText('1 out')).toBeTruthy()
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

  it('every card is movable, and a frame carries its children rather than shedding them', () => {
    usePreferencesStore.setState({ lensViewMode: 'graph' })
    renderLens(['F'], doneWalk(walkModel('F', {
      nodes: [
        wnode('F', 'dataset', 'stg_orders'),
        wnode('T', 'dataset', 'raw_orders', { childCount: 2 }),
        wnode('c1', 'schemaField', 'order_id'),
      ],
      containmentEdges: [holds('T', 'c1')],
      lineageEdges: [hop('c1', 'F')],
      upstreamUrns: new Set(['c1']),
    })))

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

// ── EVERYTHING INSIDE ────────────────────────────────────────────────

describe('what is really inside a container', () => {
  beforeEach(() => usePreferencesStore.setState({ lensViewMode: 'graph', lensFrameChildren: 'connected' }))
  afterEach(() => cleanup())

  const tableWithColumns = () => doneWalk(walkModel('F', {
    nodes: [
      wnode('F', 'dataset', 'stg_orders'),
      wnode('T', 'dataset', 'raw_orders', { childCount: 4 }),
      wnode('c1', 'schemaField', 'order_id'),
    ],
    containmentEdges: [holds('T', 'c1')],
    lineageEdges: [hop('c1', 'F')],
    upstreamUrns: new Set(['c1']),
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
    ],
    containmentEdges: [holds('T', 'c1')],
    lineageEdges: [hop('c1', 'F')],
    upstreamUrns: new Set(['c1']),
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
   *  which is the state a page turn actually happens in. */
  const openWideTable = (onLoadAllChildren: LoadRoster) => {
    const { rerender, api } = renderLens(['F'], wideTable(), { onLoadAllChildren })
    fireEvent.click(screen.getByLabelText('Everything inside, lineage marked'))
    rerender(
      <LineageLens
        history={{ entries: ['F'], cursor: 0 }}
        walk={wideTable()}
        walkApi={api}
        childrenAll={hundredLoaded}
        childrenAllStatus={new Map([['T', 'done' as const]])}
        onLoadAllChildren={onLoadAllChildren}
        onRecenter={vi.fn()}
        onBack={vi.fn()}
        onForward={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    // The flip itself asks for the roster; the turns are what this test
    // is about.
    onLoadAllChildren.mockClear()
  }

  it('turns pages inside the loaded set without asking the server', () => {
    const onLoadAllChildren: LoadRoster = vi.fn()
    openWideTable(onLoadAllChildren)
    const next = screen.getByLabelText('Next page of raw_orders')
    // Nine turns, all of them inside the hundred children already in
    // hand. One server page backs ten render windows — asking on every
    // Next spent nine round trips re-fetching what the frame held.
    for (let i = 0; i < 9; i++) fireEvent.click(next)
    expect(screen.getByText(/page 10 of/)).toBeTruthy()
    expect(onLoadAllChildren).not.toHaveBeenCalled()
  })

  it('asks exactly once when a turn runs past what is loaded', () => {
    const onLoadAllChildren: LoadRoster = vi.fn()
    openWideTable(onLoadAllChildren)
    const next = screen.getByLabelText('Next page of raw_orders')
    for (let i = 0; i < 10; i++) fireEvent.click(next)
    // The tenth turn is the first window the loaded page cannot cover.
    expect(onLoadAllChildren).toHaveBeenCalledTimes(1)
    expect(onLoadAllChildren).toHaveBeenCalledWith('T', '')
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
    expect(board).toContain('Ingest App')   // initial only
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
