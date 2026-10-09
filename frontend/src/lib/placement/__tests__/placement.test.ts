import { describe, expect, it, vi } from 'vitest'
import type { GraphNode } from '@/providers/GraphDataProvider'
import {
  compilePlacementSpec, factsFromCanvasData, factsFromGraphNode, isMember, matchRule, parentContextOf, place, placeAll,
  suggestPlacement,
  type CompiledPlacementSpec, type ParentContext, type PlacementFacts, type PlacementResult,
} from '../placement'

const layer = (id: string, order: number, extra: Record<string, unknown> = {}) => ({ id, name: id, order, entityTypes: [], ...extra })

const view = (layers: unknown[], opts: { scope?: 'all' | 'curated'; assignments?: Record<string, unknown> } = {}) => ({
  content: opts.scope ? { entityScope: opts.scope } : {},
  layout: { referenceLayout: { layers, assignments: opts.assignments ?? {} } },
})

const spec = (layers: unknown[], opts?: Parameters<typeof view>[1]) => compilePlacementSpec(view(layers, opts))

const facts = (urn: string, entityType = '', extra: Partial<PlacementFacts> = {}): PlacementFacts =>
  ({ urn, entityType, tags: [], properties: {}, ...extra })

/** The agreed output: the internal cascade dropped. */
const out = ({ cascade: _cascade, ...p }: PlacementResult) => p

const placed = (s: CompiledPlacementSpec, f: PlacementFacts, parents: ParentContext[] = [], createdInBranch = false) =>
  out(place(s, f.urn, f, parents, createdInBranch))

/** placeAll over [parent, child] edges; the output per URN. */
function placeGraph(s: CompiledPlacementSpec, nodes: PlacementFacts[], edges: [string, string][], createdInBranch?: Set<string>) {
  const byUrn = new Map(nodes.map((n) => [n.urn, n]))
  const result = placeAll(s, byUrn.keys(), (u) => byUrn.get(u) ?? null,
    (u) => edges.filter(([, c]) => c === u).map(([p]) => p), createdInBranch)
  return Object.fromEntries([...result].map(([u, p]) => [u, out(p)]))
}

const hand = (urn: string, layerId: string): ParentContext => ({ urn, layerId, cascade: 'hand' })
const soft = (urn: string, layerId: string): ParentContext => ({ urn, layerId, cascade: 'soft' })

describe('compilePlacementSpec', () => {
  it('sorts layers by order, then array position, and drops ones without a record and an id', () => {
    const s = spec([
      layer('b', 1, { entityTypes: ['t'] }), 'junk', { name: 'no id', order: -5 }, layer('', -1),
      layer('z', 'late' as never, { entityTypes: ['t'] }), layer('a', 0, { entityTypes: ['t'] }), layer('c', 1, { entityTypes: ['t'] }),
    ])
    expect([...s.layerIds]).toEqual(['z', 'a', 'b', 'c'])   // a non-numeric order counts as 0: z ties with a, first by position
    expect(s.firstLayerId).toBe('z')
    expect(s.rules.map((r) => r.id)).toEqual(['_type_z_t', '_type_a_t', '_type_b_t', '_type_c_t'])
  })

  it('reads the legacy top-level referenceLayout only when layout.referenceLayout is absent', () => {
    const legacy = { referenceLayout: { layers: [layer('old', 0)] } }
    expect([...compilePlacementSpec(legacy).layerIds]).toEqual(['old'])
    expect([...compilePlacementSpec({ ...legacy, layout: { referenceLayout: { layers: [layer('new', 0)] } } }).layerIds])
      .toEqual(['new'])
    expect(compilePlacementSpec(null).layerIds.size).toBe(0)
  })

  it('keys a legacy entityAssignments entry with urn "" by its entityId, as the server does', () => {
    const s = compilePlacementSpec({ layout: { referenceLayout: {
      layers: [layer('a', 0, { entityAssignments: [{ urn: '', entityId: 'x', inheritsChildren: false }] })],
    } } })
    expect(s.scope).toBe('curated')
    expect(s.explicit.get('x')).toMatchObject({ layerId: 'a', inheritsChildren: false })
  })

  it('treats an entry with a blank layerId as absent and keeps one naming a gone layer as stale', () => {
    const s = spec([layer('a', 0, { entityTypes: ['t'] })], {
      scope: 'all', assignments: { blank: { layerId: '' }, gone: { layerId: 'gone' }, kept: { layerId: 'a' } },
    })
    expect([...s.explicit.keys()]).toEqual(['gone', 'kept'])
    expect(placed(s, facts('blank', 't'))).toEqual({ layerId: 'a', source: 'rule', ruleId: '_type_a_t' })
    expect(placed(s, facts('gone', 't'))).toEqual({ layerId: 'a', source: 'rule', ruleId: '_type_a_t', staleExplicit: true })
  })

  it('takes the fallback from the first layer by order with showUnassigned === true', () => {
    const s = spec([layer('c', 2, { showUnassigned: true }), layer('a', 0, { showUnassigned: 'yes' }), layer('b', 1, { showUnassigned: true })])
    expect(s.fallbackLayerId).toBe('b')
    expect(spec([layer('a', 0)]).fallbackLayerId).toBeNull()
  })

  it('knows whether any valid entry cascades', () => {
    expect(spec([layer('a', 0)], { assignments: { x: { layerId: 'a', inheritsChildren: false } } }).hasCascadingExplicit).toBe(false)
    expect(spec([layer('a', 0)], { assignments: { x: { layerId: 'gone' } } }).hasCascadingExplicit).toBe(false)
    expect(spec([layer('a', 0)], { assignments: { x: { layerId: 'a' } } }).hasCascadingExplicit).toBe(true)
  })
})

