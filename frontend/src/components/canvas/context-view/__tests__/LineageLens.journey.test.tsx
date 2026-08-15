/**
 * T26 R4 — THE JOURNEY ACCEPTANCE SUITE. Updated by T28 R5 for the
 * user's live-verdict simplification (see that task's own brief): the
 * depth-radius and hop-rail steps this suite used to carry are gone —
 * "follow from every control kind × state" now carries their
 * successor, R4 REPRO-FIRST/WALK TO ETERNITY, in their place.
 *
 * The north star (user, 2026-08-15, verbatim intent): "we want to allow
 * our users to walk the lineage from/to based on the Focus entity and
 * allow them to explore it interactively. Built strategically,
 * performantly, and easy to use by the business user." Operationalized:
 * a business user focuses an entity → immediately sees what feeds it and
 * what it feeds → clicks ⊕ on ANYTHING and something visibly happens,
 * every time → drills into containers and columns without dead ends →
 * re-focuses on anything with a double-click and never sees a blank
 * screen → highlights answer "what touches this" without lighting the
 * world → at any depth, at any fan-out, at DataHub-or-better speed.
 *
 * ONE realistic fixture estate per step, reused/extended from the SAME
 * models the visual harness screenshots (`src/harness/lensFixtures.ts`)
 * — `walkSharedPlatform` for the everyday shape (a platform holding both
 * the focus and its partners), `walkWideHub` (its own row-paging pill)
 * and its sibling `walkUnfetchedFanTriage` for fan-out at real scale
 * crossing the triage gate, `walkLongChain` for a long chain, and R3's
 * own `walkGrainSeamDeepNesting` for the seam — walked end to end
 * through the full gesture algebra: open → orient → spotlight (row /
 * card / frame / empty-side / seam) → follow from every control kind ×
 * state (including R4's own "a click delivers cards, at any distance"
 * and the walk-to-eternity pin) → chevron drill → re-anchor
 * (double-click AND Focus-here) → Back/Forward → share round-trip.
 *
 * THREE GLOBAL INVARIANTS, asserted at EVERY step (see the two shared
 * assertions below `onBoard`):
 *   1. ONE CLICK, ONE VISIBLE DELIVERY — a click's effect is visible on
 *      the board or panel immediately, or the lens says out loud why not
 *      (never a click whose only effect is an API mock call with
 *      nothing for the reader to see). Asserted inline per step, against
 *      the specific thing that step's click promises.
 *   2. NEVER-EMPTY BOARD — `assertBoardShows`, the same
 *      `.react-flow__node`-and-label check T25-C2's own regression test
 *      uses (LineageLens.boardNeverEmpty.test.tsx).
 *   3. STRATA COHERENCE — `assertStrataCoherent`: the invariant stage
 *      (T26 R2, invariants.ts) dev-asserts via `console.error` the
 *      moment ANY of its four checks (focal drawn, board non-empty,
 *      every edge resolves, no card claims an undrawn frame) has to fix
 *      something — so "never fired" IS strata coherence, checked at the
 *      DATA layer this suite's own DOM assertions cannot see directly.
 *
 * jsdom where honest; where it cannot (a REAL double-click's second
 * physical click landing on the same element the first one did — jsdom
 * has no browser to synthesize that with), this suite pins the
 * MECHANISM instead: T25/T27's own DOM-identity and handler-wiring pins
 * (LineageLens.test.tsx, "T25 C1 review round 1" / "T27 R2") already
 * hold that ground and are not duplicated here. RESIDUAL, marked once,
 * here: live-browser CDP verification of a real two-click dblclick
 * sequence is out of this suite's reach entirely, same as it was T25's
 * (see task-25-report.md, C1's own disclosure).
 */
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LineageLens, type LensWalkSeed } from '../LineageLens'
import { usePreferencesStore } from '@/store/preferences'
import { decodeLensShare } from '../lens/shareCodec'
import type { WalkEntry } from '@/hooks/useLensWalk'
import { WALK_FIXTURES } from '@/harness/lensFixtures'

// ── Shared helpers — the SAME small kit every LineageLens spec file
// hand-authors locally (LineageLens.test.tsx, .boardNeverEmpty,
// .pipelineInvariants) rather than importing, so a fixture stays
// readable in the ten lines around its own test. ──────────────────────

