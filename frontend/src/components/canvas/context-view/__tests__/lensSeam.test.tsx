/**
 * The lens SEAM — the wiring ContextViewCanvas owns, with nothing faked
 * between the click and the request.
 *
 * Every other lens suite cuts the seam somewhere: `LineageLens.test`
 * hands the component a hand-written `WalkEntry` and a `vi.fn()` walk
 * api; `useLensWalk.test` drives the hook with urns it names itself.
 * Both pass while the two are wired to each other wrongly — and the
 * things that live exactly there had no coverage at all: which entry of
 * the history is the focal, whether a shared link's depth reaches the
 * fetch, what `seedLeavesFor` actually puts in an extend, and whether
 * the walk api the cards close over is stable enough for their memo.
 *
 * So this file mirrors that block of ContextViewCanvas — the same
 * derivations, in the same order, using the same production helpers —
 * around the REAL hook, the REAL adapter and the REAL layout, and stubs
 * only the provider (the network).
 */
import { useMemo, useState } from 'react'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { LineageLens, type LensWalkSeed } from '../LineageLens'
import { useLensWalk } from '@/hooks/useLensWalk'
import { lensFocalOf, lensPush, type LensHistory } from '../lens/lensHistory'
import { usePreferencesStore } from '@/store/preferences'
import type {
  GraphDataProvider, GraphNode, TraceV2Result, LensClosureExtras,
} from '@/providers/GraphDataProvider'

// ── the estate ───────────────────────────────────────────────────────
//
//   u_prior ─▶ b_amount ┐
//              a_status ┴─▶ (customers) ─▶ collaterals   ← the focus
//              z_note   ┘
//
// `customers` is a table whose three columns carry the lineage. Two of
// them have more upstream in the data source (a frontier entry); the
// third is drained. Collapse the table and it stands for all three — the
// case `seedLeavesFor` exists for, since the ⊕ is then on a card whose
// frontier belongs to entities that are no longer drawn.

const gn = (urn: string, entityType: string, displayName: string, properties = {}): GraphNode =>
  ({ urn, displayName, entityType, properties }) as GraphNode

const ge = (source: string, target: string) =>
  ({ id: `e:${source}>${target}`, sourceUrn: source, targetUrn: target, edgeType: 'DERIVES_FROM' })

function estate(): TraceV2Result & LensClosureExtras {
  return {
    focus: { urn: 'F', level: 0, entityType: 'dataset' },
    nodes: [
      gn('F', 'dataset', 'collaterals'),
      gn('T', 'dataset', 'customers', { childCount: 9 }),
      gn('a_status', 'column', 'status'),
      gn('b_amount', 'column', 'amount'),
      gn('z_note', 'column', 'note'),
      gn('u_prior', 'dataset', 'prior_ledger'),
    ],
    edges: [ge('a_status', 'F'), ge('b_amount', 'F'), ge('z_note', 'F'), ge('u_prior', 'b_amount')],
    containmentEdges: [
      { id: 'c1', sourceUrn: 'T', targetUrn: 'a_status', edgeType: 'CONTAINS' },
      { id: 'c2', sourceUrn: 'T', targetUrn: 'b_amount', edgeType: 'CONTAINS' },
      { id: 'c3', sourceUrn: 'T', targetUrn: 'z_note', edgeType: 'CONTAINS' },
    ],
    upstreamUrns: new Set(['T', 'a_status', 'b_amount', 'z_note', 'u_prior']),
    downstreamUrns: new Set(),
    effectiveLevel: 0, isInherited: false, inheritedFromUrn: null,
    truncated: false, truncationReason: null,
    // `b_amount` already has one producer on the board and says there are
    // nine; `a_status` has none loaded and says there are four. `z_note`
    // is drained — it says nothing, so nothing is offered for it.
    frontierUp: [
      { urn: 'b_amount', totalCount: 9, nextCursor: null },
      { urn: 'a_status', totalCount: 4, nextCursor: null },
    ],
    frontierDown: [{ urn: 'F', totalCount: 12, nextCursor: 'e:64' }],
    seedTruncated: false,
  }
}

/** Whatever else gets focused: a board with that entity on it and
 *  nothing more, so a re-center is observable without a second estate. */
