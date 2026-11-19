import { describe, expect, it } from 'vitest'

import { specFor } from '@/features/narrow/model'
import type { MembershipPlan, MembershipStatus } from '@/types/membership'

import {
  chipText,
  createRequestOf,
  diffText,
  fillingInAfterBusy,
  layoutOffers,
  meterText,
  overLimitHelp,
  planRequestOf,
  seedCapNote,
  sourceOf,
  statusWords,
  workingText,
  type SaveChoices,
} from '../model'

const LIKE: SaveChoices = { choice: 'source', keep: 'withResults', nest: true }
const urnSpec = specFor({ urns: ['urn:a'] }, { children: 1 })
const querySpec = specFor({ query: { kind: 'text', value: 'orders' } as never })

function plan(over: Partial<MembershipPlan> = {}): MembershipPlan {
  return {
    keys: 1321, members: 1234, containers: 87, included: 0, limit: 5000, overCap: false,
    layers: [], fallback: 0, truncated: [], missingSeeds: 0, dataVersion: '', ...over,
  }
}

function status(over: Partial<MembershipStatus> = {}): MembershipStatus {
  return {
    mode: 'live', status: 'ok', revision: 1, definitionHash: 'h', keys: 1321, limit: 5000,
    definition: { v: 1, mode: 'live', sources: [], layout: { kind: 'source' }, exclude: [], overrides: {}, provenance: { origin: 'narrow' } },
    counts: { members: 1234 }, truncated: [], readIn: [], alwaysIncluded: [], excluded: [], ...over,
  }
}

describe('the request a narrowing becomes', () => {
  it('searches a query in the view it was made in, and takes chosen entities as they are', () => {
    expect(sourceOf(querySpec, 'v1')).toEqual({ spec: querySpec, readIn: 'v1' })
    expect(sourceOf(urnSpec, 'v1')).toEqual({ spec: urnSpec })
  })

  it('lays the view out like the one it came from, and sends a template’s fitted layers', () => {
    expect(planRequestOf(urnSpec, 'v1', LIKE).layout).toEqual({ kind: 'source', sourceViewId: 'v1', nest: true })
    const layers = [{ id: 't1', name: 'Tables' }]
    const t = planRequestOf(urnSpec, 'v1', { choice: 'template', keep: 'all', nest: false, templateId: 'tpl', templateLayers: layers })
    expect(t.layout).toEqual({ kind: 'template', templateId: 'tpl', nest: false })
    expect(t.layers).toEqual(layers)
  })

  it('names the view, trims what was typed and records where it came from', () => {
    const req = createRequestOf({
      name: '  Orders tables ', description: ' ', visibility: 'private', mode: 'live', workspaceId: 'ws',
      dataSourceId: 'ds', spec: urnSpec, viewId: 'v1', choices: LIKE, origin: 'narrow',
    })
    expect(req.name).toBe('Orders tables')
    expect(req).not.toHaveProperty('description')
    expect(req.provenance).toEqual({ origin: 'narrow', viewId: 'v1' })
    expect(req.dataSourceId).toBe('ds')
  })

  it('offers lineage stages only for a reach with lineage, and says why not', () => {
    const offers = layoutOffers(urnSpec, 3, true)
    expect(offers.find((o) => o.choice === 'stages')).toMatchObject({ available: false })
    expect(offers.find((o) => o.choice === 'stages')?.reason).toMatch(/sources or consumers/)
    expect(layoutOffers(specFor({ urns: ['a'] }, { upstream: 1 }), 0, false).map((o) => [o.choice, o.available]))
      .toEqual([['source', false], ['template', false], ['auto', true], ['stages', true]])
  })

  it('offers following the view first, as a subset of it — or says why it can’t be', () => {
    const offers = layoutOffers(urnSpec, 3, true, { available: true })
    expect(offers[0]).toEqual({ choice: 'follow', available: true, reason: undefined })
    expect(layoutOffers(urnSpec, 0, true, { available: false, reason: 'No layers of its own' })[0])
      .toMatchObject({ choice: 'follow', available: false, reason: 'No layers of its own' })
    expect(layoutOffers(urnSpec, 3, true).some((o) => o.choice === 'follow')).toBe(false)
  })

  it('a view that follows sends the view it follows, which may be the base of the one it was made in', () => {
    const follow: SaveChoices = { choice: 'follow', keep: 'all', nest: true }
    expect(planRequestOf(urnSpec, 'v1', follow).layout).toEqual({ kind: 'follow', sourceViewId: 'v1', nest: true })
    expect(planRequestOf(urnSpec, 'subset1', { ...follow, layoutViewId: 'base' }).layout)
      .toEqual({ kind: 'follow', sourceViewId: 'base', nest: true })
    // Its query is still read in the view it was made in.
    expect(planRequestOf(querySpec, 'subset1', { ...follow, layoutViewId: 'base' }).sources[0]).toMatchObject({ readIn: 'subset1' })
  })
})