describe('rule order', () => {
  it('sorts by priority (missing or non-numeric = 0), then layer order, array position and rule index', () => {
    const s = spec([
      layer('b', 1, { rules: [{ id: 'high', priority: 5, entityTypes: ['t'] }, { priority: 0, tags: ['x'] }] }),
      layer('a', 0, {
        entityTypes: ['t', 't', 'T'],
        rules: [
          { id: 'neg', priority: -1, entityTypes: ['t'] },
          { id: 'missing', entityTypes: ['t'] },
          { id: 'text', priority: '9', entityTypes: ['t'] },
        ],
      }),
    ])
    expect(s.rules.map((r) => r.id)).toEqual(['high', 'missing', 'text', '_type_a_t', '_type_a_T', '_rule_b_1', 'neg'])
  })

  it('lets the first layer win a duplicated type, whatever the array order', () => {
    const s = spec([layer('b', 1, { entityTypes: ['dataset'] }), layer('a', 0, { entityTypes: ['Dataset'] })])
    expect(placed(s, facts('x', 'dataset'))).toEqual({ layerId: 'a', source: 'rule', ruleId: '_type_a_Dataset' })
  })

  it('lets a higher authored priority win across layers', () => {
    const s = spec([
      layer('a', 0, { rules: [{ id: 'r1', priority: 5, entityTypes: ['dataset'] }] }),
      layer('b', 1, { rules: [{ id: 'r2', priority: 9, entityTypes: ['dataset'] }] }),
    ])
    expect(matchRule(s, facts('x', 'dataset'))?.id).toBe('r2')
  })
})

describe('inert rules', () => {
  it('records why a rule can never match, and lets it claim nothing', () => {
    const s = spec([
      layer('a', 0, {
        rules: [
          { urnPattern: '', entityTypes: [], tags: [''], priority: 9 },
          { id: 'empty-text', priority: 9, propertyMatch: { field: 'owner', operator: 'contains', value: '' } },
          { id: 'odd-op', priority: 9, conditions: [{ field: 'owner', operator: 'matches', value: 'x' }] },
          { id: 'no-value', priority: 9, entityTypes: ['t'], conditions: [{ field: 'owner', operator: 'equals' }] },
        ],
      }),
      layer('b', 1, { entityTypes: ['t'] }),
    ])
    expect(s.inert).toEqual([
      { layerId: 'a', ruleId: '_rule_a_0', reason: 'has no criteria, so it can never place anything' },
      { layerId: 'a', ruleId: 'empty-text', reason: "cannot compare 'owner': type some text to look for" },
      { layerId: 'a', ruleId: 'odd-op', reason: "uses an unknown operator 'matches'" },
      { layerId: 'a', ruleId: 'no-value', reason: "cannot compare 'owner': enter a value" },
    ])
    expect(placed(s, facts('x', 't', { properties: { owner: 'x' } }))).toEqual({ layerId: 'b', source: 'rule', ruleId: '_type_b_t' })
  })

  it('treats a blank or non-string condition field as an absent condition', () => {
    const s = spec([layer('a', 0, {
      rules: [
        { id: 'blank-only', priority: 1, propertyMatch: { field: '', operator: 'contains', value: '' } },
        { id: 'typed', priority: 1, entityTypes: ['t'], conditions: [{ field: '', operator: 'nope' }, { field: 7, value: 'x' }] },
      ],
    })])
    expect(s.inert.map((r) => r.ruleId)).toEqual(['blank-only'])
    expect(matchRule(s, facts('x', 't'))?.id).toBe('typed')
  })
})