function bareEstate(urn: string): TraceV2Result & LensClosureExtras {
  return {
    ...estate(),
    focus: { urn, level: 0, entityType: 'dataset' },
    edges: [], containmentEdges: [],
    upstreamUrns: new Set(), downstreamUrns: new Set(),
    frontierUp: [], frontierDown: [],
  }
}

function makeProvider() {
  const traceClosure = vi.fn(async (req: Record<string, unknown>) =>
    (req.urn === 'F' ? estate() : bareEstate(req.urn as string)))
  return { provider: { scopeKey: 'ws1', traceClosure } as unknown as GraphDataProvider, traceClosure }
}

/**
 * ContextViewCanvas's lens block, and nothing else: the same focal
 * derivation, the same share-depth rule, the same walk-api memo.
 */
function LensSeam({ provider, share, history: opened, prefDepth = 1, onRender }: {
  provider: GraphDataProvider
  share?: { v: 2; entries: string[]; cursor: number; depth: number } | null
  /** Where the trail already is — a link opens AT the share's cursor,
   *  and every re-center after that moves it on. */
  history?: LensHistory
  prefDepth?: number
  onRender?: (api: object) => void
}) {
  const [history, setHistory] = useState<LensHistory>(() => (
    opened ?? (share ? { entries: share.entries, cursor: share.cursor } : { entries: ['F'], cursor: 0 })
  ))
  const focal = lensFocalOf(history)
  // Verbatim from ContextViewCanvas: a share v2 link's depth overrides
  // the preference for exactly the RESTORED focal's initial fetch.
  const initialDepth = share && share.v === 2 && focal === share.entries[share.cursor]
    ? share.depth
    : prefDepth
  const walk = useLensWalk(focal, provider, initialDepth)
  const { extend, page, retry } = walk
  const walkApi = useMemo(() => ({ extend, page, retry }), [extend, page, retry])
  onRender?.(walkApi)
  const walkSeed = useMemo<LensWalkSeed | null>(() => (share
    ? {
      nodeId: share.entries[share.cursor], direction: 'both', revealed: [],
      opened: [], collapsed: [], frameAll: [], framePages: [], frameQueries: [],
    }
    : null), [share])
  return (
    <LineageLens
      history={history}
      walk={focal ? walk.walkFor(focal) : null}
      walkApi={walkApi}
      walkSeed={walkSeed}
      onRecenter={(id) => setHistory(h => lensPush(h, id))}
      onBack={() => {}}
      onForward={() => {}}
      onClose={() => {}}
    />
  )
}

/** Render the seam and wait for the initial closure to land AND settle.
 *  The board converges over two renders — the layout reports the levels
 *  it walked through and the lens folds them back in — so a query fired
 *  the instant the focal's name appears can read a half-settled grain. */
async function openLens(props: Parameters<typeof LensSeam>[0]) {
  const utils = render(<LensSeam {...props} />)
  await screen.findByText('collaterals')
  await act(async () => { await Promise.resolve() })
  return utils
}

/** Show the producer already in hand. Until it is on the board the ⊕
 *  offers THAT (free before costly), which is a different pill. */
async function revealPrior() {
  fireEvent.click(await screen.findByTitle(/Show 1 more upstream — already loaded, nothing to fetch/))
}

/** Collapse `customers`, so its ⊕ has to speak for the columns it hides.
 *  This is the state `seedLeavesFor` was written for. */
async function collapseTable() {
  fireEvent.click(await screen.findByLabelText('Collapse customers'))
}

beforeEach(() => usePreferencesStore.setState({ lensViewMode: 'graph', lensFrameChildren: 'connected' }))
afterEach(() => cleanup())

