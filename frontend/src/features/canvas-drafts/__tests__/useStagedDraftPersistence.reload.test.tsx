/**
 * A reload while a save runs keeps the staged work: the snapshot carries the save's Idempotency-Key,
 * the reload restores the work, and saving it again sends that same key — so the server answers
 * with what the first save did if it committed, and applies the batch if it did not.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { apply } = vi.hoisted(() => ({ apply: vi.fn() }))
vi.mock('@/services/versioningApiService', () => ({ applyGraphChanges: apply }))
vi.mock('@/services/viewTransferApiService', () => {
  let n = 0
  return { newRequestId: () => `key-${++n}` }
})
vi.mock('@/hooks/useAggregatedLineage', () => ({ invalidateAggregatedEdges: vi.fn() }))

const KEY = 'ws1::ds1::br1'
const target = { wsId: 'ws1', dataSourceId: 'ds1', branchId: 'br1', provider: {} as never, message: 'm' }

/** A fresh page: every module (and so every store and the in-memory pending save) starts over;
 *  only localStorage carries across, as in a real reload. */
async function load() {
  vi.resetModules()
  const { useStagedDraftPersistence } = await import('../useStagedDraftPersistence')
  const { readSnapshot } = await import('../stagedDraftPersistence')
  const { saveStagedChangesToDraft } = await import('@/features/versioning/model/saveStagedChangesToDraft')
  const { useStagedChangesStore } = await import('@/store/stagedChangesStore')
  useStagedChangesStore.getState().setScope(KEY)
  return { useStagedDraftPersistence, readSnapshot, saveStagedChangesToDraft, useStagedChangesStore }
}

describe('useStagedDraftPersistence — a reload while a save runs', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    apply.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('restores the work, and the retry reuses the in-flight save’s key', async () => {
    // Page 1: stage an edit, start saving it; the answer never comes before the reload.
    const p1 = await load()
    const h1 = renderHook(() => p1.useStagedDraftPersistence(KEY, 'br1', false))
    act(() => {
      p1.useStagedChangesStore.getState().stage({
        type: 'update_entity', targetId: 'urn:a', targetUrn: 'urn:a',
        before: { description: '' }, after: { description: 'A' }, summary: 'Edit A',
      })
    })
    act(() => { vi.advanceTimersByTime(1000) })
    apply.mockReturnValueOnce(new Promise(() => {}))
    act(() => { p1.useStagedChangesStore.setState({ applyStatus: 'applying' }) })
    void p1.saveStagedChangesToDraft(p1.useStagedChangesStore.getState().changes, target)
    expect(apply.mock.calls[0][5]).toBe('key-1')
    expect(p1.readSnapshot(KEY)).toMatchObject({ phase: 'committing', pendingSave: { key: 'key-1' } })
    h1.unmount()

    // Page 2: the reload.
    const p2 = await load()
    renderHook(() => p2.useStagedDraftPersistence(KEY, 'br1', true))
    const restored = p2.useStagedChangesStore.getState().changes
    expect(restored.map((c) => c.summary)).toEqual(['Edit A'])

    apply.mockResolvedValueOnce({ commitId: 'c1', assigned: {} })
    await p2.saveStagedChangesToDraft(restored, target)
    expect(apply.mock.calls[1][5]).toBe('key-1')
  })

  it('an edit after the reload goes in its own save: the restored save is replayed first, exactly, under its key', async () => {
    const TEMP = 'urn:staged:Dataset:0123456789abcdef'
    // Page 1: stage a create, start saving it; the server commits it, but the answer is lost to the reload.
    const p1 = await load()
    const h1 = renderHook(() => p1.useStagedDraftPersistence(KEY, 'br1', false))
    act(() => {
      p1.useStagedChangesStore.getState().stage({
        type: 'create_entity', targetId: TEMP, targetUrn: TEMP,
        after: { displayName: 'A', entityType: 'Dataset' }, summary: 'Create A',
      })
    })
    act(() => { vi.advanceTimersByTime(1000) })
    apply.mockReturnValueOnce(new Promise(() => {}))
    act(() => { p1.useStagedChangesStore.setState({ applyStatus: 'applying' }) })
    void p1.saveStagedChangesToDraft(p1.useStagedChangesStore.getState().changes, target)
    const firstSave = apply.mock.calls[0]
    h1.unmount()

    // Page 2: the work comes back, and the user edits something else before saving again.
    const p2 = await load()
    renderHook(() => p2.useStagedDraftPersistence(KEY, 'br1', true))
    act(() => {
      p2.useStagedChangesStore.getState().stage({
        type: 'update_entity', targetId: 'urn:b', targetUrn: 'urn:b',
        before: { description: '' }, after: { description: 'B' }, summary: 'Edit B',
      })
    })
    apply.mockResolvedValueOnce({ commitId: 'c1', assigned: { [TEMP]: 'urn:real:a' } })   // the replay
    apply.mockRejectedValueOnce(new Error('The request timed out.'))                     // Edit B's save
    await expect(p2.saveStagedChangesToDraft(p2.useStagedChangesStore.getState().changes, {
      ...target, message: 'Canvas edits (2)',
    })).rejects.toThrow('timed out')

    // The create went again only as the replay of the first save — same body, same key.
    expect(apply.mock.calls[1]).toEqual(firstSave)
    const creates = apply.mock.calls.slice(1).flatMap((c) => (c[3] as Array<{ op: string; kind: string }>)
      .filter((o) => o.op === 'create' && o.kind === 'node').map(() => c[5]))
    expect(creates).toEqual([firstSave[5]])
    expect(apply.mock.calls[2][3]).toEqual([expect.objectContaining({ op: 'update', id: 'urn:b' })])
    expect(apply.mock.calls[2][5]).not.toBe(firstSave[5])
    // The settled create leaves the staged list even though Edit B's save failed, so no later save sends it.
    expect(p2.useStagedChangesStore.getState().changes.map((c) => c.summary)).toEqual(['Edit B'])
  })

  it('a save whose edits were discarded is never sent afterwards', async () => {
    const p = await load()
    renderHook(() => p.useStagedDraftPersistence(KEY, 'br1', true))
    const stage = (urn: string) => act(() => {
      p.useStagedChangesStore.getState().stage({
        type: 'update_entity', targetId: urn, targetUrn: urn,
        before: { description: '' }, after: { description: urn }, summary: urn,
      })
    })
    stage('urn:a')
    apply.mockRejectedValueOnce(new Error('The request timed out.'))
    await expect(p.saveStagedChangesToDraft(p.useStagedChangesStore.getState().changes, target)).rejects.toThrow()
    act(() => { p.useStagedChangesStore.getState().discardAll() })
    stage('urn:b')
    apply.mockResolvedValueOnce({ commitId: 'c1', assigned: {} })
    await p.saveStagedChangesToDraft(p.useStagedChangesStore.getState().changes, target)
    expect(apply).toHaveBeenCalledTimes(2)
    expect(apply.mock.calls[1][3]).toEqual([expect.objectContaining({ id: 'urn:b' })])
  })
})

