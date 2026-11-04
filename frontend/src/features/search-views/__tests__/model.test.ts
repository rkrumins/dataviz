/**
 * Subset views' pure model: what can be kept, the layers a subset shows (the
 * server's rules, mirrored), the request saving one becomes, and the words for a
 * layer's matches.
 */
import { describe, expect, it } from 'vitest'

import type { Predicate } from '@/types/search'
import { REST_LAYER_ID } from '@/types/searchView'

import {
  asOfText,
  cappedText,
  combinedWith,
  feedCountText,
  keptInclude,
  layerPredicate,
  layersLike,
  nameFrom,
  ownLayersFrom,
  includeWords,
  liveFromNarrowing,
  perTypeLayers,
  requestOf,
  unsaveableReason,
  withInclude,
} from '../model'

const P = { kind: 'tag', values: ['pii'] } as unknown as Predicate
const BOARD = [
  { id: 's', name: 'Silver', order: 1, entityTypes: ['Dataset', 'dashboard'] },
  { id: 'b', name: 'Bronze', order: 0, color: '#a', entityTypes: ['dataset', 'table'] },
]

describe('unsaveableReason', () => {
  it('keeps a search asked of one entity at a time', () => {
    expect(unsaveableReason(P)).toBeNull()
  })
  it.each([
    [{ kind: 'layer', layerAssignment: 'Gold' }, 'filter by layer'],
    [{ kind: 'group', op: 'and', children: [{ kind: 'related', axis: 'parent', where: { kind: 'layer', layerAssignment: 'x' } }] }, 'filter by layer'],
    [{ kind: 'group', op: 'and', children: [{ kind: 'edges' }] }, 'connections'],
    [{ kind: 'withinHops', urns: ['u'], hops: 2 }, 'route'],
    [{ kind: 'related', axis: 'upstream', maxHops: 2, where: P }, 'more than one step'],
  ])('says why it can’t keep %j', (predicate, words) => {
    expect(unsaveableReason(predicate as unknown as Predicate)?.toLowerCase()).toContain(words.toLowerCase())
  })
  it('keeps one step of lineage, and containment at any depth', () => {
    // What the server keeps too: each is asked of one entity at a time.
    for (const predicate of [
      { kind: 'related', axis: 'downstream', where: P },
      { kind: 'related', axis: 'upstream', maxHops: 1, where: P },
      { kind: 'related', axis: 'ancestor', maxHops: 20, where: P },
      { kind: 'related', axis: 'descendant', where: P },
    ]) expect(unsaveableReason(predicate as unknown as Predicate)).toBeNull()
  })
  it('asks for a search first', () => {
    expect(unsaveableReason(null)).toMatch(/search first/)
  })
})

describe('layersLike', () => {
  it('gives each type one owner, the first in board order, and adds the rest', () => {
    const layers = layersLike(BOARD)
    expect(layers.map((l) => [l.id, l.entityTypes])).toEqual([
      ['b', ['dataset', 'table']], ['s', ['dashboard']], [REST_LAYER_ID, []],
    ])
    expect(layers[2]).toMatchObject({ rest: true, name: 'Other matches', excludedTypes: ['dataset', 'table', 'dashboard'] })
  })
  it('takes the board’s own fallback layer as the rest', () => {
    const layers = layersLike([{ id: 'a', entityTypes: ['t'] }, { id: 'u', name: 'Unplaced', showUnassigned: true, entityTypes: ['v'] }])
    expect(layers.map((l) => l.id)).toEqual(['a', 'u'])
    expect(layers[1].excludedTypes).toEqual(['t'])
  })
  it('counts a layer as its types, and the rest as every other type', () => {
    const [bronze, , rest] = layersLike(BOARD)
    expect(layerPredicate(P, bronze)).toEqual({ kind: 'group', op: 'and', children: [P, { kind: 'entityType', op: 'in', values: ['dataset', 'table'] }] })
    expect((layerPredicate(P, rest) as unknown as { children: unknown[] }).children[1])
      .toEqual({ kind: 'entityType', op: 'notIn', values: ['dataset', 'table', 'dashboard'] })
    expect(layerPredicate(P, { ...bronze, entityTypes: [] })).toBeNull()
    expect(layerPredicate(P, layersLike([])[0])).toBe(P)
  })
})

