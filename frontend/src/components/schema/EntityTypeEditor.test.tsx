/**
 * EntityTypeEditor — a field can be what an import matches entities by, and can be required to be
 * unique. Both are set per field, on the Fields tab, and travel with the type: what the editor
 * saves is what the ontology stores, and what it stores comes back as it was set.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { EntityTypeEditor } from './EntityTypeEditor'
import { entityDefToSchema, entitySchemaToBackend } from '@/features/ontology/lib/ontology-parsers'
import type { EntityTypeSchema } from '@/types/schema'

const table = (): EntityTypeSchema => entityDefToSchema('Table', {
  name: 'Table',
  fields: [{ id: 'sap_id', name: 'SAP id', type: 'string', display_order: 0 }],
})

describe('EntityTypeEditor — import matching and uniqueness', () => {
  it('sets both per field and saves them with the type', async () => {
    const onSave = vi.fn()
    render(<EntityTypeEditor entityType={table()} onSave={onSave} onCancel={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /fields/i }))

    await userEvent.click(screen.getByRole('checkbox', { name: 'Match imports by this' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Must be unique' }))
    await userEvent.click(screen.getByRole('button', { name: /stage changes/i }))

    expect(onSave.mock.calls[0][0].fields[0]).toMatchObject({ id: 'sap_id', reconciliationKey: true, unique: true })
  })

  it('round-trips through the ontology: stored as set, read back as stored, off by default', () => {
    const set = { ...table(), fields: [{ ...table().fields[0], reconciliationKey: true, unique: true }] }
    const stored = entitySchemaToBackend(set)
    expect((stored.fields as Array<Record<string, unknown>>)[0]).toMatchObject({ reconciliation_key: true, unique: true })
    expect(entityDefToSchema('Table', stored).fields[0]).toMatchObject({ reconciliationKey: true, unique: true })
    expect(table().fields[0]).toMatchObject({ reconciliationKey: false, unique: false })
    // Off is the default, so a type saved with them off stores exactly what it stored before.
    const plain = (entitySchemaToBackend(table()).fields as Array<Record<string, unknown>>)[0]
    expect('reconciliation_key' in plain || 'unique' in plain).toBe(false)
    // A type stored with the flags in camelCase reads the same.
    expect(entityDefToSchema('Table', { fields: [{ id: 'k', name: 'K', reconciliationKey: true }] }).fields[0].reconciliationKey)
      .toBe(true)
  })
})

describe('EntityTypeEditor — saved over the stored type', () => {
  it('keeps what the editor does not hold, and what it edited wins', () => {
    const stored = {
      name: 'Table', rank: 3, fields: [],
      visual: { icon: 'Box', color: '#111111', glow: 'soft' },
      hierarchy: { level: 2, pinned: true },
      behavior: { selectable: false, hover_card: 'compact' },
    }
    const edited = entityDefToSchema('Table', stored)
    edited.name = 'Warehouse table'
    edited.visual.color = '#222222'
    edited.hierarchy.level = 1
    edited.behavior.selectable = true

    expect(entitySchemaToBackend(edited, stored)).toMatchObject({
      name: 'Warehouse table', rank: 3,
      visual: { icon: 'Box', color: '#222222', glow: 'soft' },
      hierarchy: { level: 1, pinned: true },
      behavior: { selectable: true, hover_card: 'compact' },
    })
  })
})

describe('EntityTypeEditor — what a field asks of a value, and the property it is', () => {
  it('keeps a field to allowed values — or makes them suggestions — and saves them with the type', async () => {
    const onSave = vi.fn()
    render(<EntityTypeEditor entityType={table()} onSave={onSave} onCancel={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /fields/i }))
    const add = screen.getByRole('textbox', { name: 'Add to allowed values of sap id' })
    await userEvent.type(add, 'gold{Enter}silver, bronze{Enter}')
    await userEvent.click(screen.getByRole('button', { name: 'Remove bronze' }))
    expect(screen.getByText(/Only these values can be published/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /stage changes/i }))
    expect(onSave.mock.calls[0][0].fields[0]).toMatchObject({ id: 'sap_id', allowedValues: ['gold', 'silver'] })
    expect(onSave.mock.calls[0][0].fields[0].allowOther).toBeUndefined()

    await userEvent.click(screen.getByRole('checkbox', { name: 'Other values too' }))
    await userEvent.click(screen.getByRole('button', { name: /stage changes/i }))
    expect(onSave.mock.calls[1][0].fields[0]).toMatchObject({ allowedValues: ['gold', 'silver'], allowOther: true })
  })

  it('round-trips allowed values and the display format through the ontology', () => {
    const stored = entitySchemaToBackend({ ...table(), fields: [{
      ...table().fields[0], allowedValues: ['gold', 'silver'], allowOther: true, format: { prefix: '#', statusColors: { gold: '#fc0' } },
    }] })
    const field = (stored.fields as Array<Record<string, unknown>>)[0]
    expect(field).toMatchObject({ allowed_values: ['gold', 'silver'], allow_other: true, format: { prefix: '#' } })
    expect(entityDefToSchema('Table', stored).fields[0]).toMatchObject({
      allowedValues: ['gold', 'silver'], allowOther: true, format: { prefix: '#', statusColors: { gold: '#fc0' } },
    })
    // Stored as text, as the server keeps them; none stored when there are none.
    expect(entityDefToSchema('T', { fields: [{ id: 'n', name: 'N', allowed_values: [1, 2, ' ', 1] }] }).fields[0].allowedValues).toEqual(['1', '2'])
    const plain = (entitySchemaToBackend(table()).fields as Array<Record<string, unknown>>)[0]
    expect('allowed_values' in plain || 'allow_other' in plain || 'format' in plain).toBe(false)
  })

  it('binds a new field to a property key from its name — typed over, it stays; a saved field keeps its own', async () => {
    const onSave = vi.fn()
    render(<EntityTypeEditor entityType={table()} onSave={onSave} onCancel={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /fields/i }))
    // A saved field's key is fixed: entities hold their values under it.
    expect(screen.getByText('sap_id', { selector: 'code' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Add Field' }))
    expect(screen.getByRole('button', { name: /stage changes/i })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Give it a property key')
    const names = screen.getAllByRole('textbox', { name: 'Field name' })
    await userEvent.type(names[1], 'Cost Center')
    const key = screen.getByRole('textbox', { name: 'Property key' })
    expect(key).toHaveValue('cost_center')
    await userEvent.clear(key)
    await userEvent.type(key, 'sap_id')
    expect(screen.getByRole('alert')).toHaveTextContent('Another field of this type uses this key')
    await userEvent.clear(key)
    await userEvent.type(key, 'cc')
    await userEvent.type(names[1], ' (finance)')
    expect(key).toHaveValue('cc')
    await userEvent.click(screen.getByRole('button', { name: /stage changes/i }))
    expect(onSave.mock.calls[0][0].fields.map((f: { id: string; name: string }) => [f.id, f.name])).toEqual([
      ['sap_id', 'SAP id'], ['cc', 'Cost Center (finance)']])
  })
})
