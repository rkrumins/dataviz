/**
 * Unsaved work too large for localStorage is kept in IndexedDB: a small marker stays in
 * localStorage (written at once, carrying the phase and the save key), the work itself goes to
 * IndexedDB, and reading it back merges the two — however large the work.
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearSnapshot, LARGE_SNAPSHOT, markSnapshotCommitting, readSnapshot, readSnapshotAsync,
  writeSnapshot, writeSnapshotAsync, type StagedDraftSnapshot,
} from '../stagedDraftPersistence'

const KEY = 'ws1::ds1::br1'
const snap = (n: number): StagedDraftSnapshot => ({
  version: 1, scopeKey: KEY, branchId: 'br1', phase: 'staged', savedAt: 1,
  changes: Array.from({ length: n }, (_, i) => ({
    id: `c${i}`, type: 'update_entity', targetId: `urn:${i}`, targetUrn: `urn:${i}`,
    before: { description: '' }, after: { description: `${i}`.repeat(40) }, summary: `Edit ${i}`, timestamp: i,
  })),
  pendingNodes: [], pendingEdges: [],
})

beforeEach(() => {
  localStorage.clear()
  clearSnapshot(KEY)
})

describe('a snapshot past localStorage', () => {
  it('keeps a small one in localStorage, as before', async () => {
    expect(writeSnapshot(snap(3))).toBe(true)
    expect(readSnapshot(KEY)?.changes).toHaveLength(3)
    expect((await readSnapshotAsync(KEY))?.changes).toHaveLength(3)
  })

  it('keeps a large one in IndexedDB, with a small marker left in localStorage', async () => {
    const n = LARGE_SNAPSHOT * 3
    expect(await writeSnapshotAsync(snap(n))).toBe(true)
    const marker = JSON.parse(localStorage.getItem(`synodic:staged-draft:${KEY}`)!)
    expect(marker).toMatchObject({ where: 'idb', count: n, phase: 'staged' })
    expect(JSON.stringify(marker).length).toBeLessThan(500)
    expect(readSnapshot(KEY)).toBeNull()                       // not readable synchronously…
    const back = await readSnapshotAsync(KEY)                  // …but whole, asynchronously
    expect(back?.changes).toHaveLength(n)
    expect(back?.changes[n - 1].summary).toBe(`Edit ${n - 1}`)
  })

  it('marks a large one committing with the save key — durable before the save is sent', async () => {
    await writeSnapshotAsync(snap(LARGE_SNAPSHOT + 1))
    const save = { key: 'key-9', body: JSON.stringify(['x'.repeat(10_000)]), sent: { c0: '{}' } }
    await markSnapshotCommitting(KEY, save)
    const back = await readSnapshotAsync(KEY)
    expect(back?.phase).toBe('committing')
    expect(back?.pendingSave).toEqual(save)
  })

  it('goes back to localStorage when the work shrinks, leaving nothing behind in IndexedDB', async () => {
    await writeSnapshotAsync(snap(LARGE_SNAPSHOT + 1))
    await writeSnapshotAsync(snap(2))
    expect(readSnapshot(KEY)?.changes).toHaveLength(2)
    clearSnapshot(KEY)
    expect(await readSnapshotAsync(KEY)).toBeNull()
  })
})