describe('layouts', () => {
  it('copies a board as an own layout', () => {
    expect(ownLayersFrom(layersLike(BOARD))).toEqual({
      layers: [{ name: 'Bronze', color: '#a', entityTypes: ['dataset', 'table'] }, { name: 'Silver', entityTypes: ['dashboard'] }],
      rest: 'Other matches',
    })
  })
  it('makes a layer per type found, most common first, at most twelve', () => {
    const found = Array.from({ length: 14 }, (_, i) => ({ type: `t${i}`, count: i }))
    const { layers, rest } = perTypeLayers(found, (t) => t.toUpperCase())
    expect(layers).toHaveLength(12)
    expect(layers[0]).toEqual({ name: 'T13', entityTypes: ['t13'] })
    expect(layers.some((l) => l.entityTypes[0] === 't0')).toBe(false)
    expect(rest).toBe('Other matches')
  })
})

describe('requestOf', () => {
  const ctx = { workspaceId: 'ws', dataSourceId: 'ds', viewId: 'base', predicate: P, baseLayers: BOARD,
    typeCounts: [{ type: 'table', count: 3 }] }
  const choices = { name: '  PII  ', visibility: 'workspace' as const, within: 'view' as const, choice: 'like' as const }

  it('follows the base for a subset of a view', () => {
    expect(requestOf(choices, ctx)).toEqual({
      name: 'PII', visibility: 'workspace', workspaceId: 'ws', dataSourceId: 'ds', predicate: P,
      within: 'view', readIn: 'base', layout: 'inherit', provenance: { origin: 'search', viewId: 'base' },
    })
  })
  it('copies the base’s layers for a search of the whole data source', () => {
    const body = requestOf({ ...choices, within: 'dataSource' }, ctx)
    expect(body.readIn).toBeUndefined()
    expect(body.layout).toBe('own')
    expect(body.layers?.map((l) => l.name)).toEqual(['Bronze', 'Silver'])
  })
  it('a layer per type, or one layer', () => {
    expect(requestOf({ ...choices, choice: 'perType' }, ctx)).toMatchObject({
      layout: 'own', layers: [{ name: 'table', entityTypes: ['table'] }], rest: 'Other matches' })
    expect(requestOf({ ...choices, choice: 'one' }, ctx)).toMatchObject({ layout: 'own', layers: [], rest: 'Matches' })
  })
  it('inside a subset view keeps both searches against the same base', () => {
    const subset = { v: 1 as const, predicate: P, within: 'view' as const, readIn: 'the-base', layout: 'inherit' as const,
      provenance: { origin: 'search' as const } }
    const q = { kind: 'entityType', values: ['table'] } as unknown as Predicate
    expect(combinedWith(subset, q, 'sub')).toEqual({
      predicate: { kind: 'group', op: 'and', children: [P, q] }, baseViewId: 'the-base' })
    expect(combinedWith(null, q, 'v')).toEqual({ predicate: q, baseViewId: 'v' })
  })
  it('names it from the search’s words', () => {
    expect(nameFrom('  Tagged   pii ')).toBe('Tagged pii')
    expect(nameFrom('')).toBe('Search results')
    expect(nameFrom('x'.repeat(100))).toHaveLength(80)
  })
})

describe('words for a layer', () => {
  it('counts', () => {
    expect(feedCountText({ delivered: 1200, total: 80412, status: 'complete', countStatus: 'exact' })).toBe('1,200 of 80,412')
    expect(feedCountText({ delivered: 30, total: 30, status: 'complete', countStatus: 'exact' })).toBe('30')
    expect(feedCountText({ delivered: 200, total: 950, status: 'running', countStatus: 'lowerBound' })).toBe('950 so far')
  })
  it('as of, and capped', () => {
    expect(asOfText('2026-11-03T10:42:00Z')).toMatch(/^as of /)
    expect(asOfText(null)).toBeNull()
    expect(cappedText(2000, 80412)).toBe('Showing 2,000 of 80,412')
  })
})

