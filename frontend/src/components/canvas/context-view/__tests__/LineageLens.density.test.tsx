/**
 * Density (Part H, 2026-08-21) — the reader's own grain for a wide band.
 *
 * The user's case: 200+ partner tables drawn one card each, "so tiny when
 * opened", sharing 18 databases. Three rungs, one preference that follows
 * the reader from lens to lens: Overview lands the databases as closed
 * cards with counts; Grouped (the default) as frames showing their
 * strongest tables; Every card draws every table. Nothing is hidden at any
 * rung — only the grain folds — and the header control writes the
 * preference.
 */
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LineageLens } from '../LineageLens'
import { usePreferencesStore } from '@/store/preferences'
import type { WalkEntry } from '@/hooks/useLensWalk'
import type { LensWalkModel, LensWalkNode } from '../lens/closure-adapter'
import { BUNDLE_WINDOW, OPEN_PARTNERS_PER_BAND } from '../lens/focus-cards'

const wnode = (urn: string): LensWalkNode => ({
  id: urn, type: 'generic', position: { x: 0, y: 0 },
  data: { urn, label: urn, type: 'Node' }, urn, displayName: urn, entityType: 'Node',
}) as unknown as LensWalkNode

/** Domain ⊃ Department ⊃ Database×3 ⊃ Table×8 ⊃ Column — 24 partner tables,
 *  every level the same entity type, hops at column grain. */
function estate(): LensWalkModel {
  const nodes: LensWalkNode[] = []
  const containmentEdges: Array<{ sourceUrn: string; targetUrn: string }> = []
  const lineageEdges: Array<LensWalkModel['lineageEdges'][number]> = []
  const add = (urn: string, parent: string | null) => { nodes.push(wnode(urn)); if (parent) containmentEdges.push({ sourceUrn: parent, targetUrn: urn }) }
  add('domain', null); add('dept', 'domain'); add('focus_db', 'dept'); add('focus', 'focus_db')
  add('focus.c0', 'focus'); add('focus.c1', 'focus')
  let h = 0
  for (let g = 0; g < 3; g++) {
    const db = `database_${g}`
    add(db, 'dept')
    for (let t = 0; t < 8; t++) {
      const table = `${db}.table_${t}`
      add(table, db); add(`${table}.col`, table)
      for (let w = 0; w <= t % 3; w++) {
        lineageEdges.push({ id: `h${h++}`, sourceUrn: `focus.c${w % 2}`, targetUrn: `${table}.col`, edgeType: 'FLOWS_TO', kind: 'raw', weight: null })
      }
    }
  }
  return {
    focusUrn: 'focus', nodes, lineageEdges, containmentEdges,
    upstreamUrns: new Set(), downstreamUrns: new Set(lineageEdges.map(e => e.targetUrn)),
    frontierUp: [], frontierDown: [], truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
  }
}

const doneWalk = (model: LensWalkModel): WalkEntry => ({ model, status: 'done', error: null, extendStatus: new Map(), depth: 1 })

function renderLens() {
  return render(
    <LineageLens
      history={{ entries: ['focus'], cursor: 0 }}
      walk={doneWalk(estate())}
      walkApi={{ extend: vi.fn(), page: vi.fn(), retry: vi.fn() }}
      onRecenter={vi.fn()}
      onBack={vi.fn()}
      onForward={vi.fn()}
      onClose={vi.fn()}
    />,
  )
}

const nodesOnBoard = () => [...document.querySelectorAll('.react-flow__node')].map(n => n.textContent ?? '')
// A table's own node — never its column row (`….table_3.col`), never the database frame above it.
const tablesOnBoard = () => nodesOnBoard().filter(t => /table_\d/.test(t) && !/\.col\b/.test(t) && !/^database_\d(\s|$|·)/.test(t)).length
const databasesOnBoard = () => ['database_0', 'database_1', 'database_2'].filter(db => nodesOnBoard().some(t => t.includes(db))).length