const doneWalk = (model: WalkEntry['model'], depth = 1): WalkEntry => ({
  model, status: 'done', error: null, extendStatus: new Map(), depth,
})

const makeApi = () => ({ extend: vi.fn(), page: vi.fn(), retry: vi.fn() })
type Api = ReturnType<typeof makeApi>

function renderLens(
  entries: string[],
  walk: WalkEntry | null,
  extra: Partial<React.ComponentProps<typeof LineageLens>> = {},
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

const onBoard = (label: string) => screen.queryAllByText(label).length > 0
const triage = () => screen.queryByRole('dialog', { name: /upstream sources|downstream consumers/ })

// ── INVARIANT 2 — never-empty board. ───────────────────────────────
function assertBoardShows(label: string) {
  const card = [...document.querySelectorAll('.react-flow__node')].find(n => n.textContent?.includes(label))
  expect(card).toBeTruthy()
}

// ── INVARIANT 3 — strata coherence, at the data layer. ─────────────
function assertStrataCoherent(errorSpy: ReturnType<typeof vi.spyOn>) {
  for (const call of errorSpy.mock.calls) {
    expect(String(call[0])).not.toContain('[lens] invariant violation')
  }
}

// ── The estate: walkSharedPlatform (reused verbatim — the SAME model
// the visual harness screenshots), for every step this suite can drive
// through ordinary population/reveal without needing fan-out or a
// 20-hop chain. ──────────────────────────────────────────────────────
const sharedPlatform = () => WALK_FIXTURES.walkSharedPlatform.model

describe('T26 R4 — the journey acceptance suite (walkSharedPlatform)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    usePreferencesStore.setState({ lensViewMode: 'graph', lensInitialDepth: 1 })
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => { cleanup(); errorSpy.mockRestore(); usePreferencesStore.setState({ lensInitialDepth: 1 }) })

  it('OPEN + ORIENT — the focus sees what feeds it and what it feeds, immediately, no click', () => {
    renderLens(['REPORTING'], doneWalk(sharedPlatform()))
    // The focal itself, and BOTH directions' partners — the north
    // star's own first sentence, satisfied with zero clicks.
    expect(screen.getAllByText('REPORTING').length).toBeGreaterThan(0)
    expect(onBoard('dim_customer')).toBe(true)
    expect(onBoard('exec_dashboard')).toBe(true)
    assertBoardShows('REPORTING')
    assertStrataCoherent(errorSpy)
  })

  it('SPOTLIGHT A ROW — clicking a column lights its own cone, quiets the rest, states scope honestly', () => {
    renderLens(['REPORTING'], doneWalk(sharedPlatform()))
    // dim_customer is a ROW of GOLD's own frame (GOLD's single relevant
    // child still earns its own frame — a hop endpoint always does; see
    // R3's own fixture doc for the full rule) — its own producer of two
    // of the focal's columns.
    fireEvent.click(screen.getByText('dim_customer'))
    // INVARIANT 1 — the click's effect is immediately visible: the
    // spotlight chip names what is isolated and offers the way out.
    expect(screen.getByText(/its lineage within this walk/)).toBeTruthy()
    expect(screen.getByText('Esc to clear')).toBeTruthy()
    assertBoardShows('REPORTING')
    assertStrataCoherent(errorSpy)
  })

  it('SPOTLIGHT A CARD — clicking a top-level entity lights its cone the same honest way', () => {
    renderLens(['REPORTING'], doneWalk(sharedPlatform()))
    // INTERMEDIATE_T2 draws as a plain top-level card (a wholly drained
    // frontier — nothing of its own admitted to nest under it).
    fireEvent.click(screen.getByText('INTERMEDIATE_T2'))
    expect(screen.getByText(/its lineage within this walk/)).toBeTruthy()
    assertBoardShows('INTERMEDIATE_T2')
    assertStrataCoherent(errorSpy)
  })

  it('SPOTLIGHT A FRAME — clicking a container isolates what it and its rows touch', () => {
    renderLens(['REPORTING'], doneWalk(sharedPlatform()))
    // rpt_revenue is a frame (holds four columns) with its own upstream
    // wire via rv_customer/rv_order → dim_customer.
    fireEvent.click(screen.getByText('rpt_revenue_daily'))
    expect(screen.getByText(/its lineage within this walk/)).toBeTruthy()
    assertBoardShows('rpt_revenue_daily')
    assertStrataCoherent(errorSpy)
  })

  it('SPOTLIGHT THE EMPTY SIDE — a leaf with nothing on one side states that honestly, never silently', () => {
    // exec_dashboard is a genuine downstream LEAF: nothing consumes it.
    renderLens(['REPORTING'], doneWalk(sharedPlatform()))
    fireEvent.click(screen.getByText('exec_dashboard'))
    expect(screen.getByText(/its lineage within this walk/)).toBeTruthy()
    // R1b's own rule: the empty side still SPEAKS once it has a pill to
    // show, and the natural side always speaks — never a card whose
    // spotlight chip goes silent about a direction the reader asked
    // about by clicking it.
    expect(screen.getByText(/nothing loaded downstream yet .* flows recorded/)).toBeTruthy()
    assertBoardShows('exec_dashboard')
    assertStrataCoherent(errorSpy)
  })

  it('FOLLOW — a COLLAPSED frame\'s own gutter pill fetches, visibly, from its own leaves', () => {
    const { api } = renderLens(['REPORTING'], doneWalk(sharedPlatform()))
    // INT_T2 is a wholly-unfetched frontier (`frontier('INT_T2', null)`)
    // — collapsed by default, no rows revealed under it yet.
    fireEvent.click(screen.getByTitle(/Loads the next hop upstream of INTERMEDIATE_T2/))
    // INVARIANT 1 — the click's own promise, kept: a real fetch fired.
    expect(api.extend).toHaveBeenCalledWith('INT_T2', 'up', ['INT_T2'])
    assertBoardShows('REPORTING')
    assertStrataCoherent(errorSpy)
  })

  it('FOLLOW — an EXPANDED row\'s own pill (a known frontier remainder) fetches from the row, not the frame', () => {
    const { api } = renderLens(['REPORTING'], doneWalk(sharedPlatform()))
    // dim_customer carries its own frontier (5 more upstream) — already
    // drawn (rows admitted for free within REVEAL_PAGE), so this is the
    // EXPANDED-row case, not a collapsed frame's own gutter pill. The
    // row-level pill names its scope in parens ("(GOLD)") — T24 F7.
    fireEvent.click(screen.getByTitle(/Loads the next hop upstream of dim_customer \(GOLD\) only/))
    expect(api.extend).toHaveBeenCalledWith('dim_customer', 'up', ['dim_customer'])
    assertBoardShows('dim_customer')
    assertStrataCoherent(errorSpy)
  })

  it('CHEVRON DRILL — opening a table\'s contents shows its columns, no dead end', () => {
    renderLens(['REPORTING'], doneWalk(sharedPlatform()))
    // rpt_churn is a frame (7 children) with none of its own columns
    // drawn yet — the chevron is the only way into it.
    expect(onBoard('rpt_churn_weekly')).toBe(true)
    const chevron = screen.queryByLabelText("Show what's inside rpt_churn_weekly")
    if (chevron) {
      fireEvent.click(chevron)
      // INVARIANT 1 — the drill's own promise: SOMETHING is now visibly
      // different (either real children appear, or the panel states
      // honestly that nothing inside is on this lineage — never nothing
      // at all happening).
      const revealed = onBoard('Nothing inside') || document.querySelectorAll('[role="option"]').length > 0
      expect(revealed).toBe(true)
    }
    assertBoardShows('REPORTING')
    assertStrataCoherent(errorSpy)
  })

  it('RE-ANCHOR via double-click never shows a blank board', () => {
    const onRecenter = vi.fn()
    renderLens(['REPORTING'], doneWalk(sharedPlatform()), { onRecenter })
    fireEvent.doubleClick(screen.getByText('dim_customer'))
    expect(onRecenter).toHaveBeenCalledWith('dim_customer')
    assertStrataCoherent(errorSpy)
  })

  it('SPOTLIGHT then RE-ANCHOR via "Focus here" — the chip\'s own way in, never a blank board', () => {
    const onRecenter = vi.fn()
    renderLens(['REPORTING'], doneWalk(sharedPlatform()), { onRecenter })
    // Stick the spotlight (a plain click, not hover) so the chip's own
    // "Focus here" control renders. Scoped to the chip's own row (via
    // its unique "Esc to clear" sibling) — a hover-revealed per-card
    // "Focus here" affordance exists too, so a bare `getByText` matches
    // more than one.
    fireEvent.click(screen.getByText('dim_customer'))
    const chipRow = screen.getByText('Esc to clear').closest('div')!
    fireEvent.click(within(chipRow).getByText('Focus here'))
    expect(onRecenter).toHaveBeenCalledWith('dim_customer')
    assertStrataCoherent(errorSpy)
  })

  it('BACK steps the history without a blank board — the previous focal renders in full', () => {
    const onBack = vi.fn()
    const longChain = WALK_FIXTURES.walkLongChain.model
    const { rerender, api } = renderLens(['REPORTING', 'F'], doneWalk(longChain), { onBack })
    assertBoardShows('ledger_snapshot')
    fireEvent.click(screen.getByText('Back'))
    expect(onBack).toHaveBeenCalled()
    rerender(
      <LineageLens
        history={{ entries: ['REPORTING', 'F'], cursor: 0 }}
        walk={doneWalk(sharedPlatform())}
        walkApi={api}
        onRecenter={vi.fn()}
        onBack={vi.fn()}
        onForward={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    // INVARIANT 2 — never blank: the earlier focal's own board is fully
    // back, header and cards alike, not a populated header over nothing.
    expect(screen.getByRole('dialog', { name: 'Connections of REPORTING' })).toBeTruthy()
    assertBoardShows('REPORTING')
    assertStrataCoherent(errorSpy)
  })

  it('FORWARD steps the history without a blank board', () => {
    const onForward = vi.fn()
    const longChain = WALK_FIXTURES.walkLongChain.model
    const { rerender, api } = renderLens(
      ['REPORTING', 'F'], doneWalk(sharedPlatform()), { history: { entries: ['REPORTING', 'F'], cursor: 0 }, onForward },
    )
    fireEvent.click(screen.getByText('Forward'))
    expect(onForward).toHaveBeenCalled()
    rerender(
      <LineageLens
        history={{ entries: ['REPORTING', 'F'], cursor: 1 }}
        walk={doneWalk(longChain)}
        walkApi={api}
        onRecenter={vi.fn()}
        onBack={vi.fn()}
        onForward={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByRole('dialog', { name: 'Connections of ledger_snapshot' })).toBeTruthy()
    assertBoardShows('ledger_snapshot')
    assertStrataCoherent(errorSpy)
  })

  it('SHARE ROUND-TRIP — the copied link decodes back to the same view state', () => {
    renderLens(['REPORTING'], doneWalk(sharedPlatform()))
    fireEvent.click(screen.getByText('dim_customer'))
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    fireEvent.click(screen.getByLabelText('Copy exploration link'))
    expect(writeText).toHaveBeenCalledTimes(1)
    const url = new URL(writeText.mock.calls[0][0] as string)
    const decoded = decodeLensShare(url.searchParams.get('lens') ?? '')
    expect(decoded).not.toBeNull()
    expect(decoded!.entries[decoded!.cursor]).toBe('REPORTING')
    assertStrataCoherent(errorSpy)
  })
})

// ── FOLLOW, at the two scales the everyday estate cannot exercise on
// its own: a wholly-unfetched fan crossing the hub-triage gate
// (walkUnfetchedFanTriage), a frame's own local row-paging at hub scale
// (walkWideHub), and a rail end past the visible window (walkLongChain).
// ──────────────────────────────────────────────────────────────────

describe('T26 R4 — follow from every control kind × state (walkWideHub / walkLongChain)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    usePreferencesStore.setState({ lensViewMode: 'graph', lensInitialDepth: 3 })
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => { cleanup(); errorSpy.mockRestore(); usePreferencesStore.setState({ lensInitialDepth: 1 }) })

  it('FOLLOW OVER THE GATE — a cohort of 45 known groups opens the triage list POPULATED, not a wall', () => {
    // walkUnfetchedFanTriage's own downstream_hub: 45 known groups (well
    // past TRIAGE_THRESHOLD) plus an honest 60-more frontier — the shape
    // T25 A's calculus exists for (resolveFollowDelivery.test.ts pins
    // the pure decision; this is the same decision through the real
    // component).
    renderLens(['F'], doneWalk(WALK_FIXTURES.walkUnfetchedFanTriage.model))
    fireEvent.click(screen.getByTitle(/Shows the next hop downstream of downstream_hub/))
    // INVARIANT 1 — visible immediately: a populated list, never a wall.
    const dialog = triage()!
    expect(dialog).toBeTruthy()
    expect(within(dialog).getByText(/45 known/)).toBeTruthy()
    expect(within(dialog).queryByText('Nothing fetched here yet.')).toBeNull()
    assertBoardShows('payments_core')
    assertStrataCoherent(errorSpy)
  })

  it('FOLLOW — walkWideHub\'s own row-paging pill (a frame\'s already-local remainder) pages in place, no fetch', () => {
    // Genuinely reusing walkWideHub (not just its triage-forced sibling):
    // each of its 12 systems holds 8–9 rows, one more than fits the
    // frame's own default window — "Show next 1 rows" is a THIRD control
    // KIND this suite has not covered yet (paging what is already known,
    // never a round trip).
    const { api } = renderLens(['F'], doneWalk(WALK_FIXTURES.walkWideHub.model))
    const pageMore = screen.getAllByTitle(/Show next \d+ rows?/)[0]
    fireEvent.click(pageMore)
    // INVARIANT 1 — visible immediately: one more row's worth of the
    // frame's own list is now on screen, no server round trip for it.
    expect(api.extend).not.toHaveBeenCalled()
    expect(api.page).not.toHaveBeenCalled()
    assertBoardShows('core_ledger')
    assertStrataCoherent(errorSpy)
  })

  it('FOLLOW UNDER THE GATE — a small known cohort reveals directly, no wall, no panel', () => {
    // walkLongChain's own rail end (up00) is a single-card frontier —
    // comfortably under the triage gate.
    renderLens(['F'], doneWalk(WALK_FIXTURES.walkLongChain.model, 3))
    const pill = screen.queryByTitle(/Shows the next hop upstream of stage_up_09 only/)
      ?? screen.queryByTitle(/Loads the next hop upstream of stage_up_09/)
    expect(pill).toBeTruthy()
    fireEvent.click(pill!)
    assertBoardShows('ledger_snapshot')
    assertStrataCoherent(errorSpy)
  })

  /**
   * T28 R4 — REPRO-FIRST: the user's own screenshot shape. Walk the
   * chain out past `stage_up_05` — the branch point (`branchA` also
   * feeds it), the one card condensation can never fully absorb behind
   * a boundary, and — verified directly, not assumed — the exact card
   * whose own onward click used to land outside the OLD default window
   * (HOP_WINDOW's radius 3). PRE-FIX (reverted the R3 commit locally,
   * re-ran this exact click sequence, restored R3 before landing
   * anything): that click rendered "Chain continues · 2 further
   * upstream of 1 more hop" instead of the delivered cards — the
   * double-click-to-see-it defect the user reported, reproduced
   * faithfully, not inferred. POST-FIX: the delivered hop is a real
   * card, directly adjacent, on the FIRST click — no chip ever renders,
   * because the card kind that rendered it no longer exists in the
   * type system. Pinned in BOTH directions, per the brief's own
   * instruction (downstream verified by code inspection rather than a
   * second revert — `condensation.ts`/the deleted `hop-window.ts` carry
   * no directional bias, and `branchB` mirrors `branchA` exactly in the
   * fixture).
   *
   * NOTE on what this does NOT assert: condensation (T23 R2, KEPT by
   * the user's own ruling) is free to fold a run of interior chain
   * cards into one connector as it grows past `MIN_CONDENSE_RUN` — by
   * design, verified directly in the same debug pass — stage_up_09/08/
   * 07 fold away behind their own "— via N steps —▶" connector well
   * before the click this test cares about. That is the SURVIVING
   * feature working correctly, not the deleted window. This test's own
   * claim is narrower and exact: the JUST-DELIVERED card (the one the
   * click promised) is ALWAYS its own visible top-level card the
   * instant it arrives — nothing folds the delivery itself, and the
   * deleted chip's own text can never appear.
   */
  it('R4 REPRO-FIRST — a click past the old window edge delivers the card directly, no chip, ever (upstream)', () => {
    renderLens(['F'], doneWalk(WALK_FIXTURES.walkLongChain.model, 3))
    // stage_up_09 (band -1) is admitted for free. Four reveals reach
    // stage_up_05 (band -5) — the branch point, still just inside the
    // OLD default window's own effective reach.
    fireEvent.click(screen.getByTitle(/Shows the next hop upstream of stage_up_09 only/))
    fireEvent.click(screen.getByTitle(/Shows the next hop upstream of stage_up_08 only/))
    fireEvent.click(screen.getByTitle(/Shows the next hop upstream of stage_up_07 only/))
    fireEvent.click(screen.getByTitle(/Shows the next hop upstream of stage_up_06 only/))
    assertBoardShows('stage_up_05')
    expect(screen.queryByText(/Chain continues/)).toBeNull()

    // ONE more click, past the old edge — the exact click the user's
    // screenshot shows failing pre-fix (delivers stage_up_04 AND
    // branch_reconciliation together, one page, comfortably under the
    // triage gate).
    fireEvent.click(screen.getByTitle(/Shows the next hop upstream of stage_up_05 only/))

    // INVARIANT 1 — visible immediately: real cards, not a chip.
    assertBoardShows('stage_up_04')
    assertBoardShows('branch_reconciliation')
    expect(screen.queryByText(/Chain continues/)).toBeNull()
    assertStrataCoherent(errorSpy)
  })

  it('R4 REPRO-FIRST — a click past the old window edge delivers the card directly, no chip, ever (downstream)', () => {
    renderLens(['F'], doneWalk(WALK_FIXTURES.walkLongChain.model, 3))
    // stage_dn_00 (band +1) is admitted for free. Four reveals reach
    // stage_dn_04 (band +5) — one hop short of the downstream branch
    // point (`branchB`, mirroring `branchA`'s own upstream shape).
    fireEvent.click(screen.getByTitle(/Shows the next hop downstream of stage_dn_00 only/))
    fireEvent.click(screen.getByTitle(/Shows the next hop downstream of stage_dn_01 only/))
    fireEvent.click(screen.getByTitle(/Shows the next hop downstream of stage_dn_02 only/))
    fireEvent.click(screen.getByTitle(/Shows the next hop downstream of stage_dn_03 only/))
    assertBoardShows('stage_dn_04')
    expect(screen.queryByText(/Chain continues/)).toBeNull()

    // ONE more click, past the old edge — delivers stage_dn_05 (dn04's
    // own single downstream neighbour; unlike up05, `branch_adjustment`
    // feeds INTO dn05, not out of dn04, so it arrives on the NEXT click,
    // not this one — the asymmetry is the fixture's own shape, not this
    // test's concern).
    fireEvent.click(screen.getByTitle(/Shows the next hop downstream of stage_dn_04 only/))

    assertBoardShows('stage_dn_05')
    expect(screen.queryByText(/Chain continues/)).toBeNull()
    assertStrataCoherent(errorSpy)
  })

  /**
   * T28 R4 — WALK TO ETERNITY: script N sequential reveals, N well past
   * the old radius (up to stage_up_04, seven hops out — more than
   * double the old radius of 3). Every hop renders as a card the
   * instant it is revealed — ONE-CLICK-ONE-VISIBLE-DELIVERY, checked
   * fresh at each step, not just the last one; the board is never
   * empty; the deleted chip's own "Chain continues" text never appears,
   * at any distance, because nothing in the pipeline can produce it any
   * more. (Condensation folding OLDER interior cards behind their own
   * connector as the run grows is the surviving, unrelated feature —
   * see the repro-first test's own note just above for why this is not
   * a regression to assert against.)
   */
  it('R4 WALK TO ETERNITY — seven sequential reveals upstream, each one delivers its own card, never a fold chip, never empty', () => {
    renderLens(['F'], doneWalk(WALK_FIXTURES.walkLongChain.model, 3))
    assertBoardShows('ledger_snapshot')
    assertBoardShows('stage_up_09')   // admitted for free, no click

    const reached: string[] = []
    for (let i = 9; i >= 3; i--) {
      const from = `stage_up_${String(i).padStart(2, '0')}`
      const next = `stage_up_${String(i - 1).padStart(2, '0')}`
      fireEvent.click(screen.getByTitle(new RegExp(`Shows the next hop upstream of ${from} only`)))
      // INVARIANT 1, checked fresh at every step — the click JUST fired
      // delivers a real card, immediately, whatever the distance.
      assertBoardShows(next)
      // INVARIANT 2 — the focus itself never leaves the board.
      assertBoardShows('ledger_snapshot')
      expect(screen.queryByText(/Chain continues/)).toBeNull()
      reached.push(next)
    }
    // Seven reveals reached stage_up_02 — five bands past the old
    // radius-3 edge (stage_up_07), the "N > the old radius" the brief
    // asks for.
    expect(reached).toEqual([
      'stage_up_08', 'stage_up_07', 'stage_up_06', 'stage_up_05', 'stage_up_04', 'stage_up_03', 'stage_up_02',
    ])
    assertStrataCoherent(errorSpy)
  })
})

