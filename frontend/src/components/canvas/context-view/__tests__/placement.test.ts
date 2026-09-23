import { describe, expect, it } from 'vitest'
import { buildPlacements } from '../placement'

// My Data Domain (D) contains Apps (G) which contains App A (A) and App B (B). D and G are shown in
// "Domains"; App A is placed in "Layer 2" and App B stays with its parent.
const parentMap = new Map([['G', 'D'], ['A', 'G'], ['B', 'G']])
const nodeLayerMap = new Map([['D', 'dom'], ['G', 'dom'], ['A', 'l2'], ['B', 'dom']])
const names: Record<string, string> = { D: 'My Data Domain', G: 'Apps', A: 'App A', B: 'App B', R: 'Org' }
const base = {
  parentMap, nodeLayerMap,
  facts: (id: string) => names[id] ? { name: names[id], type: 'T' } : undefined,
  layerName: (id: string) => ({ dom: 'Domains', l2: 'Layer 2' } as Record<string, string>)[id] ?? id,
}

describe('placement: an entity placed apart from its parent carries its path in the data', () => {
  it('only entities in a different column than their parent are placements', () => {
    const { placements } = buildPlacements({ ...base, ancestry: new Map([['D', []]]) })
    expect([...placements.keys()]).toEqual(['A'])
  })

  it('gives the full path root → parent, with both columns', () => {
    const p = buildPlacements({ ...base, ancestry: new Map([['D', []]]) }).placements.get('A')!
    expect(p.path.map((a) => a.displayName)).toEqual(['My Data Domain', 'Apps'])
    expect([p.complete, p.parentLayerName, p.placedLayerName]).toEqual([true, 'Domains', 'Layer 2'])
  })

  it('is partial until the ancestors above the loaded ones are known, and asks for them', () => {
    const first = buildPlacements({ ...base, ancestry: new Map() })
    expect(first.placements.get('A')!.complete).toBe(false)
    expect(first.unknownTops).toEqual(['D'])
    const known = buildPlacements({
      ...base, ancestry: new Map([['D', [{ urn: 'R', displayName: 'Org', entityType: 'T' } as never]]]),
    })
    expect(known.placements.get('A')!.path.map((a) => a.displayName)).toEqual(['Org', 'My Data Domain', 'Apps'])
    expect(known.unknownTops).toEqual([])
  })
})