describe('matching', () => {
  const rules = (...r: Record<string, unknown>[]) => spec([layer('a', 0, { rules: r.map((x, i) => ({ id: `r${i}`, priority: 1, ...x })) })])

  it('folds types, matches tags exactly, and ANDs the criteria', () => {
    expect(matchRule(rules({ entityTypes: ['DataSet'] }), facts('x', 'dataset'))).not.toBeNull()
    expect(matchRule(rules({ tags: ['PII'] }), facts('x', '', { tags: ['pii'] }))).toBeNull()
    const and = rules({ entityTypes: ['table', 'view'], tags: ['pii', 'gdpr'] })
    expect(matchRule(and, facts('x', 'dataset', { tags: ['pii'] }))).toBeNull()
    expect(matchRule(and, facts('x', 'view', { tags: ['gdpr'] }))).not.toBeNull()
    expect(matchRule(and, facts('x', 'view'))).toBeNull()
  })

  it('needs every condition and the propertyMatch', () => {
    const s = rules({ conditions: [{ field: 'owner', operator: 'equals', value: 'finance' }], propertyMatch: { field: 'tier', value: 'gold' } })
    expect(matchRule(s, facts('x', '', { properties: { owner: 'Finance', tier: 'silver' } }))).toBeNull()
    expect(matchRule(s, facts('x', '', { properties: { owner: 'Finance', tier: 'GOLD' } }))).not.toBeNull()
  })

  it('reads name, type and urn from the entity when the user property is null or missing', () => {
    const s = rules({ propertyMatch: { field: 'name', operator: 'contains', value: 'sales' } })
    expect(matchRule(s, facts('urn:x:1', '', { displayName: 'Sales Orders' }))).not.toBeNull()
    expect(matchRule(s, facts('urn:x:1', '', { displayName: 'Sales Orders', properties: { name: null } }))).not.toBeNull()
    expect(matchRule(s, facts('urn:x:1', '', { displayName: 'Sales Orders', properties: { name: 'hr' } }))).toBeNull()
    expect(matchRule(rules({ conditions: [{ field: 'type', operator: 'equals', value: 'Table' }] }), facts('x', 'table'))).not.toBeNull()
    expect(matchRule(rules({ conditions: [{ field: 'urn', operator: 'startsWith', value: 'URN:' }] }), facts('urn:x', ''))).not.toBeNull()
  })

  it('never reads an inherited object key as a property', () => {
    expect(matchRule(rules({ propertyMatch: { field: 'constructor', operator: 'exists' } }), facts('x'))).toBeNull()
  })
})

