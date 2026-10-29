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

import { getPendingSave, resumePendingSave, saveStagedChangesToDraft } from '../saveStagedChangesToDraft'
import {
  applyGraphChanges, BranchClosedError, GraphNotWritableError, IntegrityError, MainWriteForbiddenError,
} from '@/services/versioningApiService'
import { newRequestId } from '@/services/viewTransferApiService'
import { useStagedChangesStore, type StagedChange } from '@/store/stagedChangesStore'

const mockApply = vi.mocked(applyGraphChanges)
const target = { wsId: 'w', dataSourceId: 'ds', branchId: 'b', provider: {} as never, message: 'm' }
const rename = (urn: string, name: string): StagedChange => ({
  id: `c-${urn}`, type: 'update_entity', targetId: urn, targetUrn: urn,
  before: { description: '' }, after: { description: name }, summary: '', timestamp: 0,
})
const edgeEdit = (a: number): StagedChange => ({
  id: 'c-e1', type: 'edit_edge', targetId: 'e1',
  before: { properties: { a: 0 }, version: 'v0' }, after: { properties: { a } }, summary: '', timestamp: 0,
})
const timeout = () => new Error('The request timed out.')
const keyOf = (call: number) => mockApply.mock.calls[call][5]
const opsOf = (call: number) => mockApply.mock.calls[call][3]

