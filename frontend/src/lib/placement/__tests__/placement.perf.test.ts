/**
 * Regression ceilings, not budgets: vitest runs many workers that contend
 * for CPU, so the numbers here are tripwires several times what a quiet
 * run measures. The ~10 ms target is the rule loop over 50k entities (the
 * legacy resolveLayerAssignmentIn measured 10.2 ms); a whole placeAll pass
 * is Map-bound, like today's canvas traversal.
 */
import { describe, expect, it } from 'vitest'
import { compilePlacementSpec, matchRule, placeAll, type PlacementFacts } from '../placement'

const N = 50_000
const TYPES = ['domain', 'system', 'dataset', 'table', 'view', 'column', 'dashboard', 'chart', 'job', 'task']

const spec = compilePlacementSpec({
  content: { entityScope: 'all' },
  layout: {
    referenceLayout: {
      layers: [
        { id: 'domains', order: 0, entityTypes: ['domain', 'System'] },
        {
          id: 'data', order: 1, entityTypes: ['dataset', 'Table', 'view'],
          rules: [
            { id: 'pii', priority: 10, tags: ['pii'] },
            { id: 'hive', priority: 5, urnPattern: 'urn:li:dataset:(urn:li:dataPlatform:hive,*' },
            { id: 'gold', priority: 5, entityTypes: ['table'], conditions: [{ field: 'tier', operator: 'equals', value: 'gold' }] },
          ],
        },
        { id: 'reports', order: 2, entityTypes: ['dashboard', 'chart'] },
        { id: 'other', order: 3, entityTypes: [], showUnassigned: true },
      ],
      // A few hand placements, so explicit and inherited tiers are exercised too.
      assignments: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`urn:e:${i * 97}`, { layerId: 'reports' }])),
    },
  },
})

const facts: PlacementFacts[] = Array.from({ length: N }, (_, i) => ({
  urn: i % 7 === 0 ? `urn:li:dataset:(urn:li:dataPlatform:hive,db.t${i},PROD)` : `urn:e:${i}`,
  entityType: TYPES[i % TYPES.length],
  displayName: `entity ${i}`,
  tags: i % 11 === 0 ? ['pii'] : [],
  properties: { tier: i % 3 === 0 ? 'Gold' : 'silver' },
}))

function median(run: () => void): number {
  run()   // warm up
  const times: number[] = []
  for (let i = 0; i < 5; i++) {
    const start = performance.now()
    run()
    times.push(performance.now() - start)
  }
  return times.sort((a, b) => a - b)[2]
}

describe('placement performance (50k entities)', () => {
  it('matchRule over every entity stays near the rule-loop budget', () => {
    const REGRESSION_CEILING_MS = 50     // measured ~4 ms
    let matched = 0
    const ms = median(() => {
      matched = 0
      for (const f of facts) if (matchRule(spec, f)) matched++
    })
    expect(matched).toBeGreaterThan(0)
    expect(ms).toBeLessThan(REGRESSION_CEILING_MS)
  })

  it('placeAll over a 50k forest', () => {
    const REGRESSION_CEILING_MS = 1000   // measured ~100 ms
    const byUrn = new Map(facts.map((f) => [f.urn, f]))
    const urns = facts.map((f) => f.urn)
    // Four children per parent: a deep, wide containment forest.
    const parentOf = new Map(urns.map((u, i) => [u, i > 0 ? [urns[Math.floor((i - 1) / 4)]] : []]))
    let size = 0
    const ms = median(() => {
      size = placeAll(spec, urns, (u) => byUrn.get(u) ?? null, (u) => parentOf.get(u) ?? []).size
    })
    expect(size).toBe(N)
    expect(ms).toBeLessThan(REGRESSION_CEILING_MS)
  })
})