describe('URN glob', () => {
  const globMatches = (pattern: string, urn: string) =>
    matchRule(spec([layer('a', 0, { rules: [{ id: 'g', priority: 1, urnPattern: pattern }] })]), facts(urn)) !== null

  it('is anchored', () => {
    expect(globMatches('dataset*', 'urn:li:dataset:x')).toBe(false)
    expect(globMatches('urn:li:dataset:*', 'urn:li:dataset:(urn:li:dataPlatform:hive,db.t,PROD)')).toBe(true)
  })

  it('treats every character but * and ? literally, and never fails to compile', () => {
    expect(globMatches('urn:a.*', 'urn:a.b')).toBe(true)
    expect(globMatches('urn:a.*', 'urn:aXb')).toBe(false)
    expect(globMatches('urn:li:dataset:(urn:li:dataPlatform:hive,*', 'urn:li:dataset:(urn:li:dataPlatform:hive,db.t,PROD)')).toBe(true)
    expect(globMatches('a+b*', 'a+bc')).toBe(true)
    expect(globMatches('a+b*', 'aabc')).toBe(false)
    for (const p of ['[x]', 'a|b', '$^', '{1}', 'a}', 'a]', '\\d', '(', ')', '/']) expect(globMatches(p, p)).toBe(true)
    expect(globMatches('\\d', '1')).toBe(false)
  })

  it('reads ? as exactly one code point and * as any run, newlines included', () => {
    expect(globMatches('urn:a?c', 'urn:abc')).toBe(true)
    expect(globMatches('urn:a?c', 'urn:ac')).toBe(false)
    expect(globMatches('urn:a?c', 'urn:abbc')).toBe(false)
    expect(globMatches('x?', 'x😀')).toBe(true)
    expect(globMatches('x?', 'x😀😀')).toBe(false)
    expect(globMatches('a*b', 'ab')).toBe(true)
    expect(globMatches('a*b', 'a\nb')).toBe(true)
    expect(globMatches('a?b', 'a\nb')).toBe(true)
  })

  it('is case-sensitive', () => {
    expect(globMatches('URN:LI:*', 'urn:li:x')).toBe(false)
  })
})

