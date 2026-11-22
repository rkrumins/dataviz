/**
 * A publish the server refuses because property values break the fields their types define — an
 * entity type's or a relationship type's: a value not allowed, not of the field's type, a required
 * field left empty — arrives as a typed error carrying each entity or relationship, field, value
 * and reason, how many there are in all, and how many per kind and type, field and rule.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }))

import { fetchWithTimeout } from '../fetchWithTimeout'
import { FieldViolationError, publishBranch } from '../versioningApiService'

beforeEach(() => vi.mocked(fetchWithTimeout).mockReset())

describe('a publish that breaks a field rule', () => {
  it('is refused with each value, why, the total and the count per field', async () => {
    const byField = [
      { entityKind: 'node', entityType: 'Table', field: 'owner', fieldName: 'Owner', rule: 'field_required', count: 1 },
      { entityKind: 'edge', entityType: 'Owns', field: 'tier', fieldName: 'Tier', rule: 'field_not_allowed', count: 1, ids: ['e1'] },
    ]
    vi.mocked(fetchWithTimeout).mockResolvedValue(new Response(JSON.stringify({ detail: {
      type: 'field_violation', total: 2, byField,
      violations: [
        { entity_id: 'e1', kind: 'edge', type: 'Owns', name: null, urn: null, source: 'urn:a', target: 'urn:b',
          rule: 'field_not_allowed', field: 'tier', fieldName: 'Tier', value: 'bronze',
          reason: "Tier must be one of 'gold', 'silver' — 'bronze' isn't." },
        { entity_id: 'e2', kind: 'node', type: 'Table', name: null, urn: null, rule: 'field_required',
          field: 'owner', fieldName: 'Owner', value: null, reason: 'Owner is required for a new Table.' },
      ],
    } }), { status: 409, headers: { 'Content-Type': 'application/json' } }))

    const err = await publishBranch('ws1', 'g1', 'br_1', { message: 'go' }).catch((e) => e)

    expect(err).toBeInstanceOf(FieldViolationError)
    expect(err.total).toBe(2)
    expect(err.byField).toEqual(byField)
    expect(err.violations.map((v: { kind: string; rule: string }) => [v.kind, v.rule])).toEqual([
      ['edge', 'field_not_allowed'], ['node', 'field_required']])
    expect(err.violations[0]).toMatchObject({ source: 'urn:a', target: 'urn:b' })
    expect(err.message).toBe("2 values break the fields their types define. e1: Tier must be one of 'gold', "
      + "'silver' — 'bronze' isn't.; e2: Owner is required for a new Table.")
  })
})