describe('describePredicate', () => {
  it('says the conditions people build most', async () => {
    const { describePredicate } = await import('../model')
    const q = { kind: 'group', op: 'and', children: [
      { kind: 'entityType', values: ['table'] },
      { kind: 'tag', values: ['pii', 'gdpr'] },
      { kind: 'property', key: 'owner', op: 'eq', value: 'finance' },
    ] } as unknown as Predicate
    expect(describePredicate(q, (t) => `${t}s`)).toBe('tables and tagged pii or gdpr and owner is finance')
    expect(describePredicate({ kind: 'group', op: 'not', children: [{ kind: 'isOrphan' }] } as unknown as Predicate))
      .toBe('not with no lineage')
    expect(describePredicate({ kind: 'mystery' } as unknown as Predicate)).toBe('a search')
    expect(describePredicate(null)).toBe('a search')
  })
})


describe('what a subset keeps beside its matches', () => {
  it('is composed as the server composes it', () => {
    const REACH = { kind: 'group', op: 'or', children: [P, { kind: 'related', axis: 'ancestor', where: P }] }
    expect(withInclude(P, null)).toBe(P)
    expect(withInclude(P, { contents: true, containers: true, upstream: true, downstream: true })).toEqual({
      kind: 'group', op: 'or', children: [
        P,
        { kind: 'related', axis: 'ancestor', where: P },
        { kind: 'related', axis: 'descendant', where: P },
        // A lineage step from a match or anything inside it, as a trace walks a container.
        { kind: 'related', axis: 'downstream', where: REACH },
        { kind: 'related', axis: 'upstream', where: REACH },
      ],
    })
  })
  it('says it in words', () => {
    expect(includeWords(null)).toBe('')
    expect(includeWords({ contents: true, containers: false, upstream: false, downstream: false })).toBe('everything inside them')
    expect(includeWords({ contents: true, containers: true, upstream: true, downstream: false }))
      .toBe('everything inside them, what contains them and what feeds them')
  })

  const NONE = { contents: false, containers: false, upstream: false, downstream: false }

  it('keeps a number of levels, and only some kinds, as the server composes them', () => {
    const inside = { kind: 'related', axis: 'ancestor', where: P, maxHops: 2 }
    expect(withInclude(P, { ...NONE, contents: true, contentsLevels: 2, containers: true, containersLevels: 1 }))
      .toEqual({ kind: 'group', op: 'or', children: [P, inside, { kind: 'related', axis: 'descendant', where: P, maxHops: 1 }] })
    // Of the kinds named — a set, sorted as the server keeps it — the kind first, so another kind is never walked.
    expect(withInclude(P, { ...NONE, contents: true, contentsLevels: 2, contentsKinds: ['column', 'Column', 'table', 'column'] }))
      .toEqual({ kind: 'group', op: 'or', children: [P, { kind: 'group', op: 'and', children: [
        { kind: 'entityType', op: 'in', values: ['Column', 'column', 'table'] }, inside] }] })
    expect(withInclude(P, { ...NONE, containers: true, containersKinds: ['database'] }))
      .toEqual({ kind: 'group', op: 'or', children: [P, { kind: 'group', op: 'and', children: [
        { kind: 'entityType', op: 'in', values: ['database'] }, { kind: 'related', axis: 'descendant', where: P }] }] })
  })
  it('asks every level, and every kind, by leaving them out', () => {
    // Never maxHops 20 for every level: the same search as one made before levels.
    expect(withInclude(P, { ...NONE, contents: true, contentsKinds: [] }))
      .toStrictEqual({ kind: 'group', op: 'or', children: [P, { kind: 'related', axis: 'ancestor', where: P }] })
    // Levels and kinds count only while their choice is on.
    expect(withInclude(P, { ...NONE, contentsLevels: 2, containersKinds: ['db'], upstream: true }))
      .toEqual(withInclude(P, { ...NONE, upstream: true }))
  })
  it('says how far in words, and of what kinds', () => {
    expect(includeWords({ ...NONE, contents: true, contentsLevels: 2, containers: true, containersKinds: ['database'] }))
      .toBe('two levels inside them and what contains them (only database)')
    expect(includeWords({ ...NONE, containers: true, containersLevels: 1, downstream: true }))
      .toBe('what contains them, one level up and what they feed')
    expect(includeWords({ ...NONE, contents: true, contentsLevels: 3 })).toBe('three levels inside them')
    expect(includeWords({ ...NONE, contents: true, contentsLevels: 7 })).toBe('7 levels inside them')
    expect(includeWords({ ...NONE, contents: true, contentsKinds: ['table', 'column'] }, (t) => t.toUpperCase()))
      .toBe('everything inside them (only COLUMN or TABLE)')
    expect(includeWords({ ...NONE, contentsLevels: 2, upstream: true })).toBe('what feeds them')
  })
  it('sends what the server keeps: levels and kinds with their choice, kinds a set, nothing unset', () => {
    expect(keptInclude({ ...NONE, contents: true, contentsLevels: 2, contentsKinds: ['table', 'column', 'table'],
      containersLevels: 3, containersKinds: ['db'], upstream: true }))
      .toStrictEqual({ contents: true, contentsLevels: 2, contentsKinds: ['column', 'table'], containers: false,
        upstream: true, downstream: false })
    expect(keptInclude({ ...NONE, containers: true, containersLevels: undefined, containersKinds: [] }))
      .toStrictEqual({ contents: false, containers: true, upstream: false, downstream: false })
    const ctx = { workspaceId: 'ws', viewId: 'base', predicate: P, baseLayers: BOARD, typeCounts: [] }
    expect(requestOf({ name: 'x', visibility: 'private', within: 'view', choice: 'like',
      include: { ...NONE, contentsLevels: 2, containers: true, containersLevels: 1 } }, ctx).include)
      .toStrictEqual({ contents: false, containers: true, containersLevels: 1, upstream: false, downstream: false })
  })
  it('goes with the request, as do the layers left out', () => {
    const ctx = { workspaceId: 'ws', viewId: 'base', predicate: P, baseLayers: BOARD, typeCounts: [
      { type: 'table', count: 3 }, { type: 'column', count: 9 }] }
    const include = { contents: true, containers: false, upstream: false, downstream: false }
    const following = requestOf({ name: 'x', visibility: 'private', within: 'view', choice: 'like', include,
      hidden: ['s', REST_LAYER_ID] }, ctx)
    expect(following).toMatchObject({ layout: 'inherit', include, hiddenLayers: ['s', REST_LAYER_ID] })
    // An own layout leaves nothing out: a left-out type would land in "Other matches".
    const perType = requestOf({ name: 'x', visibility: 'private', within: 'view', choice: 'perType',
      hidden: ['layer-1', REST_LAYER_ID] }, ctx)
    expect(perType).toMatchObject({ layout: 'own', rest: 'Other matches' })
    expect(perType.layers?.flatMap((l) => l.entityTypes)).toEqual(['column', 'table'])
    expect(perType).not.toHaveProperty('hiddenLayers')
    const copied = requestOf({ name: 'x', visibility: 'private', within: 'dataSource', choice: 'like', hidden: ['b'] }, ctx)
    expect(copied.layers?.map((l) => l.name)).toEqual(['Bronze', 'Silver'])
    expect(copied).not.toHaveProperty('hiddenLayers')
  })
})