describe('the meter', () => {
  it('adds up what the view would hold against the limit', () => {
    expect(meterText(plan())).toBe('1,234 entities + 87 containers = 1,321 of 5,000')
    expect(meterText(plan({ members: 3, containers: 0, keys: 3 }))).toBe('3 entities of 5,000')
  })

  it('over the limit, says only what would actually help', () => {
    const over = plan({ overCap: true, members: 4900, containers: 300, keys: 5200 })
    const help = overLimitHelp(over, urnSpec, true)
    expect(help[0]).toMatch(/4,900, which fits/)
    expect(help.some((h) => /everything inside/.test(h))).toBe(true)
    expect(overLimitHelp(over, specFor({ urns: ['a'] }, { children: 'all' }), false)).toEqual([
      'Narrow the query, or start from fewer entities.',
    ])
    expect(overLimitHelp(plan(), urnSpec, true)).toEqual([])
  })

  it('says when a search gave only its first matches', () => {
    expect(seedCapNote(plan({ truncated: [{ reason: 'seed_cap', seen: 5001, limit: 5000 }] }))).toMatch(/first 5,000/)
    expect(seedCapNote(plan())).toBeNull()
  })
})

describe('how keeping it is going', () => {
  it('names each state with what to do about it', () => {
    expect(statusWords(status()).label).toBe('Up to date')
    expect(statusWords(status({ status: 'held', detail: { removed: 812, of: 1020 } })).detail)
      .toBe('An update would remove 812 of 1,020. Apply it, or keep the view as it is.')
    expect(statusWords(status({ status: 'over_cap', detail: { keys: 6200, limit: 5000 } })).detail).toMatch(/6,200 entries/)
    expect(statusWords(status({ status: 'pending', detail: { reason: 'short_answer' } })).detail).toMatch(/didn’t answer in full/)
    expect(statusWords(status({ status: 'pending', detail: { reason: 'base_changed' } })).detail).toMatch(/view it follows changed/)
  })

  it('reads the chip as auto-updating with its count, or a snapshot with its date', () => {
    expect(chipText(status())).toBe('Auto-updating · 1,234')
    const snap = chipText(status({ mode: 'snapshot', status: 'frozen', lastAppliedAt: '2026-11-03T10:00:00Z' }), new Date('2026-12-01'))
    expect(snap).toMatch(/^Snapshot · /)
    expect(snap).not.toMatch(/2026/)
  })

  it('a view that follows another says so first, and says when that view is gone', () => {
    const base = { viewId: 'b', name: 'Sales overview', available: true }
    expect(chipText(status({ follows: base, counts: { members: 6 } }))).toBe('Subset of Sales overview · Auto-updating · 6')
    expect(chipText(status({ follows: { ...base, name: null }, counts: { members: 6 } }))).toBe('Subset · Auto-updating · 6')
    expect(chipText(status({ follows: { ...base, available: false }, counts: { members: 6 } })))
      .toBe('Subset · its view is gone · Auto-updating · 6')
    const gone = statusWords(status({ status: 'source_missing', follows: { ...base, available: false } }))
    expect(gone).toMatchObject({ label: 'Its view is gone', tone: 'problem' })
    expect(gone.detail).toMatch(/keeps its members/)
  })

  it('says how far working out its members has got, while it is', () => {
    expect(workingText(status({ status: 'updating', revision: 0, detail: { reason: 'placing', placed: 1200, members: 50_000 } })))
      .toBe('Placing its members… 1,200 of 50,000')
    expect(workingText(status({ status: 'updating', detail: { reason: 'resolving', sets: [{ counts: { total: 41_020 } }] } })))
      .toBe('Working out what it reaches… 41,020 so far')
    expect(workingText(status({ status: 'updating', detail: {} }))).toBeNull()
    expect(workingText(status())).toBeNull()
    expect(statusWords(status({ status: 'updating', revision: 0, detail: {} })).detail).toBe('Working out its members.')
  })

  it('says what an update changed', () => {
    expect(diffText({ added: 3, removed: 1, moved: 0 })).toBe('3 new, 1 left')
    expect(diffText({ added: 0, removed: 0, moved: 0 })).toBe('No changes')
    expect(diffText(null)).toBe('No changes')
  })
})

describe('members on the canvas', () => {
  it('offers to always include or keep out a member, and to hand one back to the query', async () => {
    const { memberActionsFor } = await import('../model')
    expect(memberActionsFor({ assignedBy: 'query' })).toEqual(['include', 'exclude'])
    expect(memberActionsFor({ assignedBy: 'user' })).toEqual(['uninclude', 'exclude'])
    expect(memberActionsFor(undefined)).toEqual([])
  })
})

describe('a first answer that met a busy graph', () => {
  it('reads as filling in, whether the server says updating or (older) pending', () => {
    const busy = (status: string) => ({ mode: 'live', status, revision: 0, detail: { reason: 'graph_busy' } }) as never
    expect(fillingInAfterBusy(busy('updating'))).toBe(true)
    expect(fillingInAfterBusy(busy('pending'))).toBe(true)
    expect(statusWords(busy('pending'))).toMatchObject({ label: 'Updating…', tone: 'busy' })
    expect(workingText(busy('pending'))).toMatch(/graph was busy/)
    expect(fillingInAfterBusy({ mode: 'live', status: 'pending', revision: 3, detail: { reason: 'graph_busy' } } as never)).toBe(false)
  })
})
