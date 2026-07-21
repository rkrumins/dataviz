import { describe, it, expect } from 'vitest'
import type { EdgeTypeSummary } from '@/providers/GraphDataProvider'
import { relDefToSchema } from './ontology-parsers'
import {
  caseFold,
  pickCanonicalSpelling,
  foldEdgeStats,
  mergedVariantsFor,
  foldRelTypeRows,
  canonicalizeRelDefsForSave,
  canonicalizeEntityDefsForSave,
} from './caseFold'

const edge = (id: string, count: number, sourceTypes: string[] = [], targetTypes: string[] = []): EdgeTypeSummary =>
  ({ id, name: id, count, sourceTypes, targetTypes })

describe('caseFold', () => {
  it('folds case + whitespace to one key', () => {
    expect(caseFold('TO')).toBe('to')
    expect(caseFold('To')).toBe('to')
    expect(caseFold(' to ')).toBe('to')
  })
})

describe('pickCanonicalSpelling', () => {
  it('prefers a spelling the graph actually uses', () => {
    const chosen = pickCanonicalSpelling(
      [{ spelling: 'TO', count: 0 }, { spelling: 'To', count: 5 }],
      new Set(['To']),
    )
    expect(chosen).toBe('To')
  })
  it('falls back to highest count, then first-seen', () => {
    expect(pickCanonicalSpelling([{ spelling: 'a', count: 1 }, { spelling: 'b', count: 9 }])).toBe('b')
    expect(pickCanonicalSpelling([{ spelling: 'a', count: 2 }, { spelling: 'b', count: 2 }])).toBe('a')
  })
})

describe('foldEdgeStats', () => {
  it('sums counts across physical spellings and preserves each spelling', () => {
    const fold = foldEdgeStats([edge('To', 3, ['Node'], ['Node']), edge('to', 2, ['Node'], ['Roots']), edge('TO', 1)])
    const g = fold.get('to')!
    expect(g.total).toBe(6)
    expect(g.spellings.map(s => s.spelling).sort()).toEqual(['TO', 'To', 'to'])
    expect(g.sourceTypes).toEqual(['Node'])
    expect(g.targetTypes.sort()).toEqual(['Node', 'Roots'])
  })
})

describe('mergedVariantsFor', () => {
  it('returns null when spelled one way', () => {
    expect(mergedVariantsFor('TO', ['TO'], undefined)).toBeNull()
  })
  it('lists canonical first, then off-spellings with graph counts', () => {
    const fold = foldEdgeStats([edge('To', 4)])
    const variants = mergedVariantsFor('TO', ['TO'], fold.get('to'))
    expect(variants).not.toBeNull()
    expect(variants![0].spelling).toBe('TO')
    expect(variants!.map(v => v.spelling)).toContain('To')
    expect(variants!.find(v => v.spelling === 'To')!.count).toBe(4)
  })
})

describe('foldRelTypeRows', () => {
  it('collapses TO + To into one canonical row, unioning classification', () => {
    const rows = [
      relDefToSchema('TO', { name: 'To', is_containment: false, is_lineage: false }),
      relDefToSchema('To', { name: 'To', is_containment: false, is_lineage: true }),
    ]
    const fold = foldEdgeStats([edge('To', 7)])
    const { rows: folded, variantsById, graphCountById } = foldRelTypeRows(rows, fold)
    expect(folded).toHaveLength(1)
    // Canonical prefers the physical spelling the graph uses ("To").
    expect(folded[0].id).toBe('To')
    expect(folded[0].isLineage).toBe(true)
    expect(graphCountById.get('To')).toBe(7)
    expect(variantsById.get('To')!.map(v => v.spelling).sort()).toEqual(['TO', 'To'])
  })

  it('does not fold or badge a type spelled only one way', () => {
    const rows = [relDefToSchema('HAS', { name: 'Has', is_containment: true })]
    const { rows: folded, variantsById } = foldRelTypeRows(rows, foldEdgeStats([edge('Has', 3)]))
    expect(folded).toHaveLength(1)
    // "HAS" declared vs "Has" physical IS a drift → badge present.
    expect(variantsById.get('HAS')!.map(v => v.spelling).sort()).toEqual(['HAS', 'Has'])
  })
})

describe('canonicalizeRelDefsForSave', () => {
  it('merges duplicate case-variant keys into one, ORs flags, notes the merge, remaps lists', () => {
    const relDefs = {
      TO: { name: 'To', is_containment: false, is_lineage: false, description: 'edge' },
      To: { name: 'To', is_containment: false, is_lineage: true },
    }
    const fold = foldEdgeStats([edge('To', 9)])
    const out = canonicalizeRelDefsForSave(relDefs, [], ['TO'], fold)
    // One surviving key (the physical spelling wins).
    expect(Object.keys(out.relDefs)).toEqual(['To'])
    const surviving = out.relDefs['To'] as Record<string, unknown>
    expect(surviving.is_lineage).toBe(true)
    expect(String(surviving.description)).toContain('also seen as: TO')
    // The lineage list entry "TO" is remapped onto the surviving canonical "To".
    expect(out.lineage).toEqual(['To'])
  })

  it('is a no-op when there are no case-variant duplicates', () => {
    const relDefs = { HAS: { name: 'Has', is_containment: true }, FLOWS: { name: 'Flows', is_lineage: true } }
    const out = canonicalizeRelDefsForSave(relDefs, ['HAS'], ['FLOWS'])
    expect(Object.keys(out.relDefs).sort()).toEqual(['FLOWS', 'HAS'])
    expect(out.merged).toEqual({})
  })
})

describe('canonicalizeEntityDefsForSave', () => {
  it('folds duplicate entity keys and rewrites hierarchy references to the survivor', () => {
    const entityDefs = {
      Node: { name: 'Node', hierarchy: { can_contain: ['node'], can_be_contained_by: ['Roots'] } },
      node: { name: 'node', hierarchy: { can_contain: [], can_be_contained_by: [] } },
      Roots: { name: 'Roots', hierarchy: { can_contain: ['Node'] } },
    }
    const out = canonicalizeEntityDefsForSave(entityDefs)
    expect(Object.keys(out.entityDefs).sort()).toEqual(['Node', 'Roots'])
    const node = out.entityDefs['Node'] as Record<string, unknown>
    const hier = node.hierarchy as Record<string, unknown>
    // Self-reference "node" was rewritten to the canonical "Node" (self-nesting stays intact).
    expect(hier.can_contain).toEqual(['Node'])
  })
})
