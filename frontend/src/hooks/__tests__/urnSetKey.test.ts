import { describe, it, expect } from 'vitest'
import { urnSetKey } from '../useGraphHydration'

describe('urnSetKey', () => {
  it('names a set of urns whatever their order, without sorting or joining them', () => {
    expect(urnSetKey(['urn:b', 'urn:a', 'urn:c'])).toBe(urnSetKey(new Set(['urn:c', 'urn:a', 'urn:b'])))
  })

  it('changes when the set does', () => {
    const base = urnSetKey(['urn:a', 'urn:b'])
    expect(urnSetKey(['urn:a', 'urn:b', 'urn:c'])).not.toBe(base)
    expect(urnSetKey(['urn:a', 'urn:x'])).not.toBe(base)
    expect(urnSetKey(['urn:ab'])).not.toBe(urnSetKey(['urn:a', 'b']))
  })

  it('is empty for no urns, as the old key was', () => {
    expect(urnSetKey([])).toBe('')
  })

  it('names 100,000 urns quickly', () => {
    const urns = Array.from({ length: 100_000 }, (_, i) => `urn:li:dataset:(urn:li:dataPlatform:hive,db.t${i},PROD)`)
    const started = performance.now()
    expect(urnSetKey(urns)).toMatch(/^100000:/)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
