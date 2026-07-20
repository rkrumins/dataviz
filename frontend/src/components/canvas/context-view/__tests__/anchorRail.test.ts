import { describe, it, expect } from 'vitest'
import { groupAnchorProxies, anchorRailFingerprint, ANCHOR_RAIL_CAP } from '../anchorRail'
import type { AnchorProxyCandidate } from '../anchorRail'

const cand = (nodeId: string, layerId: string, count: number, direction: 'up' | 'down' = 'up'): AnchorProxyCandidate =>
  ({ nodeId, layerId, count, color: '#3b82f6', direction })

describe('groupAnchorProxies', () => {
  it('groups candidates by owning layer', () => {
    const groups = groupAnchorProxies([cand('a', 'L1', 1), cand('b', 'L2', 1)])
    expect(Array.from(groups.keys()).sort()).toEqual(['L1', 'L2'])
    expect(groups.get('L1')!.proxies.map(p => p.nodeId)).toEqual(['a'])
  })

  it('ranks by count desc with deterministic nodeId tie-break', () => {
    const groups = groupAnchorProxies([
      cand('z', 'L1', 3), cand('a', 'L1', 7), cand('m', 'L1', 3),
    ])
    expect(groups.get('L1')!.proxies.map(p => p.nodeId)).toEqual(['a', 'm', 'z'])
  })

  it('caps per layer and reports the overflow as moreCount', () => {
    const many = Array.from({ length: ANCHOR_RAIL_CAP + 4 }, (_, i) => cand(`n${i}`, 'L1', i + 1))
    const groups = groupAnchorProxies(many)
    expect(groups.get('L1')!.proxies).toHaveLength(ANCHOR_RAIL_CAP)
    expect(groups.get('L1')!.moreCount).toBe(4)
    // strongest flows earn the slots
    expect(groups.get('L1')!.proxies[0].count).toBe(ANCHOR_RAIL_CAP + 4)
  })

  it('strips layerId from the emitted proxies', () => {
    const groups = groupAnchorProxies([cand('a', 'L1', 1)])
    expect(groups.get('L1')!.proxies[0]).not.toHaveProperty('layerId')
  })
})

describe('anchorRailFingerprint', () => {
  it('is empty without a focus node or without groups', () => {
    expect(anchorRailFingerprint(null, groupAnchorProxies([cand('a', 'L1', 1)]))).toBe('')
    expect(anchorRailFingerprint('focus', new Map())).toBe('')
  })

  it('is stable across layer insertion order and changes with content', () => {
    const a = groupAnchorProxies([cand('a', 'L1', 1), cand('b', 'L2', 1)])
    const b = groupAnchorProxies([cand('b', 'L2', 1), cand('a', 'L1', 1)])
    expect(anchorRailFingerprint('f', a)).toBe(anchorRailFingerprint('f', b))
    const c = groupAnchorProxies([cand('a', 'L1', 2), cand('b', 'L2', 1)])
    expect(anchorRailFingerprint('f', c)).not.toBe(anchorRailFingerprint('f', a))
  })
})
