/**
 * THE COARSE FIRST PAINT on the Lens (Part G, 2026-08-21). The first page
 * the board sees may be the rollup cells alone: partner containers and how
 * many flows, before a single raw hop has landed. The board draws them —
 * the partner tables under their database, each "≈W" — and when the raw
 * pages land and the walk is done, every "≈" is gone and the numbers are
 * the raw hops'. Nothing the coarse page said survives raw evidence.
 */
import { render, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LineageLens } from '../LineageLens'
import { usePreferencesStore } from '@/store/preferences'
import type { WalkEntry, WalkProgress } from '@/hooks/useLensWalk'
import type { LensWalkModel, LensWalkNode } from '../lens/closure-adapter'

const wnode = (urn: string): LensWalkNode => ({
  id: urn, type: 'generic', position: { x: 0, y: 0 },
  data: { urn, label: urn, type: 'Node' }, urn, displayName: urn, entityType: 'Node',
}) as unknown as LensWalkNode
const cell = (s: string, t: string, w: number) => ({ id: `agg:${s}>${t}`, sourceUrn: s, targetUrn: t, edgeType: 'AGGREGATED', kind: 'rollup' as const, weight: w })
const raw = (s: string, t: string, i: number) => ({ id: `r${i}`, sourceUrn: s, targetUrn: t, edgeType: 'FLOWS_TO', kind: 'raw' as const, weight: null })
const has = (p: string, c: string) => ({ sourceUrn: p, targetUrn: c })

/** domain ⊃ dept ⊃ {fdb ⊃ focus, ledger_db ⊃ {journal, balances}} with cells as the worker stamps them. */
function coarseOnly(): LensWalkModel {
  return {
    focusUrn: 'focus',
    nodes: ['domain', 'dept', 'fdb', 'focus', 'ledger_db', 'journal', 'balances'].map(wnode),
    lineageEdges: [cell('focus', 'journal', 30), cell('focus', 'balances', 10), cell('focus', 'ledger_db', 40), cell('focus', 'dept', 40), cell('focus', 'domain', 40)],
    containmentEdges: [has('domain', 'dept'), has('dept', 'fdb'), has('fdb', 'focus'), has('dept', 'ledger_db'), has('ledger_db', 'journal'), has('ledger_db', 'balances')],
    upstreamUrns: new Set(), downstreamUrns: new Set(),
    coarseUpstreamUrns: new Set(), coarseDownstreamUrns: new Set(['journal', 'balances', 'ledger_db', 'dept', 'domain']),
    frontierUp: [], frontierDown: [], truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
  }
}
/** The raw pages landed: the focus's columns and the partners' columns, three real flows into journal and one into balances. */
function withRaw(): LensWalkModel {
  const m = coarseOnly()
  return {
    ...m,
    nodes: [...m.nodes, ...['focus.c0', 'focus.c1', 'journal.a', 'journal.b', 'balances.a'].map(wnode)],
    lineageEdges: [...m.lineageEdges, raw('focus.c0', 'journal.a', 1), raw('focus.c1', 'journal.a', 2), raw('focus.c1', 'journal.b', 3), raw('focus.c0', 'balances.a', 4)],
    containmentEdges: [...m.containmentEdges, has('focus', 'focus.c0'), has('focus', 'focus.c1'), has('journal', 'journal.a'), has('journal', 'journal.b'), has('balances', 'balances.a')],
    downstreamUrns: new Set(['journal.a', 'journal.b', 'balances.a']),
  }
}

const walk = (model: LensWalkModel): WalkEntry => ({ model, status: 'done', error: null, extendStatus: new Map(), depth: 1 })
const progress = (phase: WalkProgress['phase'], nodes: number): WalkProgress => ({ phase, nodes, flows: 0, requests: 2, pending: phase === 'done' ? 0 : 1, unbounded: false, error: null })

