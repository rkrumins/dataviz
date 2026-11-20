/**
 * Options stay put while counts move, a selection never vanishes from its own
 * menu, and a zero is a real zero — not "still loading".
 */
import { describe, expect, it } from 'vitest'
import { countMap, sourceAfterWorkspaces, withCounts } from '../facetOptions'

const TAGS = ['finance', 'pii', 'kpi']

describe('withCounts', () => {
  it('keeps the universe order and counts what the filtered facets omit as 0', () => {
    const counts = countMap([{ value: 'pii', count: 4 }], r => r.value, r => r.count)
    expect(withCounts(TAGS, t => t, counts)).toEqual([
      { option: 'finance', count: 0 },
      { option: 'pii', count: 4 },
      { option: 'kpi', count: 0 },
    ])
  })

  it('leaves counts undefined while they are loading — nothing is dimmed on a guess', () => {
    expect(withCounts(TAGS, t => t, null).every(o => o.count === undefined)).toBe(true)
  })

  it('keeps a selected value the universe no longer lists', () => {
    const out = withCounts(TAGS, t => t, new Map(), ['legacy'], id => id)
    expect(out.map(o => o.option)).toEqual([...TAGS, 'legacy'])
  })
})

describe('sourceAfterWorkspaces', () => {
  it('keeps a source while its workspace is chosen, or none is', () => {
    expect(sourceAfterWorkspaces('ds1', ['ws1', 'ws2'], 'ws1')).toBe('ds1')
    expect(sourceAfterWorkspaces('ds1', [], 'ws1')).toBe('ds1')
  })
  it('drops it once its workspace is not chosen — it would match nothing', () => {
    expect(sourceAfterWorkspaces('ds1', ['ws2'], 'ws1')).toBeNull()
  })
  it('leaves a source whose workspace it cannot tell', () => {
    expect(sourceAfterWorkspaces('ds1', ['ws2'], undefined)).toBe('ds1')
  })
})
