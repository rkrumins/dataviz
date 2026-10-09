/**
 * importForm pins the import's lossless promise on the wizard side:
 *   - filling the form from ANY definition and writing it straight back returns that definition,
 *     key for key (so clicking through the wizard changes nothing the file said);
 *   - an edit to one field changes that field and nothing else — display rules, overrides and
 *     keys the wizard has never heard of ride along untouched;
 *   - the wizard's view-wide scope only overwrites the layers' own when it was changed;
 *   - removing a layer removes its placements (the server would refuse orphans).
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  definitionToForm, fieldFiltersToActiveFilters, formToDefinition, formToMetadata, isBuildable, sameJson,
} from '../importForm'

const META = { name: 'Finance lineage', description: 'What feeds revenue', icon: 'Layout', tags: ['finance'], viewType: 'reference' }

const OWNED_TOP = new Set(['layout', 'content', 'filters'])
const OWNED_LAYOUT = new Set(['type', 'referenceLayout'])
const OWNED_RL = new Set(['layers', 'assignments', 'defaultNodeSortMode'])
const OWNED_CONTENT = new Set(['entityScope', 'visibleEntityTypes', 'visibleRelationshipTypes'])
const OWNED_FILTERS = new Set(['fieldFilters'])

/** Extra keys the wizard doesn't own, holding arbitrary JSON. */
function extras(owned: Set<string>) {
  return fc.dictionary(
    fc.string({ minLength: 1, maxLength: 8 }).filter(k => !owned.has(k) && k !== '__proto__'),
    fc.jsonValue({ maxDepth: 3 }),
    { maxKeys: 4 },
  )
}

const layerArb = fc.record({
  id: fc.constantFrom('l1', 'l2', 'l3'),
  name: fc.string({ maxLength: 10 }),
  order: fc.nat({ max: 5 }),
  entityTypes: fc.array(fc.constantFrom('dataset', 'domain', 'dashboard'), { maxLength: 2 }),
  scopeEdges: fc.option(fc.record({ edgeTypes: fc.array(fc.constantFrom('CONTAINS', 'HAS'), { maxLength: 2 }), includeAll: fc.boolean() }), { nil: undefined }),
}).map(({ scopeEdges, ...rest }) => (scopeEdges ? { ...rest, scopeEdges } : rest))

const definitionArb = fc.record({
  layers: fc.uniqueArray(layerArb, { selector: l => l.id, maxLength: 3 }),
  urns: fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }).map(s => `urn:${s}`), { maxLength: 5 }),
  orderKey: fc.boolean(),
  sort: fc.constantFrom(undefined, 'alpha-asc', 'type-asc'),
  scope: fc.constantFrom('all', 'curated'),
  types: fc.array(fc.constantFrom('dataset', 'domain', 'dashboard'), { maxLength: 3 }),
  rels: fc.array(fc.constantFrom('PRODUCES', 'CONTAINS'), { maxLength: 2 }),
  fieldFilters: fc.array(fc.record({
    field: fc.constantFrom('tags', 'name', 'owner'),
    operator: fc.constantFrom('equals', 'contains', 'in'),
    value: fc.string({ maxLength: 5 }),
  }), { maxLength: 2 }),
  top: extras(OWNED_TOP),
  layoutExtra: extras(OWNED_LAYOUT),
  rlExtra: extras(OWNED_RL),
  contentExtra: extras(OWNED_CONTENT),
  filtersExtra: extras(OWNED_FILTERS),
}).map(g => {
  const assignments: Record<string, Record<string, unknown>> = {}
  g.urns.forEach((urn, i) => {
    if (g.layers.length === 0) return
    assignments[urn] = {
      layerId: g.layers[i % g.layers.length].id,
      inheritsChildren: i % 2 === 0,
      ...(g.orderKey ? { orderKey: `a${i}` } : {}),
    }
  })
  return {
    ...g.top,
    layout: {
      ...g.layoutExtra,
      type: 'reference',
      referenceLayout: {
        ...g.rlExtra,
        layers: g.layers,
        assignments,
        ...(g.sort ? { defaultNodeSortMode: g.sort } : {}),
      },
    },
    content: { ...g.contentExtra, entityScope: g.scope, visibleEntityTypes: g.types, visibleRelationshipTypes: g.rels },
    filters: { ...g.filtersExtra, fieldFilters: g.fieldFilters },
  } as Record<string, unknown>
})