describe('place', () => {
  const ab = (opts?: Parameters<typeof view>[1]) => spec([layer('a', 0, { entityTypes: ['domain'] }), layer('b', 1, { entityTypes: ['table'] })], opts)

  it('puts an own explicit entry before a stamp and a rule', () => {
    const s = ab({ scope: 'all', assignments: { x: { layerId: 'b' } } })
    expect(placed(s, facts('x', 'domain', { stamp: 'a' }))).toEqual({ layerId: 'b', source: 'explicit' })
  })

  it('lets a stale entry fall through, flagged, in both scopes', () => {
    expect(placed(ab({ scope: 'all', assignments: { x: { layerId: 'gone' } } }), facts('x', 'domain')))
      .toEqual({ layerId: 'a', source: 'rule', ruleId: '_type_a_domain', staleExplicit: true })
    expect(placed(ab({ scope: 'curated', assignments: { x: { layerId: 'gone' } } }), facts('x', 'domain')))
      .toEqual({ layerId: null, source: 'none', staleExplicit: true })
    expect(placed(ab({ scope: 'curated', assignments: { x: { layerId: 'gone' } } }), facts('x', 'domain'), [hand('p', 'b')]))
      .toEqual({ layerId: 'b', source: 'inherited', inheritedFrom: 'p', staleExplicit: true })
  })

  it('places by a valid stamp before a rule in an open view', () => {
    expect(placed(ab(), facts('x', 'domain', { stamp: 'b' }))).toEqual({ layerId: 'b', source: 'stamped' })
    expect(placed(ab(), facts('x', 'domain', { stamp: 'B' }))).toEqual({ layerId: 'a', source: 'rule', ruleId: '_type_a_domain' })
  })

  it('in a curated view places only by hand, or an entity created in this draft by its stamp', () => {
    const s = ab({ scope: 'curated', assignments: { y: { layerId: 'a' } } })
    expect(placed(s, facts('x', 'domain', { stamp: 'b' }))).toEqual({ layerId: null, source: 'none' })
    const created = place(s, 'x', facts('x', 'domain', { stamp: 'b' }), [], true)
    expect(out(created)).toEqual({ layerId: 'b', source: 'stamped' })
    // ... and that placement cascades to its children as a hand placement does
    expect(placed(s, facts('c', 'domain'), [parentContextOf('x', created)!]))
      .toEqual({ layerId: 'b', source: 'inherited', inheritedFrom: 'x' })
  })

  it('cascades a hand placement over the child’s own rule', () => {
    expect(placed(ab(), facts('c', 'table'), [hand('p', 'a')])).toEqual({ layerId: 'a', source: 'inherited', inheritedFrom: 'p' })
  })

  it('puts the child’s own rule or stamp before a rule-placed or stamped parent', () => {
    expect(placed(ab(), facts('c', 'table'), [soft('p', 'a')])).toEqual({ layerId: 'b', source: 'rule', ruleId: '_type_b_table' })
    expect(placed(ab(), facts('c', 'x', { stamp: 'b' }), [soft('p', 'a')])).toEqual({ layerId: 'b', source: 'stamped' })
    expect(placed(ab(), facts('c', 'column'), [soft('p', 'a')])).toEqual({ layerId: 'a', source: 'inherited', inheritedFrom: 'p' })
  })

  it('passes on what each tier cascades', () => {
    const s = spec([
      layer('a', 0, { rules: [{ id: 'rp', priority: 1, entityTypes: ['domain'], inheritsFromParent: false }] }),
      layer('b', 1, { entityTypes: ['table'], showUnassigned: true }),
    ], { scope: 'all', assignments: { e: { layerId: 'a' }, g: { layerId: 'a', inheritsChildren: false } } })
    const cascade = (f: PlacementFacts, parents: ParentContext[] = []) => place(s, f.urn, f, parents).cascade
    expect(cascade(facts('e'))).toBe('hand')
    expect(cascade(facts('g'))).toBeNull()
    expect(cascade(facts('c'), [hand('e', 'a')])).toBe('hand')
    expect(cascade(facts('st', '', { stamp: 'a' }))).toBe('soft')
    expect(cascade(facts('t', 'table'))).toBe('soft')
    expect(cascade(facts('d', 'domain'))).toBeNull()   // inheritsFromParent: false
    expect(cascade(facts('c'), [soft('t', 'b')])).toBe('soft')
    expect(cascade(facts('f'))).toBeNull()             // fallback
    expect(place(s, 'f', facts('f'), []).source).toBe('fallback')
  })

  it('answers only the explicit tiers without facts', () => {
    const s = ab({ scope: 'all', assignments: { e: { layerId: 'b' } } })
    expect(out(place(s, 'e', null, []))).toEqual({ layerId: 'b', source: 'explicit' })
    expect(out(place(s, 'u', null, [hand('p', 'a')]))).toEqual({ layerId: 'a', source: 'inherited', inheritedFrom: 'p' })
    expect(out(place(s, 'u', null, [soft('p', 'a')]))).toEqual({ layerId: null, source: 'none' })
  })

  it('picks a hand parent before a soft one, then the smallest URN; ambiguous only across layers', () => {
    expect(placed(ab(), facts('x'), [soft('p1', 'a'), hand('p2', 'b')])).toEqual({ layerId: 'b', source: 'inherited', inheritedFrom: 'p2' })
    expect(placed(ab(), facts('x'), [hand('p2', 'b'), hand('p1', 'a')]))
      .toEqual({ layerId: 'a', source: 'inherited', inheritedFrom: 'p1', ambiguousParent: true })
    expect(placed(ab(), facts('x'), [hand('p2', 'a'), hand('p1', 'a')])).toEqual({ layerId: 'a', source: 'inherited', inheritedFrom: 'p1' })
    expect(placed(ab(), facts('x'), [soft('p2', 'b'), soft('p1', 'a')]))
      .toEqual({ layerId: 'a', source: 'inherited', inheritedFrom: 'p1', ambiguousParent: true })
  })

  it('ignores a parent context naming a layer the view does not have', () => {
    expect(placed(ab(), facts('x'), [hand('p0', 'gone'), hand('p1', 'b')])).toEqual({ layerId: 'b', source: 'inherited', inheritedFrom: 'p1' })
  })

  it('counts explicit, inherited, stamped and rule placements as members, never a fallback', () => {
    expect(isMember({ layerId: 'a', source: 'fallback' })).toBe(false)
    expect(isMember({ layerId: null, source: 'none' })).toBe(false)
    for (const source of ['explicit', 'inherited', 'stamped', 'rule'] as const) expect(isMember({ layerId: 'a', source })).toBe(true)
  })
})

