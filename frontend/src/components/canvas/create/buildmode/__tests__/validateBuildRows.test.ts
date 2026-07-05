import { describe, it, expect } from 'vitest'
import { makeRow, type BuildRow } from '../buildRow'
import { validateBuildRows, summarize, type BuildOntologyCtx } from '../validateBuildRows'
import type { EntityTypeSchema, RelationshipTypeSchema } from '@/types/schema'

// Small default-ontology-shaped fixture:
//   domain(L0, root) -> dataPlatform(L1) -> container(L2) -> dataset(L3, leaf)
//   group(L0, root, self-nesting) -> attribute(L1, leaf)
const et = (id: string, canContain: string[], canBeContainedBy: string[] = [], level = 0): EntityTypeSchema => ({
  id, name: id[0].toUpperCase() + id.slice(1), pluralName: id, visual: {} as never, fields: [], behavior: {} as never,
  hierarchy: { level, canContain, canBeContainedBy, defaultExpanded: false, rollUpFields: [] },
})

const rt = (
  id: string,
  sourceTypes: string[],
  targetTypes: string[],
  extra: Partial<RelationshipTypeSchema> = {},
): RelationshipTypeSchema => ({ id, name: id, sourceTypes, targetTypes, isContainment: true, ...extra } as RelationshipTypeSchema)

const entityTypes: EntityTypeSchema[] = [
  et('domain', ['dataPlatform'], [], 0),
  et('dataPlatform', ['container'], ['domain'], 1),
  et('container', ['dataset'], ['dataPlatform'], 2),
  et('dataset', [], ['container'], 3),
  et('group', ['group', 'attribute'], ['group'], 0),
  et('attribute', [], ['group'], 1),
]

const relationshipTypes: RelationshipTypeSchema[] = [
  rt('CONTAINS_DOMAIN', ['domain'], ['dataPlatform']),
  rt('CONTAINS_PLATFORM', ['dataPlatform'], ['container']),
  rt('CONTAINS_CONTAINER', ['container'], ['dataset']),
  rt('CONTAINS_GROUP', ['group'], ['group', 'attribute']),
]

const hierarchyMap: BuildOntologyCtx['hierarchyMap'] = Object.fromEntries(
  entityTypes.map((t) => [t.id, { canContain: t.hierarchy.canContain, canBeContainedBy: t.hierarchy.canBeContainedBy }]),
)

const ctx: BuildOntologyCtx = {
  entityTypes,
  rootEntityTypes: ['domain', 'group'],
  hierarchyMap,
  relationshipTypes,
  containmentEdgeTypes: [],
}

const byId = (rows: BuildRow[], id: string): BuildRow => {
  const r = rows.find((row) => row.id === id)
  if (!r) throw new Error(`row ${id} not found`)
  return r
}

