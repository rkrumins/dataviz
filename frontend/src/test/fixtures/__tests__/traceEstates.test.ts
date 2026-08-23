import { describe, it, expect } from 'vitest'
import { cfoEstate, rootsNodeEstate } from '../traceEstates'

describe('traceEstates', () => {
  it('estates are well-formed (every containment target exists; focus present)', () => {
    for (const e of [cfoEstate(), rootsNodeEstate(3), rootsNodeEstate(10)]) {
      const ids = new Set(e.model.nodes.map(n => n.urn))
      for (const c of e.model.containmentEdges) { expect(ids.has(c.sourceUrn)).toBe(true); expect(ids.has(c.targetUrn)).toBe(true) }
      expect(ids.has(e.model.focusUrn)).toBe(true)
    }
  })
})