describe('placeAll', () => {
  const s = spec([layer('a', 0, { entityTypes: ['domain'] }), layer('b', 1, { entityTypes: ['table'] })],
    { scope: 'all', assignments: { h1: { layerId: 'b' }, h2: { layerId: 'a' } } })
  const nodes = [facts('h1'), facts('h2'), facts('d', 'domain'), facts('x'), facts('y', 'column'), facts('c1'), facts('c2'), facts('k')]
  const edges: [string, string][] = [['d', 'x'], ['h1', 'x'], ['x', 'y'], ['h2', 'y'], ['c1', 'c2'], ['c2', 'c1'], ['c2', 'k'], ['d', 'c1']]

  it('places parents first and gives the same answer for any input order', () => {
    const expected = placeGraph(s, nodes, edges)
    expect(expected).toEqual({
      h1: { layerId: 'b', source: 'explicit' },
      h2: { layerId: 'a', source: 'explicit' },
      d: { layerId: 'a', source: 'rule', ruleId: '_type_a_domain' },
      x: { layerId: 'b', source: 'inherited', inheritedFrom: 'h1' },                          // hand beats the earlier-URN rule parent
      y: { layerId: 'a', source: 'inherited', inheritedFrom: 'h2', ambiguousParent: true },
      c1: { layerId: 'a', source: 'inherited', inheritedFrom: 'd' },                          // the cycle edge c2 -> c1 is ignored
      c2: { layerId: null, source: 'none' },
      k: { layerId: null, source: 'none' },
    })
    for (let shift = 1; shift < nodes.length; shift++) {
      const rotated = [...nodes.slice(shift), ...nodes.slice(0, shift)]
      expect(placeGraph(s, rotated, edges)).toEqual(expected)
      expect(placeGraph(s, [...rotated].reverse(), [...edges].reverse())).toEqual(expected)
    }
  })

  it('ignores both edges of a cycle, while a child of the cycle still inherits', () => {
    const cyc = spec([layer('a', 0)], { scope: 'curated', assignments: { a1: { layerId: 'a' }, b1: { layerId: 'a' } } })
    expect(placeGraph(cyc, [facts('a1'), facts('b1'), facts('c')], [['a1', 'b1'], ['b1', 'a1'], ['b1', 'c']])).toEqual({
      a1: { layerId: 'a', source: 'explicit' },
      b1: { layerId: 'a', source: 'explicit' },
      c: { layerId: 'a', source: 'inherited', inheritedFrom: 'b1' },
    })
  })

  it('cascades a hand placement through an unplaced parent, and stops at a direct parent’s gate', () => {
    const chain = (assignments: Record<string, unknown>) =>
      placeGraph(spec([layer('a', 0), layer('b', 1)], { scope: 'curated', assignments }), [facts('g'), facts('p'), facts('h')], [['g', 'p'], ['p', 'h']])
    expect(chain({ g: { layerId: 'a' } }).h).toEqual({ layerId: 'a', source: 'inherited', inheritedFrom: 'p' })
    expect(chain({ g: { layerId: 'a' }, p: { layerId: 'b', inheritsChildren: false } }).h).toEqual({ layerId: null, source: 'none' })
    // a stale entry's gate is ignored: p inherits from g and passes it on
    expect(chain({ g: { layerId: 'a' }, p: { layerId: 'gone', inheritsChildren: false } }).h)
      .toEqual({ layerId: 'a', source: 'inherited', inheritedFrom: 'p' })
  })

  it('ignores parents outside the set, self edges and duplicates', () => {
    const r = placeGraph(s, [facts('x'), facts('h2')], [['h1', 'x'], ['x', 'x'], ['h2', 'x'], ['h2', 'x']])
    expect(r.x).toEqual({ layerId: 'a', source: 'inherited', inheritedFrom: 'h2' })
  })

  it('never asks for the facts of an entity placed by hand, or of any entity in a curated view', () => {
    const factsOf = vi.fn((u: string) => facts(u))
    placeAll(s, ['h1', 'x', 'free'], factsOf, (u) => (u === 'x' ? ['h1'] : []))
    expect(factsOf.mock.calls.map(([u]) => u)).toEqual(['free'])

    const curated = spec([layer('a', 0, { entityTypes: ['t'] })], { scope: 'curated', assignments: { e: { layerId: 'a', inheritsChildren: false } } })
    factsOf.mockClear()
    placeAll(curated, ['e', 'c', 'other', 'new'], factsOf, (u) => (u === 'c' ? ['e'] : []), new Set(['new']))
    expect(factsOf.mock.calls.map(([u]) => u)).toEqual(['new'])
  })
})