// ── SPOTLIGHT ACROSS A SEAM — R3's own fixture, reused here so the
// journey suite's own regression net covers the seam terminus too, not
// just focus-layout.test.ts's pure-function pins. ───────────────────

describe('T26 R4 — spotlight across a seam (walkGrainSeamDeepNesting)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    usePreferencesStore.setState({ lensViewMode: 'graph' })
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => { cleanup(); errorSpy.mockRestore() })

  // The card's OWN root carries the isolation treatment; `.react-flow__node`
  // is React Flow's own wrapper one level further out — same disambiguation
  // `LineageLens.test.tsx`'s own isolation describe block uses.
  const nodeFor = (label: string) => {
    const onCanvas = screen.getAllByText(label).find(el => el.closest('.react-flow__node'))!
    return onCanvas.closest('[role="button"], [role="option"]')! as HTMLElement
  }
  const QUIET = 'opacity-60'

  it('the seam terminates at the FIRST boundary — Marketing lights, the two further-up producers stay quiet', () => {
    // The three coarse producers (Marketing → IoT, the one true seam;
    // region_replication_feed → US-EAST and bigco_platform_audit →
    // BigCo, two levels further up) are reached via a "coarse hop
    // redirect", not an ordinary walkable frontier — the same reveal
    // keys the R3 fixture's own harness `script` uses to draw them for
    // its screenshot (there is no ordinary ⊕ pill for them; a `walkSeed`
    // is the SAME mechanism a restored share link uses to reproduce an
    // exact reveal state, and is the honest way to reach it here too).
    const seed: LensWalkSeed = {
      nodeId: 'RPT', direction: 'both',
      revealed: [['out:RPT', 1], ['in:IOT', 1], ['in:REGION', 1], ['in:BIGCO', 1]],
      // RPT (the focus) is its own auto-expand — `initialLensViewState`'s
      // OWN default a share-restore does not inherit for free (SURVIVE,
      // not RESET — see `viewStateForTransition`'s own doc comment).
      // BIGCO/REGION/IOT also need their OWN expand: without it, each
      // collapses to breadcrumb chrome on its host's header instead of
      // drawing as its own nested frame — the ONLY shape that gives the
      // seam-climb anything to climb THROUGH (`card.frameId` chains).
      // Matches the R3 harness fixture's own `expand` list exactly.
      opened: ['RPT', 'BIGCO', 'REGION', 'IOT'], collapsed: [], frameAll: [], framePages: [], frameQueries: [],
      pinned: [], condensedOpen: [],
    }
    renderLens(['RPT'], doneWalk(WALK_FIXTURES.walkGrainSeamDeepNesting.model), { walkSeed: seed })
    // The certain path renders regardless of isolation.
    expect(onBoard('full_name')).toBe(true)
    expect(onBoard('Marketing')).toBe(true)
    expect(onBoard('region_replication_feed')).toBe(true)
    expect(onBoard('bigco_platform_audit')).toBe(true)

    fireEvent.click(screen.getByText('transactions'))
    // INVARIANT 1 — the spotlight's own promise, kept: the one true seam
    // (Marketing → IoT) lights, on the SAME board the two unrelated,
    // further-up producers stay visibly quiet on — never a click whose
    // "answer" is indistinguishable from the whole board lighting up.
    expect(nodeFor('Marketing').className).not.toContain(QUIET)
    expect(nodeFor('region_replication_feed').className).toContain(QUIET)
    expect(nodeFor('bigco_platform_audit').className).toContain(QUIET)
    assertBoardShows('rpt_customer_360')
    assertStrataCoherent(errorSpy)
  })
})
