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

  it('(f) two sibling rows needing the same missing ancestor chain share ONE synthesized chain', () => {
    const rows: BuildRow[] = [
      makeRow({ id: 'ds1', name: 'Orders', typeId: 'dataset', parentId: null }),
      makeRow({ id: 'ds2', name: 'Customers', typeId: 'dataset', parentId: null }),
    ]
    const result = validateBuildRows(rows, ctx)
    const ds1 = byId(result, 'ds1')
    const ds2 = byId(result, 'ds2')

    expect(ds1.parentId).not.toBeNull()
    expect(ds1.parentId).toBe(ds2.parentId)

    // exactly one synthesized domain/dataPlatform/container chain (3 new
    // rows) is shared by both datasets, not two full chains (6).
    const synthesized = result.filter((r) => r.id !== 'ds1' && r.id !== 'ds2')
    expect(synthesized).toHaveLength(3)
    expect(synthesized.map((r) => r.typeId).sort()).toEqual(['container', 'dataPlatform', 'domain'])
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