describe('importForm', () => {
  it('hands back exactly the definition it was filled from', () => {
    fc.assert(fc.property(definitionArb, definition => {
      const form = definitionToForm(definition, META)
      expect(formToDefinition(definition, form, { ...form })).toEqual(definition)
    }))
  })

  it('changes only what was edited', () => {
    fc.assert(fc.property(definitionArb, fc.array(fc.constantFrom('dataset', 'domain'), { maxLength: 2 }), (definition, types) => {
      const initial = definitionToForm(definition, META)
      const out = formToDefinition(definition, initial, { ...initial, visibleEntityTypes: types })
      const { content: outContent, ...outRest } = out as { content: Record<string, unknown> }
      const { content: inContent, ...inRest } = definition as { content: Record<string, unknown> }
      expect(outRest).toEqual(inRest)
      expect(outContent).toEqual({ ...inContent, visibleEntityTypes: types })
    }))
  })

  it('keeps display rules and unknown layout fields when layers change', () => {
    const definition = {
      layout: {
        type: 'reference',
        referenceLayout: {
          layers: [{ id: 'l1', name: 'Sources', order: 0 }, { id: 'l2', name: 'Marts', order: 1 }],
          assignments: { 'urn:a': { layerId: 'l1', inheritsChildren: true }, 'urn:b': { layerId: 'l2', inheritsChildren: true } },
          displayRules: [{ id: 'hot', op: 'color', value: '#f00' }],
          futureField: { kept: true },
        },
      },
      content: { entityScope: 'curated', visibleEntityTypes: ['dataset'], visibleRelationshipTypes: [] },
    }
    const initial = definitionToForm(definition, META)
    const out = formToDefinition(definition, initial, { ...initial, layers: [initial.layers[0]] })
    const rl = (out.layout as { referenceLayout: Record<string, unknown> }).referenceLayout
    expect(rl.displayRules).toEqual([{ id: 'hot', op: 'color', value: '#f00' }])
    expect(rl.futureField).toEqual({ kept: true })
    expect(rl.layers).toEqual([{ id: 'l1', name: 'Sources', order: 0 }])
    expect(rl.assignments).toEqual({ 'urn:a': { layerId: 'l1', inheritsChildren: true } })
  })

  it("overwrites each layer's scope only when the view-wide scope was changed", () => {
    const definition = {
      layout: {
        type: 'reference',
        referenceLayout: {
          layers: [
            { id: 'l1', name: 'A', order: 0, scopeEdges: { edgeTypes: ['CONTAINS'], includeAll: false } },
            { id: 'l2', name: 'B', order: 1, scopeEdges: { edgeTypes: ['HAS'], includeAll: true } },
          ],
          assignments: {},
        },
      },
    }
    const initial = definitionToForm(definition, META)
    const renamed = formToDefinition(definition, initial, {
      ...initial, layers: initial.layers.map(l => ({ ...l, name: `${l.name}!` })),
    })
    const layers = (renamed.layout as { referenceLayout: { layers: Array<{ scopeEdges: unknown }> } }).referenceLayout.layers
    expect(layers.map(l => l.scopeEdges)).toEqual([
      { edgeTypes: ['CONTAINS'], includeAll: false }, { edgeTypes: ['HAS'], includeAll: true },
    ])
    const rescoped = formToDefinition(definition, initial, {
      ...initial, scopeEdges: { edgeTypes: ['CONTAINS', 'HAS'], includeAll: false },
    })
    const rescopedLayers = (rescoped.layout as { referenceLayout: { layers: Array<{ scopeEdges: unknown }> } }).referenceLayout.layers
    expect(rescopedLayers.every(l => sameJson(l.scopeEdges, { edgeTypes: ['CONTAINS', 'HAS'], includeAll: false }))).toBe(true)
  })

  it('reads metadata and filters the way the wizard shows them', () => {
    const form = definitionToForm({ filters: { fieldFilters: [{ field: 'tags', operator: 'equals', value: 'pii' }] } },
      { ...META, viewType: 'layered-lineage' })
    expect(form.name).toBe('Finance lineage')
    expect(form.layoutType).toBe('reference')
    expect(form.advancedFilters).toEqual(fieldFiltersToActiveFilters([{ field: 'tags', operator: 'equals', value: 'pii' }]))
    expect(isBuildable('layered-lineage')).toBe(false)
    expect(formToMetadata({ ...form, name: '  Renamed ', description: ' ' }, 'reference')).toEqual({
      name: 'Renamed', description: null, icon: 'Layout', tags: ['finance'], viewType: 'reference',
    })
  })
})