describe('validateBuildRows', () => {
  it('(a) infers a single-allowed child type', () => {
    const rows: BuildRow[] = [
      makeRow({ id: 'd1', name: 'Domain', typeId: 'domain', parentId: null }),
      makeRow({ id: 'p1', name: 'Platform', typeId: null, parentId: 'd1' }),
    ]
    const result = validateBuildRows(rows, ctx)
    const p1 = byId(result, 'p1')
    expect(p1.typeId).toBe('dataPlatform')
    expect(p1.status).toBe('fixed')
    expect(p1.fixes.map((f) => f.field)).toContain('type')
  })

  it('(b) auto-promotes an attribute-typed parent to group when a child is added under it (no redundant inserted ancestor)', () => {
    const rows: BuildRow[] = [
      makeRow({ id: 'a1', name: 'Attr Parent', typeId: 'attribute', parentId: null }),
      makeRow({ id: 'a2', name: 'Attr Child', typeId: 'attribute', parentId: 'a1' }),
    ]
    const result = validateBuildRows(rows, ctx)
    const a1 = byId(result, 'a1')
    const a2 = byId(result, 'a2')
    expect(a1.typeId).toBe('group')
    expect(a1.status).toBe('fixed')
    expect(a1.fixes.map((f) => f.field)).toContain('promote')
    expect(a2.typeId).toBe('attribute')
    expect(a2.status).toBe('valid')

    // `group` is a valid root type, so the promoted a1 stays a root — it must
    // NOT also get a synthetic parent inserted (that would be a redundant
    // Group -> Group(promoted) -> Attribute instead of Group -> Attribute).
    expect(result).toHaveLength(2)
    expect(a1.parentId).toBeNull()
    expect(a1.fixes.map((f) => f.field)).not.toContain('parent')
  })

  it('(f) three root leaf-typed rows needing the same missing ancestor chain each get their OWN synthesized chain (no cross-root sharing)', () => {
    const rows: BuildRow[] = [
      makeRow({ id: 'ds1', name: 'Orders', typeId: 'dataset', parentId: null }),
      makeRow({ id: 'ds2', name: 'Customers', typeId: 'dataset', parentId: null }),
      makeRow({ id: 'ds3', name: 'Products', typeId: 'dataset', parentId: null }),
    ]
    const result = validateBuildRows(rows, ctx)
    const ds1 = byId(result, 'ds1')
    const ds2 = byId(result, 'ds2')
    const ds3 = byId(result, 'ds3')

    expect(ds1.parentId).not.toBeNull()
    expect(ds2.parentId).not.toBeNull()
    expect(ds3.parentId).not.toBeNull()
    // each root dataset gets its own container — none shared across roots
    expect(new Set([ds1.parentId, ds2.parentId, ds3.parentId]).size).toBe(3)

    // three FULL, independent domain/dataPlatform/container chains (9 new
    // rows total), not one chain (3) shared across all three roots.
    const synthesized = result.filter((r) => r.id !== 'ds1' && r.id !== 'ds2' && r.id !== 'ds3')
    expect(synthesized).toHaveLength(9)
    expect(synthesized.map((r) => r.typeId).sort()).toEqual(
      ['container', 'container', 'container', 'dataPlatform', 'dataPlatform', 'dataPlatform', 'domain', 'domain', 'domain'],
    )

    const domainIdsOf = (ds: BuildRow) => {
      const container = byId(result, ds.parentId!)
      const platform = byId(result, container.parentId!)
      const domain = byId(result, platform.parentId!)
      expect(container.typeId).toBe('container')
      expect(platform.typeId).toBe('dataPlatform')
      expect(domain.typeId).toBe('domain')
      expect(domain.parentId).toBeNull()
      return domain.id
    }
    const domainIds = [ds1, ds2, ds3].map(domainIdsOf)
    expect(new Set(domainIds).size).toBe(3)
  })

  it('(c) inserts a missing parent level (dataset pasted at root gets the domain/dataPlatform/container chain)', () => {
    const rows: BuildRow[] = [makeRow({ id: 'ds1', name: 'Orders', typeId: 'dataset', parentId: null })]
    const result = validateBuildRows(rows, ctx)
    const ds1 = byId(result, 'ds1')
    expect(ds1.status).toBe('fixed')
    expect(ds1.fixes.map((f) => f.field)).toContain('parent')
    expect(ds1.parentId).not.toBeNull()

    const container = byId(result, ds1.parentId!)
    expect(container.typeId).toBe('container')
    const platform = byId(result, container.parentId!)
    expect(platform.typeId).toBe('dataPlatform')
    const domain = byId(result, platform.parentId!)
    expect(domain.typeId).toBe('domain')
    expect(domain.parentId).toBeNull()

    // 3 synthesized ancestors + the original row
    expect(result).toHaveLength(4)
  })

  it("(d) marks a genuinely-illegal nesting as error with a plain-language message", () => {
    const rows: BuildRow[] = [
      makeRow({ id: 'dom1', name: 'Domain', typeId: 'domain', parentId: null }),
      makeRow({ id: 'dp1', name: 'Platform', typeId: 'dataPlatform', parentId: 'dom1' }),
      makeRow({ id: 'ct1', name: 'Container', typeId: 'container', parentId: 'dp1' }),
      makeRow({ id: 'at1', name: 'Stray Attr', typeId: 'attribute', parentId: 'ct1' }),
    ]
    const result = validateBuildRows(rows, ctx)
    const at1 = byId(result, 'at1')
    expect(at1.status).toBe('error')
    expect(at1.issues).toHaveLength(1)
    expect(at1.issues[0].message).toContain('Attribute')
    expect(at1.issues[0].message).toContain('Container')
  })

  it('(g) returns rows in OUTLINE order, not depth order — a multi-level, multi-item tree stays contiguous per subtree', () => {
    // Two root groups ("layers"), each with two attribute children
    // ("objects"); one child (ga1) itself gains a child (gga1), so pass 1
    // auto-promotes ga1 from attribute -> group to hold it (like test (b)).
    // Given in outline order already — the bug is that validateBuildRows
    // used to return rows sorted by DEPTH instead of preserving this order.
    const rows: BuildRow[] = [
      makeRow({ id: 'g1', name: 'Group1', typeId: 'group', parentId: null }),
      makeRow({ id: 'ga1', name: 'GA1', typeId: 'attribute', parentId: 'g1' }),
      makeRow({ id: 'gga1', name: 'GGA1', typeId: 'attribute', parentId: 'ga1' }),
      makeRow({ id: 'ga2', name: 'GA2', typeId: 'attribute', parentId: 'g1' }),
      makeRow({ id: 'g2', name: 'Group2', typeId: 'group', parentId: null }),
      makeRow({ id: 'gb1', name: 'GB1', typeId: 'attribute', parentId: 'g2' }),
      makeRow({ id: 'gb2', name: 'GB2', typeId: 'attribute', parentId: 'g2' }),
    ]
    const result = validateBuildRows(rows, ctx)

    // ga1 got promoted to 'group' (bottom-up pass 1) so it can hold gga1 —
    // confirms the fixture is exercising the intended multi-level shape.
    expect(byId(result, 'ga1').typeId).toBe('group')

    expect(result.map((r) => r.id)).toEqual(['g1', 'ga1', 'gga1', 'ga2', 'g2', 'gb1', 'gb2'])
  })

  it('(e) summarize() counts valid/fixed/errors', () => {
    const rows: BuildRow[] = [
      { ...makeRow({ id: '1', typeId: 'domain' }), status: 'valid' },
      { ...makeRow({ id: '2', typeId: 'dataPlatform' }), status: 'fixed' },
      { ...makeRow({ id: '3', typeId: 'container' }), status: 'fixed' },
      { ...makeRow({ id: '4', typeId: 'attribute' }), status: 'error' },
    ]
    expect(summarize(rows)).toEqual({ valid: 1, fixed: 2, errors: 1 })
  })
})
