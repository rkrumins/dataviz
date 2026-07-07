/**
 * BuildPaste — Task 7. Proves the Paste adapter REUSES `parseIndentedOutline`
 * (never a forked parser) and feeds parsed rows into the SAME
 * `buildRowsStore` Outline/Grid read/write, with each row's type-derived
 * target layer resolved via the shared `buildTypeLayerMap` (the Grid's own
 * source, over the view's real `useLayers()`).
 *
 * Ontology fixture: domain -> object -> group (self-nesting) -> attribute —
 * same shape BuildOutline.test.tsx uses, so a single linear legal child at
 * each level makes type inference deterministic without needing hierarchy
 * levels. Layers: one column per type, so each previewed row's target column
 * name is unambiguous to assert on.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import type { EntityTypeSchema, RelationshipTypeSchema } from '@/types/schema'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import { useBuildRowsStore } from '../buildRowsStore'
import type { BuildOntologyCtx } from '../validateBuildRows'
import type { ParsedOutlineRow } from '../../outlineParser'
import { BuildPaste, toBuildRows } from '../BuildPaste'

const et = (id: string, canContain: string[], canBeContainedBy: string[] = []): EntityTypeSchema => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  pluralName: id,
  visual: { icon: 'Box', color: '#6366f1' } as never,
  fields: [],
  behavior: {} as never,
  hierarchy: { level: 0, canContain, canBeContainedBy, defaultExpanded: false, rollUpFields: [] },
})
const rt = (id: string, sourceTypes: string[], targetTypes: string[]): RelationshipTypeSchema =>
  ({ id, name: id, sourceTypes, targetTypes, isContainment: true } as RelationshipTypeSchema)

const entityTypes = [
  et('domain', ['object']),
  et('object', ['group'], ['domain']),
  et('group', ['group', 'attribute'], ['object', 'group']),
  et('attribute', [], ['group']),
]
const rootEntityTypes = ['domain']
const relationshipTypes = [
  rt('CONTAINS_OBJECT', ['domain'], ['object']),
  rt('CONTAINS_GROUP', ['object'], ['group']),
  rt('CONTAINS_SUB', ['group'], ['group', 'attribute']),
]
const containmentEdgeTypes: string[] = []

const ctx: BuildOntologyCtx = { entityTypes, rootEntityTypes, hierarchyMap: {}, relationshipTypes, containmentEdgeTypes }
const typeById = new Map(entityTypes.map((t) => [t.id, t]))

describe('toBuildRows (pure parse -> BuildRow[] conversion)', () => {
  const row = (name: string, typeId: string | null, depth: number, issues: string[] = []): ParsedOutlineRow => ({
    name, typeId, explicitType: false, depth, issues,
  })

  it('threads parentId from depth, minting fresh ids', () => {
    const parsed = [row('Sales', 'domain', 0), row('Widgets', 'object', 1)]
    const rows = toBuildRows(parsed)
    expect(rows).toHaveLength(2)
    expect(rows[0].parentId).toBeNull()
    expect(rows[1].parentId).toBe(rows[0].id)
    expect(rows[0].id).not.toBe(rows[1].id)
  })

  it('excludes a row with issues AND cascades the exclusion to its descendants', () => {
    const parsed = [
      row('Sales', 'domain', 0),
      row('Oops', 'object', 1, ["A Domain can't contain an Attribute."]),
      row('Nested', 'group', 2), // no issue of its own, but its parent was excluded
    ]
    const rows = toBuildRows(parsed)
    expect(rows.map((r) => r.name)).toEqual(['Sales'])
  })

  it('a sibling after a skipped row still attaches to the real (non-skipped) parent', () => {
    const parsed = [
      row('Sales', 'domain', 0),
      row('Bad', 'object', 1, ['bad']),
      row('Good', 'object', 1),
    ]
    const rows = toBuildRows(parsed)
    expect(rows.map((r) => r.name)).toEqual(['Sales', 'Good'])
    expect(rows[1].parentId).toBe(rows[0].id)
  })
})

describe('BuildPaste component', () => {
  beforeEach(() => {
    useBuildRowsStore.getState().reset()
    useReferenceModelStore.getState().setLayers([
      { id: 'lay-domain', name: 'Domain Column', entityTypes: ['domain'], order: 0 },
      { id: 'lay-object', name: 'Object Column', entityTypes: ['object'], order: 1 },
      { id: 'lay-group', name: 'Group Column', entityTypes: ['group'], order: 2 },
      { id: 'lay-attr', name: 'Attribute Column', entityTypes: ['attribute'], order: 3 },
    ])
  })

  it('renders a live preview with each row\'s inferred type and type-derived target column', () => {
    render(<BuildPaste ctx={ctx} typeById={typeById} rootParentType={null} />)
    fireEvent.change(screen.getByPlaceholderText(/Sales/i), { target: { value: 'Sales\n  Widgets' } })

    expect(screen.getByText('Sales')).toBeInTheDocument()
    expect(screen.getByText('Widgets')).toBeInTheDocument()
    expect(screen.getByText('Domain')).toBeInTheDocument() // inferred type label
    expect(screen.getByText('Object')).toBeInTheDocument()
    expect(screen.getByText(/Domain Column/)).toBeInTheDocument() // type-derived layer target
    expect(screen.getByText(/Object Column/)).toBeInTheDocument()
  })

  it('shows an issue clearly for an illegal row', () => {
    render(<BuildPaste ctx={ctx} typeById={typeById} rootParentType={null} />)
    fireEvent.change(screen.getByPlaceholderText(/Sales/i), { target: { value: 'Attribute: Oops' } })
    expect(screen.getByText(/can't/i)).toBeInTheDocument()
  })

  it('"Add N items" pushes parsed rows into the SHARED buildRowsStore, matching Outline/Grid', () => {
    render(<BuildPaste ctx={ctx} typeById={typeById} rootParentType={null} />)
    fireEvent.change(screen.getByPlaceholderText(/Sales/i), { target: { value: 'Sales\n  Widgets' } })

    const addButton = screen.getByRole('button', { name: /Add 2 items?/i })
    fireEvent.click(addButton)

    const rows = useBuildRowsStore.getState().rows
    expect(rows).toHaveLength(2)
    const sales = rows.find((r) => r.name === 'Sales')!
    const widgets = rows.find((r) => r.name === 'Widgets')!
    expect(sales.typeId).toBe('domain')
    expect(widgets.typeId).toBe('object')
    expect(widgets.parentId).toBe(sales.id)
  })

  it('appends to EXISTING buildRowsStore rows instead of replacing them (shared across tabs)', () => {
    useBuildRowsStore.getState().setRows([{
      id: 'existing', name: 'Existing', typeId: 'domain', parentId: null, depth: 0, status: 'valid', issues: [], fixes: [],
    }])
    render(<BuildPaste ctx={ctx} typeById={typeById} rootParentType={null} />)
    fireEvent.change(screen.getByPlaceholderText(/Sales/i), { target: { value: 'Sales' } })
    fireEvent.click(screen.getByRole('button', { name: /Add 1 item/i }))

    const rows = useBuildRowsStore.getState().rows
    expect(rows.map((r) => r.name).sort()).toEqual(['Existing', 'Sales'])
  })

  it('excludes issue rows (and their cascaded descendants) from the Add count and the store', () => {
    render(<BuildPaste ctx={ctx} typeById={typeById} rootParentType={null} />)
    fireEvent.change(screen.getByPlaceholderText(/Sales/i), {
      target: { value: 'Sales\n  Attribute: Oops\n    Nested' },
    })

    expect(screen.getByRole('button', { name: /Add 1 item/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Add 1 item/i }))
    expect(useBuildRowsStore.getState().rows.map((r) => r.name)).toEqual(['Sales'])
  })
})
