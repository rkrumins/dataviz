/**
 * A publish the server refuses because property values break the fields their entity types define
 * — a value not allowed, not of the field's type, a required field left empty — arrives as a typed
 * error carrying each entity, field, value and reason, and how many there are in all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }))

import { fetchWithTimeout } from '../fetchWithTimeout'
import { FieldViolationError, publishBranch } from '../versioningApiService'

beforeEach(() => vi.mocked(fetchWithTimeout).mockReset())

describe('a publish that breaks a field rule', () => {
  it('is refused with each value, why, and the total', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(new Response(JSON.stringify({ detail: {
      type: 'field_violation', total: 2,
      violations: [
        { entity_id: 'e1', kind: 'node', type: 'Table', name: 'Orders', urn: 'urn:t:1', rule: 'field_not_allowed',
          field: 'tier', fieldName: 'Tier', value: 'bronze', reason: "Tier must be one of 'gold', 'silver' — 'bronze' isn't." },
        { entity_id: 'e2', kind: 'node', type: 'Table', name: null, urn: null, rule: 'field_required',
          field: 'owner', fieldName: 'Owner', value: null, reason: 'Owner is required for a new Table.' },
      ],
    } }), { status: 409, headers: { 'Content-Type': 'application/json' } }))

    const err = await publishBranch('ws1', 'g1', 'br_1', { message: 'go' }).catch((e) => e)

    expect(err).toBeInstanceOf(FieldViolationError)
    expect(err.total).toBe(2)
    expect(err.violations.map((v: { rule: string }) => v.rule)).toEqual(['field_not_allowed', 'field_required'])
    expect(err.message).toBe("2 values break the fields their entity types define. Orders: Tier must be one of 'gold', "
      + "'silver' — 'bronze' isn't.; e2: Owner is required for a new Table.")
  })
})