describe('saveStagedChangesToDraft — Idempotency-Key', () => {
  beforeEach(async () => {
    let n = 0
    vi.mocked(newRequestId).mockImplementation(() => `key-${++n}`)
    mockApply.mockReset()
    useStagedChangesStore.setState({ _scopeKey: null, _byScope: {}, changes: [], redoStack: [] })
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

  it('sends an edit made since the unanswered save went out, on top of what that save stored', async () => {
    mockApply.mockRejectedValueOnce(timeout())
    await expect(saveStagedChangesToDraft([edgeEdit(1)], target)).rejects.toThrow()
    // The same staged change (same id), edited again before the retry.
    mockApply.mockResolvedValueOnce({ commitId: 'x', assigned: {}, entities: { e1: { kind: 'edge', version: 'v1', edge: {} } } } as never)
    await saveStagedChangesToDraft([edgeEdit(2)], target)
    expect(mockApply).toHaveBeenCalledTimes(3)
    expect(mockApply.mock.calls[1]).toEqual(mockApply.mock.calls[0])
    // From the value that save stored, at the token it returned — not against the user's own save.
    expect(opsOf(2)).toEqual([{ op: 'update', kind: 'edge', id: 'e1', payload: { properties: { a: 2 } }, baseVersion: 'v1' }])
  })

  it('renames the entity an unanswered save created when the create was renamed since — never creates it twice', async () => {
    const TEMP = 'urn:staged:1'
    const create: StagedChange = {
      id: 'c-new', type: 'create_entity', targetId: TEMP, targetUrn: TEMP,
      after: { displayName: 'Old', entityType: 'Dataset' }, summary: '', timestamp: 0,
    }
    useStagedChangesStore.setState({ changes: [create] })
    mockApply.mockRejectedValueOnce(timeout())
    await expect(saveStagedChangesToDraft(useStagedChangesStore.getState().changes, target)).rejects.toThrow()
    useStagedChangesStore.getState().patchAfter('c-new', { displayName: 'New' })
    mockApply.mockResolvedValueOnce({
      commitId: 'x', assigned: { [TEMP]: 'urn:real:1' },
      entities: { 'urn:real:1': { kind: 'node', version: 'v1', node: {} } },
    } as never)
    mockApply.mockRejectedValueOnce(timeout())
    await expect(saveStagedChangesToDraft(useStagedChangesStore.getState().changes, target)).rejects.toThrow()
    expect(mockApply).toHaveBeenCalledTimes(3)
    expect(opsOf(1)).toEqual(opsOf(0))
    expect(opsOf(2)).toEqual([{ op: 'update', kind: 'node', id: 'urn:real:1', payload: { displayName: 'New' }, baseVersion: 'v1' }])
    // That follow-up failed: the rename stays staged as the rename it now is, so no later save creates it again.
    expect(useStagedChangesStore.getState().changes).toEqual([
      expect.objectContaining({ id: 'c-new', type: 'update_entity', targetUrn: 'urn:real:1' }),
    ])
  })

  it('never replays one draft\'s unanswered save against another draft', async () => {
    useStagedChangesStore.getState().setScope('w::ds::a')
    mockApply.mockRejectedValueOnce(timeout())
    await expect(saveStagedChangesToDraft([rename('urn:a', 'A')], { ...target, branchId: 'a' })).rejects.toThrow()
    useStagedChangesStore.getState().setScope('w::ds::b')
    expect(getPendingSave('w::ds::b')).toBeNull()   // nor is it written into the other draft's snapshot
    await saveStagedChangesToDraft([rename('urn:b', 'B')], { ...target, branchId: 'b' })
    expect(mockApply).toHaveBeenCalledTimes(2)
    expect(mockApply.mock.calls[1][2]).toBe('b')
    expect(opsOf(1).map((o) => o.id)).toEqual(['urn:b'])
    // Back on the first draft, its save is still settled under its own key.
    expect(getPendingSave('w::ds::a')).toMatchObject({ key: keyOf(0) })
  })

  it('a save answered with a lasting 4xx was not applied: it stops blocking the saves after it', async () => {
    mockApply.mockRejectedValueOnce(timeout())
    await expect(saveStagedChangesToDraft([rename('urn:a', 'A')], target)).rejects.toThrow()
    mockApply.mockRejectedValueOnce(Object.assign(new Error('branch_not_found'), { status: 404 }))
    await saveStagedChangesToDraft([rename('urn:a', 'A'), rename('urn:b', 'B')], target)
    expect(mockApply).toHaveBeenCalledTimes(3)
    expect(opsOf(2).map((o) => o.id)).toEqual(['urn:a', 'urn:b'])
    expect(keyOf(2)).not.toBe(keyOf(0))
  })

  it.each([
    ['409 graph_not_writable', () => new GraphNotWritableError('Editing is paused on this graph.')],
    ['409 branch_closed', () => new BranchClosedError({ status: 'merged' })],
    ['409 main_write_forbidden', () => new MainWriteForbiddenError()],
    ['403', () => Object.assign(new Error('Forbidden'), { status: 403 })],
  ])('a save refused with %s was not applied: the next save sends the edits as they are now, once', async (_, refusal) => {
    mockApply.mockRejectedValueOnce(refusal())
    await expect(saveStagedChangesToDraft([rename('urn:a', 'Foo'), rename('urn:b', 'B')], target)).rejects.toThrow()
    expect(getPendingSave(null)).toBeNull()   // nor is it carried in the crash snapshot
    // Edited (same staged id) and one discarded while the save could not go through.
    await saveStagedChangesToDraft([rename('urn:a', 'Bar')], target)
    expect(mockApply).toHaveBeenCalledTimes(2)
    expect(opsOf(1)).toEqual([expect.objectContaining({ id: 'urn:a', payload: { description: 'Bar' } })])
    expect(keyOf(1)).not.toBe(keyOf(0))
  })

  it('keeps the key after a server error (5xx), which may have applied the save (regression guard)', async () => {
    mockApply.mockRejectedValueOnce(timeout())
    await expect(saveStagedChangesToDraft([rename('urn:a', 'A')], target)).rejects.toThrow()
    mockApply.mockRejectedValueOnce(Object.assign(new Error('Bad gateway'), { status: 502 }))
    await expect(saveStagedChangesToDraft([rename('urn:a', 'A'), rename('urn:b', 'B')], target)).rejects.toThrow()
    await saveStagedChangesToDraft([rename('urn:a', 'A'), rename('urn:b', 'B')], target)
    expect(keyOf(2)).toBe(keyOf(0))
  })

  it('a save restored without the changes it carried is not replayed: only the very same batch reuses its key', async () => {
    // A crash snapshot written before a save recorded what it carried.
    const body = JSON.stringify(['w', 'ds', 'b', [{ op: 'create', kind: 'node', ref: 'urn:staged:1', payload: { displayName: 'A' } }], 'm'])
    resumePendingSave({ body, key: 'old-key' }, null)
    await saveStagedChangesToDraft([rename('urn:b', 'B')], target)
    expect(mockApply).toHaveBeenCalledTimes(1)
    expect(keyOf(0)).not.toBe('old-key')
  })
})
