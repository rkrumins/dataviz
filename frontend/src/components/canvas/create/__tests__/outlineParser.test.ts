import { describe, it, expect } from 'vitest'
import { parseIndentedOutline, type OutlineParseContext } from '../outlineParser'
import type { EntityTypeSchema, RelationshipTypeSchema } from '@/types/schema'

const et = (
  id: string,
  name: string,
  canContain: string[],
  canBeContainedBy: string[] = [],
  level = 0,
): EntityTypeSchema => ({
  id, name, pluralName: `${name}s`, visual: {} as never, fields: [], behavior: {} as never,
  hierarchy: { level, canContain, canBeContainedBy, defaultExpanded: false, rollUpFields: [] },
})

const rt = (
  id: string,
  sourceTypes: string[],
  targetTypes: string[],
  extra: Partial<RelationshipTypeSchema> = {},
): RelationshipTypeSchema => ({ id, name: id, sourceTypes, targetTypes, ...extra } as RelationshipTypeSchema)

// domain L0 -> dataPlatform L1 -> container L2 -> dataset L3 -> column L4,
// with container self-nesting (container -> {container, dataset}).
const entityTypes = [
  et('domain', 'Domain', ['dataPlatform'], [], 0),
  et('dataPlatform', 'Data Platform', ['container'], ['domain'], 1),
  et('container', 'Container', ['container', 'dataset'], ['dataPlatform', 'container'], 2),
  et('dataset', 'Dataset', ['column'], ['container'], 3),
  et('column', 'Column', [], ['dataset'], 4),
]
const rootEntityTypes = ['domain']
const relationshipTypes = [rt('CONTAINS', ['*'], ['*'], { isContainment: true })]
const containmentEdgeTypes = ['CONTAINS']

const baseCtx: OutlineParseContext = {
  entityTypes,
  rootEntityTypes,
  hierarchyMap: {},
  relationshipTypes,
  containmentEdgeTypes,
  rootParentType: null,
}

describe('parseIndentedOutline', () => {
  it('infers depth from tabs (1 level per tab)', () => {
    const text = 'Domain: Sales\n\tData Platform: Analytics\n\t\tContainer: Raw'
    const rows = parseIndentedOutline(text, baseCtx)
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2])
    expect(rows.map((r) => r.typeId)).toEqual(['domain', 'dataPlatform', 'container'])
  })

  it('infers a 2-space indent unit from the text', () => {
    const text = 'Domain: Sales\n  Data Platform: Analytics\n    Container: Raw'
    const rows = parseIndentedOutline(text, baseCtx)
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2])
  })

  it('infers a 4-space indent unit from the text', () => {
    const text = 'Domain: Sales\n    Data Platform: Analytics\n        Container: Raw'
    const rows = parseIndentedOutline(text, baseCtx)
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2])
  })

  it('strips a leading "- " or "* " bullet before parsing', () => {
    const text = '- Domain: Sales\n  * Data Platform: Analytics'
    const rows = parseIndentedOutline(text, baseCtx)
    expect(rows[0].name).toBe('Sales')
    expect(rows[1].name).toBe('Analytics')
    expect(rows[1].depth).toBe(1)
  })

  it('matches an explicit type prefix by name (case-insensitive), not just id', () => {
    const types = [
      et('domain', 'Domain', ['tbl']),
      et('tbl', 'Dataset', [], ['domain'], 1),
    ]
    const ctx: OutlineParseContext = {
      entityTypes: types,
      rootEntityTypes: ['domain'],
      hierarchyMap: {},
      relationshipTypes,
      containmentEdgeTypes,
      rootParentType: null,
    }
    const rows = parseIndentedOutline('Domain: Sales\n  dataset: orders', ctx)
    expect(rows[1].explicitType).toBe(true)
    expect(rows[1].typeId).toBe('tbl')
    expect(rows[1].name).toBe('orders')
    expect(rows[1].issues).toEqual([])
  })

  it('clamps a depth jump of 2+ levels to previousRow.depth + 1', () => {
    const text = 'Sales\n  Analytics\n      Orders'
    const rows = parseIndentedOutline(text, baseCtx)
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2])
  })

  it('auto-resolves the type when exactly one child type is allowed', () => {
    const rows = parseIndentedOutline('Sales', baseCtx)
    expect(rows[0].typeId).toBe('domain')
    expect(rows[0].explicitType).toBe(false)
  })

  it('when multiple types are allowed, picks the one with the lowest hierarchy level (then name)', () => {
    const text = 'Domain: Sales\n  Data Platform: Analytics\n    Container: Raw\n      Orders'
    const rows = parseIndentedOutline(text, baseCtx)
    const last = rows[rows.length - 1]
    expect(last.explicitType).toBe(false)
    expect(last.typeId).toBe('container') // hierarchy.level 2 < dataset's 3
  })

  it('flags an illegal explicit type but still resolves a fallback type', () => {
    const text = 'Domain: Sales\n  Column: Bad'
    const rows = parseIndentedOutline(text, baseCtx)
    const row = rows[1]
    expect(row.explicitType).toBe(true)
    expect(row.issues).toContain("A Domain can't contain a Column.")
    expect(row.typeId).toBe('dataPlatform') // fallback: domain's only allowed child
  })

  it('flags a row whose parent row failed to resolve a type', () => {
    const noRootTypes = [et('dataPlatform', 'Data Platform', ['container'], ['domain'], 1)]
    const ctx: OutlineParseContext = {
      entityTypes: noRootTypes,
      rootEntityTypes: [],
      hierarchyMap: {},
      relationshipTypes: [],
      containmentEdgeTypes: [],
      rootParentType: null,
    }
    const rows = parseIndentedOutline('Mystery\n  Child', ctx)
    expect(rows[0].typeId).toBeNull()
    expect(rows[1].typeId).toBeNull()
    expect(rows[1].issues).toContain('Fix the row above first.')
  })

  it('flags a resolved type that has no valid containment edge in the ontology', () => {
    const ctx: OutlineParseContext = { ...baseCtx, relationshipTypes: [] }
    const text = 'Domain: Sales\n  Data Platform: Analytics'
    const rows = parseIndentedOutline(text, ctx)
    expect(rows[1].typeId).toBe('dataPlatform')
    expect(rows[1].issues).toContain("A Domain can't contain a Data Platform.")
  })

  it('ignores blank and whitespace-only lines', () => {
    const text = 'Domain: Sales\n\n   \n  Data Platform: Analytics'
    const rows = parseIndentedOutline(text, baseCtx)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.name)).toEqual(['Sales', 'Analytics'])
  })

  it('keeps a colon in the name when the prefix does not match a type', () => {
    const rows = parseIndentedOutline('Ratio: 4:1 blend', baseCtx)
    expect(rows[0].name).toBe('Ratio: 4:1 blend')
    expect(rows[0].explicitType).toBe(false)
  })
})
