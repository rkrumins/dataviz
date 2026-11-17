import { beforeEach, describe, expect, it } from 'vitest'
import { buildChangeSet } from '@/features/versioning/model/changeModel'
import { buildReviewGroups } from '@/features/versioning/model/reviewModel'
import type { StagedChange } from '../stagedChangesStore'
import { allStops, savedStops, stopsFromGroups, useChangeNavigatorStore, type NavStop } from '../changeNavigatorStore'

const nav = () => useChangeNavigatorStore.getState()
const stop = (id: string): NavStop => ({ id, name: id, status: 'modified', saved: false })

beforeEach(() => useChangeNavigatorStore.setState({ active: false, stops: [], index: 0 }))

describe('changeNavigatorStore', () => {
  it('starts at the stop asked for and steps within the sequence', () => {
    nav().start([stop('a'), stop('b'), stop('c')], { scope: 'unsaved', at: 'b' })
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

  it('stops at staged entities still on the canvas, and saved ones not removed', () => {
    const mk = (over: Partial<StagedChange>): StagedChange => ({ id: Math.random().toString(36), type: 'rename_entity', targetId: 'x', after: {}, summary: '', timestamp: 0, ...over })
    const groups = buildReviewGroups([
      mk({ targetId: 'urn:a', targetUrn: 'urn:a' }),
      mk({ type: 'delete_entity', targetId: 'urn:gone', targetUrn: 'urn:gone' }),
      mk({ type: 'create_edge', targetId: 'e1', after: { source: 'urn:a', target: 'urn:b' } }),
    ], { nameOf: (id) => id })
    expect(stopsFromGroups(groups).map((s) => s.id)).toEqual(['urn:a'])

    const cs = buildChangeSet([
      { entityId: 'b', urn: 'urn:b', kind: 'node', status: 'added', label: 'B', origin: { source: 'branch', branchId: 'br' } },
      { entityId: 'c', urn: 'urn:c', kind: 'node', status: 'removed', label: 'C', origin: { source: 'branch', branchId: 'br' } },
      { entityId: 'a', urn: 'urn:a', kind: 'node', status: 'modified', label: 'A', origin: { source: 'branch', branchId: 'br' } },
    ])
    const saved = savedStops(cs)
    expect(saved.map((s) => s.id)).toEqual(['urn:b', 'urn:a'])
    expect(savedStops(cs)).toBe(saved)
    expect(allStops(stopsFromGroups(groups), saved).map((s) => s.id)).toEqual(['urn:a', 'urn:b'])
  })
})
