/**
 * What a field asks of a value, as editing warns of it — the same judgement the publish makes
 * (backend `field_value_problem`): a property's type, leniently where the data is; its allowed
 * values, compared as text; and whether it is required. The name and the platform's own fields are
 * never judged.
 */
import { describe, expect, it } from 'vitest'
import type { EntityFieldDefinition } from '@/types/schema'
import { fieldProblem, fieldWarning, governedFields, inputTypeOf, isGoverned, requiredMissing, storedAllowed } from '../fieldRules'

const f = (id: string, extra: Partial<EntityFieldDefinition> = {}): EntityFieldDefinition => ({
  id, name: id, type: 'string', required: false, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 0, ...extra,
})

describe('fieldRules', () => {
  it('governs a property field with something to judge — never the name or a platform field', () => {
    const fields = [f('name', { required: true }), f('description', { required: true }), f('owner', { required: true }),
      f('tier', { type: 'status', allowedValues: ['gold'] }), f('hint', { allowedValues: ['a'], allowOther: true }),
      f('rows', { type: 'number' }), f('note', { type: 'markdown' })]
    expect([...governedFields(fields).keys()]).toEqual(['owner', 'tier', 'rows'])
    expect(isGoverned(f('hint', { allowedValues: ['a'], allowOther: true }))).toBe(false)
  })

  it('judges a value by its type, leniently where the data is', () => {
    const rows = f('rows', { type: 'number' })
    expect(fieldProblem(rows, 3)).toBeNull()
    expect(fieldProblem(rows, '1,200')).toBeNull()
    expect(fieldProblem(rows, 'many')).toBe('Should be a number — “many” isn’t.')
    expect(fieldProblem(rows, true)).not.toBeNull()
    expect(fieldProblem(f('ok', { type: 'boolean' }), 'TRUE')).toBeNull()
    expect(fieldProblem(f('d', { type: 'date' }), '31/01/2026')).not.toBeNull()
    expect(fieldProblem(f('d', { type: 'datetime' }), '2026-01-31')).toBeNull()
    expect(fieldProblem(f('u', { type: 'url' }), 'example.com')).not.toBeNull()
    expect(fieldProblem(f('note', { type: 'markdown' }), { any: 1 })).toBeNull()
    expect(fieldProblem(rows, '')).toBeNull()
  })

  it('keeps a value to the allowed ones, compared as text; suggestions never refuse', () => {
    const tier = f('tier', { type: 'status', allowedValues: ['gold', 'silver'] })
    expect(fieldProblem(tier, ' gold ')).toBeNull()
    expect(fieldProblem(tier, 'bronze')).toBe('Must be one of gold, silver — “bronze” isn’t.')
    expect(fieldProblem({ ...tier, allowOther: true }, 'bronze')).toBeNull()
    expect(fieldProblem(f('n', { type: 'number', allowedValues: ['1', '2'] }), 2)).toBeNull()
    expect(fieldProblem(f('t', { type: 'tags', allowedValues: ['pii'] }), ['pii', 'hr'])).toContain('“hr”')
  })

  it('says what publishing refuses — and a required field left without a value', () => {
    const owner = f('owner', { name: 'Owner', required: true })
    expect(requiredMissing(owner, '')).toBe(true)
    expect(requiredMissing(owner, 'ana')).toBe(false)
    expect(fieldWarning(owner, undefined, 'Tables')).toBe(
      'Owner is required for Tables — publishing refuses a new one without it, or one it is emptied on.')
    expect(fieldWarning(f('rows', { type: 'number' }), 'x', 'Tables')).toBe('Should be a number — “x” isn’t. Publishing will refuse it.')
    expect(fieldWarning(f('name', { required: true }), '', 'Tables')).toBeNull()
  })

  it('governs a relationship type’s fields by an edge’s own — a name is a property of a relationship', () => {
    const fields = [f('name', { required: true }), f('description', { required: true }), f('confidence', { type: 'number' }),
      f('id', { required: true }), f('since', { type: 'date' })]
    expect([...governedFields(fields, true).keys()]).toEqual(['name', 'description', 'since'])
    const name = f('name', { name: 'Name', required: true })
    expect(fieldWarning(name, '', 'Owns relationships', true)).toBe(
      'Name is required for Owns relationships — publishing refuses a new one without it, or one it is emptied on.')
    expect(fieldProblem(f('confidence', { type: 'number' }), 'high', true)).toBeNull()
    expect(fieldProblem(f('since', { type: 'date' }), 'soon', true)).not.toBeNull()
  })

  it('edits and stores a value as its field types it', () => {
    expect(inputTypeOf('progress')).toBe('number')
    expect(inputTypeOf('status')).toBe('text')
    expect(storedAllowed({ type: 'number' }, '3')).toBe(3)
    expect(storedAllowed({ type: 'boolean' }, 'true')).toBe(true)
    expect(storedAllowed({ type: 'status' }, '3')).toBe('3')
  })
})
