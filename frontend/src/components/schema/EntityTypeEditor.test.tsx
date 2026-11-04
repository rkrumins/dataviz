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