describe('a narrowing kept live', () => {
  const spec = (over: Record<string, unknown> = {}, expand: Record<string, unknown> = {}) => ({
    v: 1 as const, seeds: { query: P }, within: 'view' as const,
    expand: { children: 0, upstream: 0, downstream: 0, partnerChildren: 0, ...expand }, ...over,
  }) as never

  it('is its search and what it reaches, when a live view can reach it', () => {
    expect(liveFromNarrowing(spec({}, { children: 'all', upstream: 1 }))).toEqual({
      predicate: P, within: 'view',
      include: { contents: true, containers: false, upstream: true, downstream: false },
    })
  })
  it.each([
    [1, { contents: true, contentsLevels: 1 }],
    [2, { contents: true, contentsLevels: 2 }],
    ['all', { contents: true }],
    [0, { contents: false }],
  ])('keeps %s levels inside them live', (children, kept) => {
    const out = liveFromNarrowing(spec({}, { children }))
    expect('include' in out && out.include)
      .toStrictEqual({ containers: false, upstream: false, downstream: false, ...kept })
  })
  it.each([
    ['chosen entities', spec({ seeds: { urns: ['u'] } }), 'chosen entities'],
    ['two steps of lineage', spec({}, { downstream: 2 }), 'more than one step'],
    ['what is inside its sources', spec({}, { upstream: 1, partnerChildren: 1 }), 'sources and consumers'],
  ])('is kept as a list for %s, and says why', (_what, s, words) => {
    const out = liveFromNarrowing(s)
    expect('reason' in out && out.reason).toContain(words)
  })
})
