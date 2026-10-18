/**
 * A save whose answer never came back (a timeout, a dropped connection) may still have committed.
 * Sending the very same batch again reuses that save's Idempotency-Key, so the server answers with
 * what the first one did instead of applying it twice. A batch that changed since first settles that
 * save — its very batch, under its key — and only then sends the rest under a key of its own.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/services/versioningApiService', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/versioningApiService')>(),
  applyGraphChanges: vi.fn(),
}))
vi.mock('@/services/viewTransferApiService', () => ({ newRequestId: vi.fn() }))
vi.mock('@/hooks/useAggregatedLineage', () => ({ invalidateAggregatedEdges: vi.fn() }))

import { saveStagedChangesToDraft } from '../saveStagedChangesToDraft'
import { applyGraphChanges, IntegrityError } from '@/services/versioningApiService'
import { newRequestId } from '@/services/viewTransferApiService'
import type { StagedChange } from '@/store/stagedChangesStore'

const mockApply = vi.mocked(applyGraphChanges)
const target = { wsId: 'w', dataSourceId: 'ds', branchId: 'b', provider: {} as never, message: 'm' }
const rename = (urn: string, name: string): StagedChange => ({
  id: `c-${urn}`, type: 'update_entity', targetId: urn, targetUrn: urn,
  before: { description: '' }, after: { description: name }, summary: '', timestamp: 0,
})
const keyOf = (call: number) => mockApply.mock.calls[call][5]
const opsOf = (call: number) => mockApply.mock.calls[call][3]

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

  it('settles a changed batch\'s earlier save first: that very batch under its key, then the rest under a new one', async () => {
    mockApply.mockRejectedValueOnce(new Error('The request timed out.'))
    await expect(saveStagedChangesToDraft([rename('urn:a', 'A')], target)).rejects.toThrow()
    await saveStagedChangesToDraft([rename('urn:a', 'A'), rename('urn:b', 'B')], target)
    expect(mockApply).toHaveBeenCalledTimes(3)
    expect(mockApply.mock.calls[1]).toEqual(mockApply.mock.calls[0])   // A again, byte for byte, same key
    expect(opsOf(2).map((o) => o.id)).toEqual(['urn:b'])                 // only what that save did not carry
    expect(keyOf(2)).not.toBe(keyOf(0))
  })

  it('sends the whole batch under a new key when the server refuses the earlier one (it was not applied)', async () => {
    mockApply.mockRejectedValueOnce(new Error('The request timed out.'))
    await expect(saveStagedChangesToDraft([rename('urn:a', 'A')], target)).rejects.toThrow()
    mockApply.mockRejectedValueOnce(new IntegrityError())
    await saveStagedChangesToDraft([rename('urn:a', 'A'), rename('urn:b', 'B')], target)
    expect(mockApply).toHaveBeenCalledTimes(3)
    expect(keyOf(1)).toBe(keyOf(0))
    expect(opsOf(2).map((o) => o.id)).toEqual(['urn:a', 'urn:b'])
    expect(keyOf(2)).not.toBe(keyOf(0))
  })
})
