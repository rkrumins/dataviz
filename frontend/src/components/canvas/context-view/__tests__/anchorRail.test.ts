import { describe, it, expect } from 'vitest'
import { groupAnchorProxies, anchorRailFingerprint, railPartner, ANCHOR_RAIL_CAP, RAIL_REVEAL_CAP } from '../anchorRail'
import type { AnchorProxyCandidate, RailLine } from '../anchorRail'

const cand = (nodeId: string, layerId: string, count: number, direction: 'up' | 'down' = 'up'): AnchorProxyCandidate =>
  ({ nodeId, layerId, count, color: '#3b82f6', direction, flow: 'in' })

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

  it('passes who and which way through', () => {
    const groups = groupAnchorProxies([
      { ...cand('GOLD', 'L1', 1), flow: 'in', realId: 'order_key' },
      { ...cand('SILVER', 'L1', 4), flow: 'out', partners: 3, realIds: ['x', 'y', 'z'] },
      { ...cand('oc', 'L2', 2), flow: 'both', isFocus: true },
    ])
    expect(groups.get('L1')!.proxies).toEqual([
      { nodeId: 'SILVER', count: 4, color: '#3b82f6', direction: 'up', flow: 'out', partners: 3, realIds: ['x', 'y', 'z'] },
      { nodeId: 'GOLD', count: 1, color: '#3b82f6', direction: 'up', flow: 'in', realId: 'order_key' },
    ])
    expect(groups.get('L2')!.proxies[0]).toEqual({ nodeId: 'oc', count: 2, color: '#3b82f6', direction: 'up', flow: 'both', isFocus: true })
  })
})

describe('railPartner — who a focus line really reaches, and which way', () => {
  /** A drawn line GOLD→oc, or the like: its members filed under the drawn ends. */
  type Members = NonNullable<NonNullable<RailLine['data']>['members']>
  const line = (source: string, members: Members, isBidirectional = false): RailLine =>
    ({ source, isBidirectional, data: { members } })

  it('names the entity inside the drawn card: order_key feeds order_count through GOLD', () => {
    const l = line('GOLD', [{ source: 'GOLD', target: 'oc', _origSource: 'order_key', _origTarget: 'oc' }])
    expect(railPartner(l, 'oc', 'GOLD')).toEqual({ flow: 'in', realId: 'order_key' })
  })

  it('the focus as the drawn source flows out, to the member\'s real target', () => {
    const l = line('oc', [{ source: 'oc', target: 'GOLD', _origSource: 'oc', _origTarget: 'order_key' }])
    expect(railPartner(l, 'oc', 'GOLD')).toEqual({ flow: 'out', realId: 'order_key' })
  })

  it('a two-way line flows both ways', () => {
    const l = line('GOLD', [
      { source: 'GOLD', target: 'oc', _origSource: 'order_key', _origTarget: 'oc' },
      { source: 'oc', target: 'GOLD', _origSource: 'oc', _origTarget: 'order_key' },
    ], true)
    expect(railPartner(l, 'oc', 'GOLD')).toEqual({ flow: 'both', realId: 'order_key' })
  })

  it('several entities are counted, never named for one — and the first of them kept for a reveal', () => {
    const l = line('GOLD', [
      { source: 'GOLD', target: 'oc', _origSource: 'a', _origTarget: 'oc' },
      { source: 'GOLD', target: 'oc', _origSource: 'b', _origTarget: 'oc' },
      { source: 'GOLD', target: 'oc', _origSource: 'a', _origTarget: 'oc' },
    ])
    const who = railPartner(l, 'oc', 'GOLD')
    expect(who).toEqual({ flow: 'in', partners: 2, realIds: ['a', 'b'] })
    expect(who).not.toHaveProperty('realId')
  })

  it('keeps at most RAIL_REVEAL_CAP of them, and counts every one', () => {
    const members = Array.from({ length: RAIL_REVEAL_CAP + 3 }, (_, i) =>
      ({ source: 'oc', target: 'SILVER', _origSource: 'oc', _origTarget: `c${i}` }))
    const who = railPartner(line('oc', members), 'oc', 'SILVER')
    expect(who.partners).toBe(RAIL_REVEAL_CAP + 3)
    expect(who.realIds).toEqual(members.slice(0, RAIL_REVEAL_CAP).map(m => m._origTarget))
  })

  it('a far end that IS the drawn card is the card itself: nothing more to say', () => {
    const l = line('b', [{ source: 'b', target: 'a' }])
    expect(railPartner(l, 'a', 'b')).toEqual({ flow: 'in' })
  })

  it('a line with no members (a trace wire) takes its own direction', () => {
    expect(railPartner({ source: 'a' }, 'a', 'b')).toEqual({ flow: 'out' })
    expect(railPartner({ source: 'b' }, 'a', 'b')).toEqual({ flow: 'in' })
    expect(railPartner({ source: 'b', isBidirectional: true }, 'a', 'b')).toEqual({ flow: 'both' })
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

  it('changes when a proxy\'s flow or partner changes, and only then', () => {
    const fp = (extra: Partial<AnchorProxyCandidate>) =>
      anchorRailFingerprint('f', groupAnchorProxies([{ ...cand('a', 'L1', 1), ...extra }]))
    const base = fp({})
    expect(fp({})).toBe(base)
    expect(fp({ flow: 'out' })).not.toBe(base)
    expect(fp({ realId: 'order_key' })).not.toBe(base)
    expect(fp({ realId: 'order_key' })).not.toBe(fp({ realId: 'order_id' }))
    expect(fp({ partners: 3, realIds: ['x', 'y', 'z'] })).not.toBe(fp({ partners: 4, realIds: ['x', 'y', 'z'] }))
    expect(fp({ partners: 3, realIds: ['x', 'y', 'z'] })).not.toBe(fp({ partners: 3, realIds: ['x', 'y', 'w'] }))
    expect(fp({ partners: 3, realIds: ['x', 'y', 'z'] })).toBe(fp({ partners: 3, realIds: ['x', 'y', 'z'] }))
  })
})
