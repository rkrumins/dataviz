/**
 * A publish the server refuses because values that must be unique are not — `sap_id` 'X' held by
 * two Table entities — arrives as a typed error carrying each value, the entities that share it,
 * and how many such values there are in all (the list it sends may be cut short).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../fetchWithTimeout', () => ({ fetchWithTimeout: vi.fn() }))

import { fetchWithTimeout } from '../fetchWithTimeout'
import { publishBranch, UniqueViolationError, describeUniqueViolation } from '../versioningApiService'

beforeEach(() => vi.mocked(fetchWithTimeout).mockReset())

describe('a publish that breaks a uniqueness rule', () => {
  it('is refused with the values, the entities sharing each, and the total', async () => {
    vi.mocked(fetchWithTimeout).mockResolvedValue(new Response(JSON.stringify({ detail: {
      type: 'unique_violation', total: 3,
      violations: [
        { type: 'Table', field: 'sap_id', value: 'X', entities: ['urn:t:1', 'urn:t:2'] },
        { type: 'Table', field: 'sap_id', value: 'Y', entities: ['urn:t:3', 'urn:t:4', 'urn:t:5'] },
      ],
    } }), { status: 409, headers: { 'Content-Type': 'application/json' } }))

    const err = await publishBranch('ws1', 'g1', 'br_1', { message: 'go' }).catch((e) => e)

    expect(err).toBeInstanceOf(UniqueViolationError)
    expect(err.total).toBe(3)
    expect(err.violations.map(describeUniqueViolation)).toEqual([
      "sap_id 'X' is used by 2 Table entities",
      "sap_id 'Y' is used by 3 Table entities",
    ])
    expect(err.message).toContain("sap_id 'X' is used by 2 Table entities")
  })
})
