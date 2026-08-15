/**
 * T25 A review round 1 — the fetch-then-triage CALCULUS, tested
 * exhaustively over its own state matrix. Every follow control
 * (WalkPill's gutter pill — row and frame alike — RailEnd, InlineFollow,
 * the spotlight bridge) routes its click decision through
 * `resolveFollowDelivery`; this file is the regression net for the
 * whole defect family it closes, not a per-control test each new
 * caller has to remember to write again. The bug it exists to prevent
 * recurring: gating a click on the UNFETCHED frontier (`pill.count`)
 * instead of what is already KNOWN — it recurred independently at least
 * three times (WalkPill's gutter pill, RailEnd's rail-end pill, and
 * again at row level) before this file existed.
 */
import { describe, it, expect } from 'vitest'
import { resolveFollowDelivery, TRIAGE_THRESHOLD } from '../FocusGraphView'
import type { FocusPill } from '../focus-cards'

const pill = (overrides: Partial<FocusPill>): FocusPill => ({
  kind: 'extend', count: null, key: 'in:x', ...overrides,
})

describe('resolveFollowDelivery — reveal (already-local data, gates on the WHOLE ranking)', () => {
  it('under the gate: reveals', () => {
    const r = resolveFollowDelivery(pill({ kind: 'reveal', groupsTotal: TRIAGE_THRESHOLD }), 0)
    expect(r.action).toBe('reveal')
  })
  it('over the gate: opens triage — regardless of knownCount, which reveal ignores', () => {
    const r = resolveFollowDelivery(pill({ kind: 'reveal', groupsTotal: TRIAGE_THRESHOLD + 1 }), 0)
    expect(r.action).toBe('triage-open')
  })
  it('unknown ranking (groupsTotal absent) never trips the gate', () => {
    const r = resolveFollowDelivery(pill({ kind: 'reveal' }), 999)
    expect(r.action).toBe('reveal')
  })
})

describe('resolveFollowDelivery — extend (no cursor): gates on what is ALREADY KNOWN, never the unfetched frontier', () => {
  it('wholly unfetched (knownCount 0), ANY frontier size — always fetches, never walls', () => {
    for (const count of [null, 6, 96, 5000]) {
      const r = resolveFollowDelivery(pill({ kind: 'extend', count }), 0)
      expect(r.action).toBe('extend')
    }
  })
  it('known cohort at the gate boundary — still fetches', () => {
    const r = resolveFollowDelivery(pill({ kind: 'extend', count: 999 }), TRIAGE_THRESHOLD)
    expect(r.action).toBe('extend')
  })
  it('known cohort past the gate — an already-fetched big fan opens triage directly, no fetch', () => {
    const r = resolveFollowDelivery(pill({ kind: 'extend', count: 5 }), TRIAGE_THRESHOLD + 1)
    expect(r.action).toBe('triage-open')
  })
  it('the frontier estimate ALONE never gates extend — the exact empty-panel bug this closes', () => {
    // 96 unfetched, 0 known: the reported repro. Frontier size must be
    // irrelevant to the decision.
    const r = resolveFollowDelivery(pill({ kind: 'extend', count: 96 }), 0)
    expect(r.action).toBe('extend')
    expect(r.action).not.toBe('triage-open')
  })
})

describe('resolveFollowDelivery — page (server cursor present): same known-count gate as extend', () => {
  it('unfetched, any remainder — pages', () => {
    const r = resolveFollowDelivery(pill({ kind: 'page', count: 96, cursor: 'c1' }), 0)
    expect(r.action).toBe('page')
  })
  it('known cohort past the gate — triage, not a page dump', () => {
    const r = resolveFollowDelivery(pill({ kind: 'page', count: 5, cursor: 'c1' }), TRIAGE_THRESHOLD + 1)
    expect(r.action).toBe('triage-open')
  })
  it('a page pill with no cursor (malformed) falls back to extend, not a crash', () => {
    const r = resolveFollowDelivery(pill({ kind: 'page', count: 10, cursor: undefined }), 0)
    expect(r.action).toBe('extend')
  })
})

describe('resolveFollowDelivery — every decision names why (matrix debuggability)', () => {
  it('the why string is non-empty for every action, at both sides of the gate boundary', () => {
    const cases: Array<[FocusPill, number]> = [
      [pill({ kind: 'reveal', groupsTotal: 1 }), 0],
      [pill({ kind: 'reveal', groupsTotal: TRIAGE_THRESHOLD + 1 }), 0],
      [pill({ kind: 'extend', count: 10 }), 0],
      [pill({ kind: 'extend', count: 10 }), TRIAGE_THRESHOLD + 1],
      [pill({ kind: 'page', count: 10, cursor: 'c' }), 0],
      [pill({ kind: 'page', count: 10, cursor: 'c' }), TRIAGE_THRESHOLD + 1],
    ]
    for (const [p, known] of cases) {
      expect(resolveFollowDelivery(p, known).why.length).toBeGreaterThan(0)
    }
  })
})