describe('LineageLens — density rungs', () => {
  beforeEach(() => { usePreferencesStore.setState({ lensViewMode: 'graph', lensInitialDepth: 1, lensDensity: 'grouped' }) })
  afterEach(() => { cleanup(); usePreferencesStore.setState({ lensDensity: 'grouped' }) })

  it('Grouped (the default): the three databases are frames showing their strongest tables; the rest is one step away', () => {
    renderLens()
    expect(databasesOnBoard()).toBe(3)
    expect(tablesOnBoard()).toBe(3 * BUNDLE_WINDOW)
    expect(screen.getByRole('button', { name: /^grouped$/i })).toHaveAttribute('aria-pressed', 'true')
  })

  it('Every card: every table is its own card', () => {
    renderLens()
    fireEvent.click(screen.getByRole('button', { name: /every card/i }))
    expect(usePreferencesStore.getState().lensDensity).toBe('all')     // the control writes the preference
    expect(tablesOnBoard()).toBe(24)
  })

  it('Overview: the databases land closed, with counts, and one click opens one', () => {
    renderLens()
    fireEvent.click(screen.getByRole('button', { name: /overview/i }))
    expect(usePreferencesStore.getState().lensDensity).toBe('overview')
    expect(databasesOnBoard()).toBe(3)
    expect(tablesOnBoard()).toBe(0)
    const db = [...document.querySelectorAll('.react-flow__node')].find(n => n.textContent?.includes('database_0'))!
    expect(db.textContent).toMatch(/on this lineage/)
    const open = db.querySelector<HTMLButtonElement>('button[aria-label^="Show what\'s inside"]')
    expect(open, [...db.querySelectorAll('button')].map(b => b.getAttribute('aria-label')).join('|')).toBeTruthy()
    fireEvent.click(open!)
    expect(tablesOnBoard()).toBe(BUNDLE_WINDOW)
  })
})

/** Five partner tables under ONE database — under the card budget, so no
 *  bundle — each with its columns on the lineage. The Tableau screenshot's
 *  shape (2026-08-22): the cost was rows, not cards. */
function fiveTables(): LensWalkModel {
  const nodes: LensWalkNode[] = []
  const containmentEdges: Array<{ sourceUrn: string; targetUrn: string }> = []
  const lineageEdges: Array<LensWalkModel['lineageEdges'][number]> = []
  const add = (urn: string, parent: string | null) => { nodes.push(wnode(urn)); if (parent) containmentEdges.push({ sourceUrn: parent, targetUrn: urn }) }
  add('domain', null); add('dept', 'domain'); add('focus_db', 'dept'); add('focus', 'focus_db'); add('focus.c0', 'focus'); add('focus.c1', 'focus')
  add('db', 'dept')
  let h = 0
  for (let t = 0; t < 5; t++) {
    const table = `db.table_${t}`
    add(table, 'db')
    for (let k = 0; k < 5 - t; k++) {
      add(`${table}.col${k}`, table)
      lineageEdges.push({ id: `h${h++}`, sourceUrn: `focus.c${k % 2}`, targetUrn: `${table}.col${k}`, edgeType: 'FLOWS_TO', kind: 'raw', weight: null })
    }
  }
  return {
    focusUrn: 'focus', nodes, lineageEdges, containmentEdges,
    upstreamUrns: new Set(), downstreamUrns: new Set(lineageEdges.map(e => e.targetUrn)),
    frontierUp: [], frontierDown: [], truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
  }
}

describe('LineageLens — how the partners land (the drill is the reader\'s)', () => {
  beforeEach(() => { usePreferencesStore.setState({ lensViewMode: 'graph', lensInitialDepth: 1, lensDensity: 'grouped' }) })
  afterEach(() => { cleanup(); usePreferencesStore.setState({ lensDensity: 'grouped' }) })

  const renderFive = () => render(
    <LineageLens
      history={{ entries: ['focus'], cursor: 0 }}
      walk={doneWalk(fiveTables())}
      walkApi={{ extend: vi.fn(), page: vi.fn(), retry: vi.fn() }}
      onRecenter={vi.fn()} onBack={vi.fn()} onForward={vi.fn()} onClose={vi.fn()}
    />,
  )
  const columnsOnBoard = () => nodesOnBoard().filter(t => /\.col\d/.test(t)).length

  it('Grouped: the strongest three tables show their columns; the other two land closed, counted, with a chevron', () => {
    renderFive()
    expect(columnsOnBoard()).toBe(5 + 4 + 3)                 // table_0, table_1, table_2
    const closed = [...document.querySelectorAll('.react-flow__node')].find(n => (n.textContent ?? '').startsWith('db.table_4'))!
    expect(closed.textContent).toMatch(/1 on this lineage/)
    expect(closed.querySelector('button[aria-label^="Show what\'s inside"]')).toBeTruthy()
  })

  it('Overview: every table lands closed; one click opens one', () => {
    renderFive()
    fireEvent.click(screen.getByRole('button', { name: /overview/i }))
    expect(columnsOnBoard()).toBe(0)
    const t0 = [...document.querySelectorAll('.react-flow__node')].find(n => (n.textContent ?? '').startsWith('db.table_0'))!
    fireEvent.click(t0.querySelector<HTMLButtonElement>('button[aria-label^="Show what\'s inside"]')!)
    expect(columnsOnBoard()).toBe(5)
  })

  it('Every card: every table shows its columns', () => {
    renderFive()
    fireEvent.click(screen.getByRole('button', { name: /every card/i }))
    expect(columnsOnBoard()).toBe(15)
    expect(OPEN_PARTNERS_PER_BAND).toBe(3)
  })
})

