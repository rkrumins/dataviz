/**
 * The children a parent holds that the graph still has: what an anchor's "N more", the lineage
 * aggregation's holders and a sort flip's "fully loaded" weigh against its childCount. Tombstones
 * (deleted entities drawn where they were) aren't among them.
 */
import { describe, expect, it } from 'vitest'

import { withoutTombstones } from '../loadedChildren'

const tombstones = new Set(['urn:gone-1', 'urn:gone-2'])
const isTombstone = (id: string) => tombstones.has(id)

describe('withoutTombstones', () => {
  it('leaves tombstones out of the parents that hold them', () => {
    const childMap = new Map([
      ['urn:t1', ['urn:c1', 'urn:gone-1']],
      ['urn:t2', ['urn:gone-2']],
      ['urn:t3', ['urn:c3']],
    ])
    const loaded = withoutTombstones(childMap, isTombstone)
    expect(Object.fromEntries(loaded)).toEqual({ 'urn:t1': ['urn:c1'], 'urn:t2': [], 'urn:t3': ['urn:c3'] })
    expect(childMap.get('urn:t1')).toEqual(['urn:c1', 'urn:gone-1'])          // the drawn tree keeps them
  })

  it('hands back the same map while none is drawn', () => {
    const childMap = new Map([['urn:t1', ['urn:c1']]])
    expect(withoutTombstones(childMap, isTombstone)).toBe(childMap)
  })
})
