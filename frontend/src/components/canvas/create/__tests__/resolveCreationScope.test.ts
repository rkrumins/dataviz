/**
 * resolveCreationScope — where a layer's "+" (and every other way of adding from a layer, or by
 * type) puts a new entity. Ontology: domain ⊃ {app, dataPlatform}; app ⊃ service; dataPlatform ⊃
 * dataset; glossary is a second top-level type that holds nothing.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  childTypesLookup, resolveCreationScope, SCOPE_CHOICE_LIMIT, type ScopeContext, type ScopeLayer, type ScopeNode,
} from '../resolveCreationScope'
import type { EntityTypeSchema, RelationshipTypeSchema } from '@/types/schema'

const et = (id: string, name: string, canContain: string[], canBeContainedBy: string[], level: number): EntityTypeSchema => ({
  id, name, pluralName: `${name}s`, visual: {} as never, fields: [], behavior: {} as never,
  hierarchy: { level, canContain, canBeContainedBy, defaultExpanded: false, rollUpFields: [] },
})
const entityTypes = [
  et('domain', 'Domain', ['app', 'dataPlatform'], [], 0),
  et('glossary', 'Glossary', [], [], 0),
  et('app', 'App', ['service'], ['domain'], 1),
  et('dataPlatform', 'Data Platform', ['dataset'], ['domain'], 1),
  et('service', 'Service', [], ['app'], 2),
  et('dataset', 'Dataset', [], ['dataPlatform'], 2),
]
const relationshipTypes = [
  { id: 'CONTAINS', name: 'Contains', sourceTypes: [], targetTypes: [], isContainment: true },
] as unknown as RelationshipTypeSchema[]
const hierarchyMap = Object.fromEntries(entityTypes.map((t) => [t.id, t.hierarchy]))
const childTypes = childTypesLookup(entityTypes, ['domain', 'glossary'], hierarchyMap, relationshipTypes, ['CONTAINS'])

const n = (urn: string, typeId: string): ScopeNode => ({ urn, typeId })
const finance = n('finance', 'domain')
const sales = n('sales', 'domain')
const ops = n('ops', 'domain')
const billing = n('billing', 'app')
const terms = n('terms', 'glossary')
const all = [finance, sales, ops, billing, terms]
const layerOfNode: Record<string, string> = { finance: 'domains', sales: 'domains', ops: 'domains', terms: 'domains', billing: 'domains' }

function ctx(over: Partial<ScopeContext> = {}): ScopeContext {
  return {
    node: (id) => all.find((x) => x.urn === id),
    layerOf: (id) => layerOfNode[id],
    layerRoots: [finance, sales, ops, terms],
    childTypes,
    parentsFor: (typeId) => all.filter((x) => childTypes(x.typeId).includes(typeId)),
    ...over,
  }
}

const domains: ScopeLayer = { id: 'domains', entityTypes: ['domain'] }
const anchored: ScopeLayer = { id: 'fin', entityTypes: [], anchorUrn: 'finance' }

describe('resolveCreationScope', () => {
  describe('a layer mapped to a node', () => {
    it('adds inside it, as the first type it can hold', () => {
      const s = resolveCreationScope(anchored, ctx({ layerRoots: [billing] }))
      expect(s).toMatchObject({ kind: 'anchored', parentUrn: 'finance', preferredTypeId: 'app', askParent: false, topLevelTypeId: 'domain' })
      // The anchor first, then the layer's own parents (its rows: the anchor's children).
      expect(s.choices.map((c) => c.urn)).toEqual(['finance', 'billing'])
    })

    it('starts with the type last added inside it', () => {
      const s = resolveCreationScope(anchored, ctx({ layerRoots: [], lastTypeIn: { finance: 'dataPlatform' } }))
      expect(s.preferredTypeId).toBe('dataPlatform')
    })

    it('ignores a remembered type the anchor can no longer hold', () => {
      const s = resolveCreationScope(anchored, ctx({ layerRoots: [], lastTypeIn: { finance: 'dataset' } }))
      expect(s.preferredTypeId).toBe('app')
    })

    it('still adds inside the anchor with something else in the column selected', () => {
      layerOfNode.billing = 'fin'
      try {
        const s = resolveCreationScope(anchored, ctx({ layerRoots: [billing], selectionId: 'billing' }))
        expect(s.parentUrn).toBe('finance')
        expect(s.choices.map((c) => c.urn)).toEqual(['finance', 'billing'])
      } finally { layerOfNode.billing = 'domains' }
    })

    it('a missing anchor: the column is an ordinary one, at the top level as it always was', () => {
      const s = resolveCreationScope({ id: 'gone', entityTypes: [], anchorUrn: 'nowhere' }, ctx({ layerRoots: [], anchorIssue: 'missing' }))
      expect(s).toMatchObject({ kind: 'top-level', parentUrn: null, preferredTypeId: null, askParent: false, choices: [] })
    })

    it('an anchor not loaded yet: the top level, not inside something absent', () => {
      const s = resolveCreationScope({ id: 'later', entityTypes: [], anchorUrn: 'nowhere' }, ctx({ layerRoots: [] }))
      expect(s).toMatchObject({ kind: 'top-level', parentUrn: null })
    })

    it('a duplicate anchor: never inside it — what it adds would land in the other column', () => {
      const s = resolveCreationScope(anchored, ctx({ layerRoots: [], anchorIssue: 'duplicate' }))
      expect(s).toMatchObject({ kind: 'top-level', parentUrn: null })
      expect(s.choices).toEqual([])
    })

    it('an anchor that holds nothing: the top level', () => {
      const s = resolveCreationScope({ id: 'g', entityTypes: [], anchorUrn: 'terms' }, ctx({ layerRoots: [] }))
      expect(s).toMatchObject({ kind: 'top-level', parentUrn: null })
    })
  })

  describe('a layer of several top-level entities', () => {
    it('nothing selected: the top level, as the layer\'s own type — inside one of them one click away', () => {
      const s = resolveCreationScope(domains, ctx())
      expect(s).toMatchObject({ kind: 'top-level', parentUrn: null, preferredTypeId: 'domain', askParent: false, topLevelTypeId: 'domain' })
      // Only those that can hold something.
      expect(s.choices.map((c) => c.urn)).toEqual(['finance', 'sales', 'ops'])
    })

    it('the selection in it can hold children: inside the selection', () => {
      const s = resolveCreationScope(domains, ctx({ selectionId: 'sales' }))
      expect(s).toMatchObject({ kind: 'selection', parentUrn: 'sales', preferredTypeId: null, topLevelTypeId: 'domain' })
      expect(s.choices.map((c) => c.urn)).toEqual(['sales', 'finance', 'ops'])
    })

    it('the selection holds nothing: the top level', () => {
      expect(resolveCreationScope(domains, ctx({ selectionId: 'terms' })).parentUrn).toBeNull()
    })

    it('the selection is in another layer: the top level', () => {
      layerOfNode.sales = 'elsewhere'
      try {
        expect(resolveCreationScope(domains, ctx({ selectionId: 'sales' })).parentUrn).toBeNull()
      } finally { layerOfNode.sales = 'domains' }
    })

    it('a layer of explicit assignments (no types): the top level, any top-level type', () => {
      const s = resolveCreationScope({ id: 'domains', entityTypes: [] }, ctx())
      expect(s).toMatchObject({ kind: 'top-level', parentUrn: null, preferredTypeId: null, topLevelTypeId: null })
      expect(s.choices.map((c) => c.urn)).toEqual(['finance', 'sales', 'ops'])
    })

    it('offers at most SCOPE_CHOICE_LIMIT parents by name', () => {
      const many = Array.from({ length: SCOPE_CHOICE_LIMIT + 10 }, (_, i) => n(`d${i}`, 'domain'))
      expect(resolveCreationScope(domains, ctx({ layerRoots: many })).choices).toHaveLength(SCOPE_CHOICE_LIMIT)
    })
  })

  describe('a layer whose type needs a parent', () => {
    const apps: ScopeLayer = { id: 'apps', entityTypes: ['app'] }

    it('several candidates: asks where it goes, as that type', () => {
      const s = resolveCreationScope(apps, ctx())
      expect(s).toMatchObject({ kind: 'needs-parent', parentUrn: null, preferredTypeId: 'app', askParent: true })
      expect(s.choices.map((c) => c.urn)).toEqual(['finance', 'sales', 'ops'])
    })

    it('one candidate: picks it', () => {
      const s = resolveCreationScope(apps, ctx({ parentsFor: () => [sales] }))
      expect(s).toMatchObject({ parentUrn: 'sales', askParent: false, preferredTypeId: 'app' })
    })

    it('the selection can hold it (in any column): inside the selection', () => {
      const parentsFor = vi.fn(() => [finance, sales])
      const s = resolveCreationScope(apps, ctx({ selectionId: 'ops', parentsFor }))
      expect(s).toMatchObject({ parentUrn: 'ops', askParent: false })
      expect(parentsFor).not.toHaveBeenCalled()
    })

    it('no candidate at all: still asks — the picker says so, and offers the top level', () => {
      const s = resolveCreationScope(apps, ctx({ parentsFor: () => [] }))
      expect(s).toMatchObject({ askParent: true, parentUrn: null, choices: [] })
    })
  })

  describe('asked for by type (the command palette)', () => {
    it('a top-level type: the top level, as before', () => {
      const s = resolveCreationScope(null, ctx({ typeId: 'domain', selectionId: 'finance' }))
      expect(s).toMatchObject({ kind: 'top-level', parentUrn: null, preferredTypeId: 'domain', askParent: false })
    })

    it('a type the selection can hold: inside the selection', () => {
      expect(resolveCreationScope(null, ctx({ typeId: 'service', selectionId: 'billing' })))
        .toMatchObject({ parentUrn: 'billing', preferredTypeId: 'service', askParent: false })
    })

    it('a type the selection can\'t hold: asks, offering what can', () => {
      const s = resolveCreationScope(null, ctx({ typeId: 'app', selectionId: 'billing' }))
      expect(s).toMatchObject({ parentUrn: null, preferredTypeId: 'app', askParent: true })
      expect(s.choices.map((c) => c.urn)).toEqual(['finance', 'sales', 'ops'])
    })

    it('decides over the layer', () => {
      expect(resolveCreationScope(anchored, ctx({ typeId: 'domain' })).parentUrn).toBeNull()
    })
  })
})

describe('childTypesLookup', () => {
  it('sorts by level then name and remembers each parent type', () => {
    expect(childTypes('domain')).toEqual(['app', 'dataPlatform'])
    expect(childTypes('domain')).toBe(childTypes('domain'))
    expect(childTypes(null)).toEqual(['domain', 'glossary'])
    expect(childTypes('service')).toEqual([])
  })
})