function renderLens(model: LensWalkModel, phase: WalkProgress['phase']) {
  return render(
    <LineageLens
      history={{ entries: ['focus'], cursor: 0 }}
      walk={walk(model)}
      walkApi={{ extend: vi.fn(), page: vi.fn(), retry: vi.fn() }}
      walkProgress={progress(phase, model.nodes.length)}
      fullWalkEnabled={false}
      onFullWalkToggle={vi.fn()}
      onRecenter={vi.fn()}
      onBack={vi.fn()}
      onForward={vi.fn()}
      onClose={vi.fn()}
    />,
  )
}
const nodeText = (label: string) => [...document.querySelectorAll('.react-flow__node')].find(n => n.textContent?.includes(label))?.textContent ?? null

describe('LineageLens — the coarse first paint', () => {
  beforeEach(() => { usePreferencesStore.setState({ lensInitialDepth: 1, lensDensity: 'all' }) })
  afterEach(() => { cleanup(); usePreferencesStore.setState({ lensDensity: 'grouped' }) })

  it('draws the partner tables from the cells alone, each ≈ its weight, under their database — the department and domain are chrome', () => {
    renderLens(coarseOnly(), 'seeding')
    expect(nodeText('journal')).toMatch(/≈30/)
    expect(nodeText('balances')).toMatch(/≈10/)
    expect(nodeText('ledger_db')).not.toBeNull()            // the frame the tables sit in
    // The focal's orientation reads the coarse partners as a floor — never "feeds nothing".
    expect(nodeText('focus')).not.toMatch(/feeds nothing downstream/)
    expect(nodeText('focus')).toMatch(/feeds ≈2 consumers/)
    // Residual 0: chrome (a breadcrumb on other cards), never a card of their own.
    const ownCard = (label: string) => [...document.querySelectorAll('.react-flow__node')].some(n => (n.textContent ?? '').startsWith(label))
    expect(ownCard('dept')).toBe(false)
    expect(ownCard('domain')).toBe(false)
  })

  it('once the raw pages land and the walk is done, every ≈ is gone and the counts are the raw hops', () => {
    renderLens(withRaw(), 'done')
    const all = [...document.querySelectorAll('.react-flow__node')].map(n => n.textContent ?? '').join(' | ')
    expect(all).not.toMatch(/≈/)
    // The rows are real tables now (their columns loaded): counts from the raw hops.
    expect(nodeText('journal')).toMatch(/2 on this lineage/)     // journal.a, journal.b
    expect(nodeText('balances')).toMatch(/1 on this lineage/)
  })
})

/**
 * A container focus whose contents feed EACH OTHER (SILVER → GOLD inside the
 * platform) has partners on its direction sets that sit inside itself. They
 * are internal flows — drawn in the gutter, counted on the focus — and
 * never "sources": the focal used to say "Fed by 11 sources" over an empty
 * upstream band (the Snowflake screenshot, 2026-08-22).
 */
describe('LineageLens — internal flows are not sources', () => {
  beforeEach(() => { usePreferencesStore.setState({ lensInitialDepth: 1, lensDensity: 'all' }) })
  afterEach(() => { cleanup(); usePreferencesStore.setState({ lensDensity: 'grouped' }) })

  it('the focal reads no upstream sources when every upstream partner is inside the focus', () => {
    const model: LensWalkModel = {
      focusUrn: 'plat',
      nodes: ['plat', 'SILVER', 'GOLD', 's1', 'g1'].map(wnode),
      lineageEdges: [raw('s1', 'g1', 1)],
      containmentEdges: [has('plat', 'SILVER'), has('plat', 'GOLD'), has('SILVER', 's1'), has('GOLD', 'g1')],
      upstreamUrns: new Set(['s1']), downstreamUrns: new Set(['g1']),
      frontierUp: [], frontierDown: [], truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
    }
    renderLens(model, 'done')
    const focal = nodeText('plat')!
    expect(focal).not.toMatch(/Fed by \d/)
    expect(focal).not.toMatch(/feeds \d/)
    expect(focal).toMatch(/No upstream sources/)
  })
})