describe('lens seam — what the canvas derives and hands down', () => {
  it('the focal is the history CURSOR, not the first entry', async () => {
    const { provider, traceClosure } = makeProvider()
    render(<LensSeam provider={provider} share={{ v: 2, entries: ['u_prior', 'F'], cursor: 1, depth: 1 }} />)
    await screen.findByText('collaterals')

    expect(traceClosure).toHaveBeenCalledTimes(1)
    expect(traceClosure.mock.calls[0]![0]).toMatchObject({ urn: 'F' })
  })

  it('a shared link\'s depth reaches the fetch — and only for the focal it named', async () => {
    const { provider, traceClosure } = makeProvider()
    await openLens({
      provider,
      prefDepth: 1,
      share: { v: 2, entries: ['F'], cursor: 0, depth: 3 },
    })
    expect(traceClosure.mock.calls[0]![0]).toMatchObject({ upstreamDepth: 3, downstreamDepth: 3 })
    cleanup()

    // And once the history has moved PAST the focal the link named — a
    // re-center — the override is spent and the user's own preference
    // decides again. A share that silently re-depths the whole session
    // is the bug on the other side of this rule.
    const second = makeProvider()
    await openLens({
      provider: second.provider,
      prefDepth: 1,
      share: { v: 2, entries: ['u_prior'], cursor: 0, depth: 3 },
      history: { entries: ['u_prior', 'F'], cursor: 1 },
    })
    expect(second.traceClosure.mock.calls[0]![0]).toMatchObject({
      urn: 'F', upstreamDepth: 1, downstreamDepth: 1,
    })
  })

  it('the walk api keeps one identity across re-renders — the cards\' memo depends on it', async () => {
    const { provider } = makeProvider()
    const seen: object[] = []
    await openLens({ provider, onRender: (api) => seen.push(api) })
    // A render that changes nothing about the walk: opening/closing a
    // container is pure view state.
    await collapseTable()
    expect(seen.length).toBeGreaterThan(1)
    expect(new Set(seen).size).toBe(1)
  })
})

describe('lens seam — one click, one action, one acknowledgement', () => {
  it('extend: the seeds are the entities that actually carry the frontier, heaviest first', async () => {
    const { provider, traceClosure } = makeProvider()
    await openLens({ provider })
    await revealPrior()
    await collapseTable()

    // 9 + 4, minus the one producer now on the board.
    fireEvent.click(await screen.findByTitle(/Walk one hop further upstream of customers \(12 more\)/))

    expect(traceClosure).toHaveBeenCalledTimes(2)
    expect(traceClosure.mock.calls[1]![0]).toMatchObject({
      urn: 'T',
      direction: 'upstream',
      upstreamDepth: 1,
      downstreamDepth: 0,
      // Not the table (it carries no frontier of its own), not the
      // drained column, and `b_amount` first because it has the heavier
      // presence — the order the server's budget spends itself in.
      seedUrns: ['b_amount', 'a_status'],
    })
  })

  it('extend: ONE click is acknowledged, and the acknowledgement is not clickable', async () => {
    const { provider, traceClosure } = makeProvider()
    await openLens({ provider })
    await revealPrior()
    await collapseTable()

    fireEvent.click(await screen.findByTitle(/Walk one hop further upstream of customers/))
    // Feedback lands in the same tick as the click — the pill IS the
    // spinner now, so there is no + left to click twice.
    expect(screen.getByLabelText('Fetching upstream lineage')).toBeTruthy()
    expect(screen.queryByTitle(/Walk one hop further upstream of customers/)).toBeNull()

    fireEvent.click(screen.getByLabelText('Fetching upstream lineage'))
    expect(traceClosure).toHaveBeenCalledTimes(2)
  })

  it('page: one click carries the server\'s cursor back, verbatim', async () => {
    const { provider, traceClosure } = makeProvider()
    await openLens({ provider })

    fireEvent.click(await screen.findByTitle(/Load the rest of what is downstream of collaterals \(12 more\)/))

    expect(traceClosure).toHaveBeenCalledTimes(2)
    expect(traceClosure.mock.calls[1]![0]).toMatchObject({
      urn: 'F', direction: 'downstream', upstreamDepth: 0, downstreamDepth: 1, afterCursor: 'e:64',
    })
    expect(screen.getByLabelText('Fetching downstream lineage')).toBeTruthy()
  })

  it('reveal: one click shows what is already in hand, and never asks the server', async () => {
    const { provider, traceClosure } = makeProvider()
    await openLens({ provider })
    expect(screen.queryByText('prior_ledger')).toBeNull()

    await revealPrior()

    expect(screen.getAllByText('prior_ledger').length).toBeGreaterThan(0)
    expect(traceClosure).toHaveBeenCalledTimes(1)   // the initial fetch, and nothing since
  })
})
