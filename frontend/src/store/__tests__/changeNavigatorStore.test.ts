import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ getChangeEntries: vi.fn() }))
vi.mock('@/services/versioningApiService', async (orig) => ({
  ...(await orig<typeof import('@/services/versioningApiService')>()),
  ...api,
}))

import { buildReviewGroups } from '@/features/versioning/model/reviewModel'
import type { StagedChange } from '../stagedChangesStore'
import {
  arraySource, changeListSource, concatSources, NAV_PAGE, stopsFromGroups, useChangeNavigatorStore, type NavStop,
} from '../changeNavigatorStore'

const nav = () => useChangeNavigatorStore.getState()
const stop = (id: string): NavStop => ({ id, name: id, status: 'modified', saved: false })
const flush = () => new Promise((r) => setTimeout(r, 0))
const rows = (from: number, n: number) => Array.from({ length: n }, (_, k) => ({
  entityId: `e${from + k}`, kind: 'node', status: 'modified', structural: false, displayName: `Entity ${from + k}`, urn: `urn:e${from + k}`,
}))

beforeEach(() => {
  useChangeNavigatorStore.setState({ active: false, source: null, index: 0 })
  api.getChangeEntries.mockReset()
})

describe('changeNavigatorStore', () => {
  it('starts at the stop asked for and steps within the sequence', () => {
    nav().start([stop('a'), stop('b'), stop('c')], { scope: 'unsaved', atId: 'b' })
    expect(nav().active).toBe(true)
    expect(nav().index).toBe(1)
    nav().next(); nav().next()
    expect(nav().index).toBe(2)
    nav().prev(); nav().prev(); nav().prev()
    expect(nav().index).toBe(0)
    nav().close()
    expect(nav().active).toBe(false)
  })

  it('does not start on nothing', () => {
    nav().start([], { scope: 'saved' })
    expect(nav().active).toBe(false)
  })

  it('stops at staged entities still on the canvas', () => {
    const mk = (over: Partial<StagedChange>): StagedChange => ({ id: Math.random().toString(36), type: 'rename_entity', targetId: 'x', after: {}, summary: '', timestamp: 0, ...over })
    const groups = buildReviewGroups([
      mk({ targetId: 'urn:a', targetUrn: 'urn:a' }),
      mk({ type: 'delete_entity', targetId: 'urn:gone', targetUrn: 'urn:gone' }),
      mk({ type: 'create_edge', targetId: 'e1', after: { source: 'urn:a', target: 'urn:b' } }),
    ], { nameOf: (id) => id })
    expect(stopsFromGroups(groups).map((s) => s.id)).toEqual(['urn:a'])
  })
})

describe('changeListSource — saved changes read a page at a time', () => {
  it('reads the page it is asked for, with names, and the next one near its end', async () => {
    api.getChangeEntries.mockImplementation(async (_w, _g, _o, _f, offset: number, limit: number) =>
      ({ entries: rows(offset, Math.min(limit, 1200 - offset)), total: 1200, offset, limit, hasMore: offset + limit < 1200 }))
    const src = changeListSource('ws1', 'g1', { branchId: 'br1' })
    expect(src.total).toBe(-1)
    nav().start(src, { scope: 'saved', at: 3 })
    expect(src.at(3)).toBeUndefined()
    await flush()
    expect(src.total).toBe(1200)
    expect(src.at(3)).toEqual({ id: 'urn:e3', name: 'Entity 3', status: 'modified', saved: true })
    expect(api.getChangeEntries).toHaveBeenCalledWith('ws1', 'g1', { branchId: 'br1' },
      { kind: 'node', statuses: ['added', 'modified'] }, 0, NAV_PAGE)

    nav().go(NAV_PAGE - 10)          // near the end of the first page: the second is read ahead
    await flush()
    expect(api.getChangeEntries).toHaveBeenCalledTimes(2)
    expect(src.at(NAV_PAGE + 1)?.name).toBe(`Entity ${NAV_PAGE + 1}`)
    nav().go(5000)
    expect(nav().index).toBe(1199)
  })

  it('says when a page failed, and reads it again when asked', async () => {
    api.getChangeEntries.mockRejectedValueOnce(new Error('down'))
    const src = changeListSource('ws1', 'g1', { branchId: 'br1' })
    nav().start(src, { scope: 'saved' })
    await flush()
    expect(src.failed(0)).toBe(true)
    api.getChangeEntries.mockResolvedValueOnce({ entries: rows(0, 2), total: 2, offset: 0, limit: NAV_PAGE, hasMore: false })
    nav().go(0)
    await flush()
    expect(src.failed(0)).toBe(false)
    expect(src.at(1)?.id).toBe('urn:e1')
  })

  it('knows a draft too large to list', async () => {
    api.getChangeEntries.mockResolvedValue({ entries: [], total: 0, offset: 0, limit: NAV_PAGE, hasMore: false, tooLarge: { changed: 300000, limit: 250000 } })
    const src = changeListSource('ws1', 'g1', { branchId: 'br1' })
    nav().start(src, { scope: 'saved' })
    await flush()
    expect(src.tooLarge).toBe(true)
  })

  it('steps through unsaved, then saved', async () => {
    api.getChangeEntries.mockResolvedValue({ entries: rows(0, 2), total: 2, offset: 0, limit: NAV_PAGE, hasMore: false })
    const all = concatSources(arraySource([stop('urn:staged')]), changeListSource('ws1', 'g1', { branchId: 'br1' }))
    await flush()
    expect(all.total).toBe(3)
    expect([0, 1, 2].map((i) => all.at(i)?.id)).toEqual(['urn:staged', 'urn:e0', 'urn:e1'])
  })
})
