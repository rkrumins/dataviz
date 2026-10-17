/**
 * A save whose answer never came back (a timeout, a dropped connection) may still have committed.
 * Sending the very same batch again reuses that save's Idempotency-Key, so the server answers with
 * what the first one did instead of applying it twice. Any other batch gets a key of its own.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/services/versioningApiService', () => ({ applyGraphChanges: vi.fn() }))
vi.mock('@/services/viewTransferApiService', () => ({ newRequestId: vi.fn() }))
vi.mock('@/hooks/useAggregatedLineage', () => ({ invalidateAggregatedEdges: vi.fn() }))

import { saveStagedChangesToDraft } from '../saveStagedChangesToDraft'
import { applyGraphChanges } from '@/services/versioningApiService'
import { newRequestId } from '@/services/viewTransferApiService'
import type { StagedChange } from '@/store/stagedChangesStore'

const mockApply = vi.mocked(applyGraphChanges)
const target = { wsId: 'w', dataSourceId: 'ds', branchId: 'b', provider: {} as never, message: 'm' }
const rename = (urn: string, name: string): StagedChange => ({
  id: `c-${urn}`, type: 'update_entity', targetId: urn, targetUrn: urn,
  before: { description: '' }, after: { description: name }, summary: '', timestamp: 0,
})
const keyOf = (call: number) => mockApply.mock.calls[call][5]

describe('saveStagedChangesToDraft — Idempotency-Key', () => {
  beforeEach(async () => {
    let n = 0
    vi.mocked(newRequestId).mockImplementation(() => `key-${++n}`)
    mockApply.mockReset()
    mockApply.mockResolvedValue({ commitId: 'x', assigned: {} } as never)
    await saveStagedChangesToDraft([rename('urn:reset', 'r')], target)   // a success clears any pending key
    mockApply.mockClear()
  })

  it('reuses the key when the very same batch is sent again after a failure', async () => {
    mockApply.mockRejectedValueOnce(new Error('The request timed out.'))
    await expect(saveStagedChangesToDraft([rename('urn:a', 'A')], target)).rejects.toThrow('timed out')
    await saveStagedChangesToDraft([rename('urn:a', 'A')], target)
    expect(keyOf(0)).toEqual(expect.any(String))
    expect(keyOf(0)).not.toBe('')
    expect(keyOf(1)).toBe(keyOf(0))
  })

  it('mints a new key for the next save once one has succeeded, even for the same batch', async () => {
    await saveStagedChangesToDraft([rename('urn:a', 'A')], target)
    await saveStagedChangesToDraft([rename('urn:a', 'A')], target)
    expect(keyOf(1)).not.toBe(keyOf(0))
  })

  it('mints a new key when the batch changed after a failure', async () => {
    mockApply.mockRejectedValueOnce(new Error('The request timed out.'))
    await expect(saveStagedChangesToDraft([rename('urn:a', 'A')], target)).rejects.toThrow()
    await saveStagedChangesToDraft([rename('urn:a', 'A'), rename('urn:b', 'B')], target)
    expect(keyOf(1)).not.toBe(keyOf(0))
  })
})