describe('suggestPlacement', () => {
  const open = spec([layer('a', 0), layer('b', 1, { entityTypes: ['dataset'] }), layer('f', 2, { showUnassigned: true })], { scope: 'all' })
  const curated = spec([layer('a', 0), layer('b', 1, { entityTypes: ['dataset'] })], { scope: 'curated', assignments: { e: { layerId: 'b' } } })

  it.each([
    ['open: the contract places it', open, facts('n', 'dataset'), {}, { layerId: 'b', pin: false }],
    ['open: chosen where the contract places it', open, facts('n', 'dataset'), { chosenLayerId: 'b' }, { layerId: 'b', pin: false }],
    ['open: chosen elsewhere', open, facts('n', 'dataset'), { chosenLayerId: 'a' }, { layerId: 'a', pin: true }],
    ['open: an unknown chosen layer is ignored', open, facts('n', 'dataset'), { chosenLayerId: 'gone', defaultLayerId: 'a' }, { layerId: 'b', pin: false }],
    ['open: unplaced, no default', open, facts('n', 'x'), {}, { layerId: null, pin: false }],
    ['open: unplaced (a fallback is no member), with a default', open, facts('n', 'x'), { defaultLayerId: 'a' }, { layerId: 'a', pin: true }],
    ['open: an unknown default is ignored', open, facts('n', 'x'), { defaultLayerId: 'gone' }, { layerId: null, pin: false }],
    ['curated: what an open view would place, pinned', curated, facts('n', 'dataset'), { defaultLayerId: 'a' }, { layerId: 'b', pin: true }],
    ['curated: unplaced goes to the default', curated, facts('n', 'x'), { defaultLayerId: 'b' }, { layerId: 'b', pin: true }],
    ['curated: unplaced, no default, the first layer', curated, facts('n', 'x'), {}, { layerId: 'a', pin: true }],
    ['curated: chosen wins', curated, facts('n', 'dataset'), { chosenLayerId: 'a' }, { layerId: 'a', pin: true }],
    ['curated: an entity with an entry is pinned again', curated, facts('e', 'x'), {}, { layerId: 'b', pin: true }],
  ])('%s', (_name, s, f, opts, expected) => {
    expect(suggestPlacement(s, f, opts)).toEqual(expected)
  })
})

describe('facts', () => {
  it('maps a GraphNode: a blank name is absent, and the stamp falls back to properties.layerAssignment', () => {
    const node = {
      urn: 'u', entityType: 'table', displayName: '', tags: ['pii', 3], properties: { owner: 'x', layerAssignment: 'b' },
    } as unknown as GraphNode
    expect(factsFromGraphNode(node)).toEqual({
      urn: 'u', entityType: 'table', tags: ['pii'], properties: { owner: 'x', layerAssignment: 'b' }, stamp: 'b',
    })
    expect(factsFromGraphNode({ ...node, layerAssignment: '' }).stamp).toBe('b')
    // a non-empty top-level stamp hides the bag's, even when it names no layer
    expect(factsFromGraphNode({ ...node, layerAssignment: 'gone' }).stamp).toBe('gone')
  })

  it('maps canvas data: the user bag is data.properties, not the data object', () => {
    const data = {
      urn: 'urn:x', label: 'Orders', type: 'dataset', classifications: ['pii'], layerAssignment: undefined,
      properties: { owner: 'finance', layerAssignment: 'a' }, childCount: 3,
    }
    expect(factsFromCanvasData(data, 'id')).toEqual({
      urn: 'urn:x', entityType: 'dataset', displayName: 'Orders', tags: ['pii'],
      properties: { owner: 'finance', layerAssignment: 'a' }, stamp: 'a',
    })
    expect(factsFromCanvasData({ ...data, layerAssignment: 'b' }, 'id').stamp).toBe('b')
    expect(factsFromCanvasData(undefined, 'id')).toEqual({ urn: 'id', entityType: '', tags: [], properties: {} })
  })
})
