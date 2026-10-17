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
})
