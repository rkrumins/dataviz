/**
 * The crash snapshot stays 'committing' for as long as a save runs — including when an edit made
 * mid-save rewrites it — so a reload knows a save may have reached the server (its retry reuses the
 * key: useStagedDraftPersistence.reload.test). When the save fails (it settles with the changes
 * still staged) the snapshot goes back to 'staged'.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStagedDraftPersistence } from '../useStagedDraftPersistence'
import { readSnapshot } from '../stagedDraftPersistence'
import { useStagedChangesStore } from '@/store/stagedChangesStore'

const KEY = 'ws1::ds1::br1'
const stage = (name: string) => act(() => {
  useStagedChangesStore.getState().stage({ type: 'rename_entity', targetId: `t-${name}`, after: {}, summary: name })
})
const setStatus = (applyStatus: 'idle' | 'applying') => act(() => { useStagedChangesStore.setState({ applyStatus }) })
const settle = () => act(() => { vi.advanceTimersByTime(1000) })
const phase = () => readSnapshot(KEY)?.phase

describe('useStagedDraftPersistence — the snapshot phase across a save', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    useStagedChangesStore.setState({ changes: [], redoStack: [], applyStatus: 'idle', lastApplyResult: null })
  })
  afterEach(() => vi.useRealTimers())

  it('is committing while the save runs, and staged again once it fails', () => {
    renderHook(() => useStagedDraftPersistence(KEY, 'br1', false))
    stage('a')
    settle()
    expect(phase()).toBe('staged')

    setStatus('applying')
    expect(phase()).toBe('committing')

    stage('b')                         // an edit made while the save runs
    settle()
    expect(phase()).toBe('committing')

    setStatus('idle')                  // the save failed: both changes are still staged
    settle()
    expect(phase()).toBe('staged')
    expect(readSnapshot(KEY)?.changes).toHaveLength(2)
  })
})
