import { describe, it, expect } from 'vitest'
import type { ViewLayerConfig } from '@/types/schema'
import type { NormalizedReferenceLayout } from '@/utils/referenceLayout'
import {
  appendLayer, insertLayer, recolorLayer, renameLayer, removeLayer, reorderLayer, setLayerNodeSortMode, setViewDefaultSortMode,
  clearLayerOrderKeys, updateLayer, isAutoLayerName, mapLayerToEntity, unmapLayer, unmapMovedAnchors, touchedBy, layoutPart,
  restoreLayoutPart, remapLayerAnchors, pruneTempAnchors, deleteColumn,
} from './layerMutations'
import { assignEntities } from './assignmentMutations'

const L = (id: string, name: string, order: number): ViewLayerConfig => ({
  id,
  name,
  entityTypes: [],
  order,
})

const base = (): ViewLayerConfig[] => [L('a', 'Alpha', 0), L('b', 'Beta', 1), L('c', 'Gamma', 2)]

describe('appendLayer', () => {
  it('adds the new layer at the end with order = current length', () => {
    const out = appendLayer(base(), L('d', 'Delta', 999))
    expect(out.map((l) => l.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(out[3].order).toBe(3) // normalized to length, ignoring the passed-in order
  })
  it('does not mutate the input array', () => {
    const input = base()
    appendLayer(input, L('d', 'Delta', 3))
    expect(input).toHaveLength(3)
  })
  it('appends onto an empty list at order 0', () => {
    expect(appendLayer([], L('a', 'Alpha', 5))[0].order).toBe(0)
  })
})

describe('insertLayer', () => {
  it('inserts between two layers and renumbers everything after it', () => {
    const out = insertLayer(base(), L('n', 'New', 99), 1)
    expect(out.map((l) => l.id)).toEqual(['a', 'n', 'b', 'c'])
    expect(out.map((l) => l.order)).toEqual([0, 1, 2, 3])
  })
  it('inserts first at 0 and appends at length', () => {
    expect(insertLayer(base(), L('n', 'New', 0), 0).map((l) => l.id)).toEqual(['n', 'a', 'b', 'c'])
    expect(insertLayer(base(), L('n', 'New', 0), 3).map((l) => l.id)).toEqual(['a', 'b', 'c', 'n'])
  })
  it('clamps an index out of range rather than losing the layer', () => {
    expect(insertLayer(base(), L('n', 'New', 0), -4).map((l) => l.id)).toEqual(['n', 'a', 'b', 'c'])
    expect(insertLayer(base(), L('n', 'New', 0), 42).map((l) => l.id)).toEqual(['a', 'b', 'c', 'n'])
  })
  it('does not mutate the input array', () => {
    const input = base()
    insertLayer(input, L('n', 'New', 0), 1)
    expect(input.map((l) => l.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('recolorLayer', () => {
  it('recolours only the matching layer', () => {
    const out = recolorLayer(base(), 'b', '#10b981')
    expect(out.find((l) => l.id === 'b')?.color).toBe('#10b981')
    expect(out.filter((l) => l.id !== 'b').every((l) => l.color === undefined)).toBe(true)
  })
  it('returns the same array when nothing changes', () => {
    const input = base()
    expect(recolorLayer(input, 'zzz', '#000')).toBe(input)
    const coloured = recolorLayer(input, 'a', '#111111')
    expect(recolorLayer(coloured, 'a', '#111111')).toBe(coloured)
  })
})

describe('renameLayer', () => {
  it('renames only the matching layer, preserving order and the others', () => {
    const out = renameLayer(base(), 'b', 'Beta renamed')
    expect(out.map((l) => l.name)).toEqual(['Alpha', 'Beta renamed', 'Gamma'])
    expect(out.map((l) => l.order)).toEqual([0, 1, 2])
  })
  it('is a no-op when the id is not found', () => {
    expect(renameLayer(base(), 'zzz', 'Nope').map((l) => l.name)).toEqual(['Alpha', 'Beta', 'Gamma'])
  })
})

describe('removeLayer', () => {
  it('removes the matching layer and re-normalizes order to 0..n-1', () => {
    const out = removeLayer(base(), 'b')
    expect(out.map((l) => l.id)).toEqual(['a', 'c'])
    expect(out.map((l) => l.order)).toEqual([0, 1]) // Gamma re-numbered 2 -> 1
  })
  it('is a no-op when the id is not found', () => {
    expect(removeLayer(base(), 'zzz').map((l) => l.id)).toEqual(['a', 'b', 'c'])
  })
  it('can empty the list', () => {
    expect(removeLayer([L('a', 'Alpha', 0)], 'a')).toEqual([])
  })
  it('keeps the others in the order they are shown when the stored array is in another order', () => {
    const out = removeLayer([L('a', 'A', 0), L('c', 'C', 2), L('b', 'B', 1)], 'a')
    expect([...out].sort((x, y) => x.order - y.order).map((l) => l.id)).toEqual(['b', 'c'])
  })
})

describe('reorderLayer', () => {
  it('drags a layer RIGHT: lands after the drop target', () => {
    // a,b,c,d — drag a onto c → b,c,a,d (a lands after c)
    const out = reorderLayer([L('a', 'A', 0), L('b', 'B', 1), L('c', 'C', 2), L('d', 'D', 3)], 'a', 'c')
    expect(out.map((l) => l.id)).toEqual(['b', 'c', 'a', 'd'])
    expect(out.map((l) => l.order)).toEqual([0, 1, 2, 3]) // re-normalized
  })
  it('drags a layer LEFT: lands before the drop target', () => {
    // a,b,c,d — drag d onto b → a,d,b,c (d lands before b)
    const out = reorderLayer([L('a', 'A', 0), L('b', 'B', 1), L('c', 'C', 2), L('d', 'D', 3)], 'd', 'b')
    expect(out.map((l) => l.id)).toEqual(['a', 'd', 'b', 'c'])
  })
  it('is a no-op when dragged onto itself', () => {
    expect(reorderLayer(base(), 'b', 'b').map((l) => l.id)).toEqual(['a', 'b', 'c'])
  })
  it('is a no-op when either id is missing', () => {
    expect(reorderLayer(base(), 'a', 'zzz').map((l) => l.id)).toEqual(['a', 'b', 'c'])
    expect(reorderLayer(base(), 'zzz', 'a').map((l) => l.id)).toEqual(['a', 'b', 'c'])
  })
  // Saved layers are not always stored in the order they are shown (`order`): a wizard save or an
  // API write can keep its own array order. Every move is in what the reader SEES.
  const shown = (out: ViewLayerConfig[]) => [...out].sort((x, y) => x.order - y.order).map((l) => l.id)
  const outOfOrder = () => [L('a', 'A', 0), L('c', 'C', 2), L('b', 'B', 1)]   // shown a, b, c

  it('moves left in display order when the stored array is in another order', () => {
    expect(shown(reorderLayer(outOfOrder(), 'c', 'b'))).toEqual(['a', 'c', 'b'])
    expect(shown(reorderLayer(outOfOrder(), 'b', 'a'))).toEqual(['b', 'a', 'c'])
  })

  it('moves right in display order when the stored array is in another order', () => {
    expect(shown(reorderLayer(outOfOrder(), 'b', 'c'))).toEqual(['a', 'c', 'b'])
    expect(shown(reorderLayer(outOfOrder(), 'a', 'b'))).toEqual(['b', 'a', 'c'])
  })
})

describe('setLayerNodeSortMode', () => {
  const layout = (
    layers: ViewLayerConfig[],
    assignments: Record<string, { layerId: string; inheritsChildren: boolean; orderKey?: string }> = {},
  ) => ({ layers, assignments })

  it('sets and clears the per-layer override', () => {
    const withDesc = setLayerNodeSortMode(layout(base()), 'b', 'alpha-desc')
    expect(withDesc.layers.find((l) => l.id === 'b')?.nodeSortMode).toBe('alpha-desc')
    const cleared = setLayerNodeSortMode(withDesc, 'b', null)
    expect(cleared.layers.find((l) => l.id === 'b')?.nodeSortMode).toBeUndefined()
  })

  it('is a no-op (same layout) for an unknown layer or an unchanged mode', () => {
    const input = layout(base())
    expect(setLayerNodeSortMode(input, 'zzz', 'alpha-desc')).toBe(input)
    expect(setLayerNodeSortMode(input, 'a', null)).toBe(input)
  })

  it('entering custom seeds orderKeys for the layer\'s unkeyed entries in seed order', () => {
    const input = layout(base(), {
      'urn:x': { layerId: 'a', inheritsChildren: true },
      'urn:y': { layerId: 'a', inheritsChildren: true },
      'urn:other': { layerId: 'b', inheritsChildren: true },
    })
    const out = setLayerNodeSortMode(input, 'a', 'custom', ['urn:y', 'urn:x'])
    const ky = out.assignments['urn:y'].orderKey
    const kx = out.assignments['urn:x'].orderKey
    expect(ky && kx && ky < kx).toBe(true) // seeded following the given visual order
    expect(out.assignments['urn:other'].orderKey).toBeUndefined() // other layers untouched
  })

  it('re-entering custom keeps existing keys and appends new entries after them', () => {
    const input = layout(
      [{ ...base()[0], nodeSortMode: 'custom' as const }, base()[1], base()[2]],
      {
        'urn:x': { layerId: 'a', inheritsChildren: true, orderKey: 'a1' },
        'urn:new': { layerId: 'a', inheritsChildren: true },
      },
    )
    const out = setLayerNodeSortMode(input, 'a', 'custom', ['urn:new', 'urn:x'])
    expect(out.assignments['urn:x'].orderKey).toBe('a1') // untouched
    const kNew = out.assignments['urn:new'].orderKey
    expect(kNew && kNew > 'a1').toBe(true) // appended after the largest existing key
  })

  it('leaving custom keeps orderKeys (inert in alpha modes, restored on re-entry)', () => {
    const input = layout(
      [{ ...base()[0], nodeSortMode: 'custom' as const }, base()[1], base()[2]],
      { 'urn:x': { layerId: 'a', inheritsChildren: true, orderKey: 'a1' } },
    )
    const out = setLayerNodeSortMode(input, 'a', 'alpha-asc')
    expect(out.assignments['urn:x'].orderKey).toBe('a1')
  })
})

describe('setViewDefaultSortMode', () => {
  it('sets the default and clears asc/desc overrides but keeps custom layers', () => {
    const layers: ViewLayerConfig[] = [
      { ...L('a', 'Alpha', 0), nodeSortMode: 'alpha-asc' },
      { ...L('b', 'Beta', 1), nodeSortMode: 'custom' },
      L('c', 'Gamma', 2),
    ]
    const out = setViewDefaultSortMode({ layers, assignments: {} }, 'alpha-desc')
    expect(out.defaultNodeSortMode).toBe('alpha-desc')
    expect(out.layers.find((l) => l.id === 'a')?.nodeSortMode).toBeUndefined()
    expect(out.layers.find((l) => l.id === 'b')?.nodeSortMode).toBe('custom')
    expect(out.layers.find((l) => l.id === 'c')?.nodeSortMode).toBeUndefined()
  })
})

describe('clearLayerOrderKeys', () => {
  const entry = (layerId: string, orderKey?: string) => ({
    layerId,
    inheritsChildren: true,
    ...(orderKey ? { orderKey } : {}),
  })

  it('drops the layer\'s orderKeys and mode override, leaving other layers alone', () => {
    const out = clearLayerOrderKeys({
      layers: [{ ...L('a', 'Alpha', 0), nodeSortMode: 'custom' }, L('b', 'Beta', 1)],
      assignments: {
        'urn:x': entry('a', 'a1'),
        'urn:y': entry('a'),
        'urn:z': entry('b', 'a9'),
      },
    }, 'a')
    expect(out.layers.find(l => l.id === 'a')?.nodeSortMode).toBeUndefined()
    expect(out.assignments['urn:x'].orderKey).toBeUndefined()
    expect(out.assignments['urn:y']).toEqual(entry('a'))
    expect(out.assignments['urn:z'].orderKey).toBe('a9') // other layer untouched
  })

  it('is a no-op (same layout) when there is nothing to reset', () => {
    const input = { layers: base(), assignments: { 'urn:x': entry('b') } }
    expect(clearLayerOrderKeys(input, 'a')).toBe(input)
  })

  it('preserves defaultNodeSortMode', () => {
    const out = clearLayerOrderKeys({
      layers: [{ ...L('a', 'Alpha', 0), nodeSortMode: 'custom' }],
      assignments: {},
      defaultNodeSortMode: 'type-asc',
    }, 'a')
    expect(out.defaultNodeSortMode).toBe('type-asc')
  })
})

describe('setViewDefaultSortMode — widened modes', () => {
  it('accepts the property-derived modes as view defaults', () => {
    const out = setViewDefaultSortMode({ layers: base(), assignments: {} }, 'count-desc')
    expect(out.defaultNodeSortMode).toBe('count-desc')
  })
})

describe('updateLayer', () => {
  it('changes one layer\'s fields, its properties among them, and leaves the rest', () => {
    const out = updateLayer(base(), 'b', { description: 'Cleaned', properties: { owner: 'ana', sla: '1h' } })
    expect(out.find((l) => l.id === 'b')).toMatchObject({ name: 'Beta', description: 'Cleaned', properties: { owner: 'ana', sla: '1h' } })
    expect(out.find((l) => l.id === 'a')).toEqual(base()[0])
  })

  it('returns the same array when nothing would change, or the layer is missing', () => {
    const layers = updateLayer(base(), 'b', { properties: { owner: 'ana' } })
    expect(updateLayer(layers, 'b', { properties: { owner: 'ana' } })).toBe(layers)
    expect(updateLayer(layers, 'zz', { name: 'X' })).toBe(layers)
  })
})

describe('renameLayer and updateLayer — a name someone chose', () => {
  it('a rename stops the name following the entity the column is mapped to', () => {
    const mapped = [{ ...L('a', 'Finance', 0), anchorUrn: 'fin', nameFromAnchor: true }]
    expect(renameLayer(mapped, 'a', 'Money')[0]).toEqual({ ...L('a', 'Money', 0), anchorUrn: 'fin' })
    expect(updateLayer(mapped, 'a', { name: 'Money' })[0]).toEqual({ ...L('a', 'Money', 0), anchorUrn: 'fin' })
    // Settings that leave the name alone leave it following.
    expect(updateLayer(mapped, 'a', { color: '#111111' })[0]).toMatchObject({ nameFromAnchor: true })
  })
})

// ── Mapping a column to an entity ───────────────────────────────────────────
// The column IS the entity: `anchorUrn`, and the entity's own placement in that column (inheriting,
// so what is inside it follows). The two always change together.

const layoutOf = (layers: ViewLayerConfig[], assignments: NormalizedReferenceLayout['assignments'] = {}): NormalizedReferenceLayout =>
  ({ layers, assignments })
const placed = (layerId: string) => ({ layerId, inheritsChildren: true, assignedBy: 'user' as const, assignedAt: 't0' })

describe('isAutoLayerName', () => {
  it('is a name nobody chose: empty, a fresh "New layer", or one that follows its entity', () => {
    expect(['', '  ', 'New layer', 'New layer 3', 'new layer'].map((name) => isAutoLayerName({ name }))).toEqual([true, true, true, true, true])
    expect(isAutoLayerName({ name: 'Finance', nameFromAnchor: true })).toBe(true)
    expect(isAutoLayerName({ name: 'Finance' })).toBe(false)
    expect(isAutoLayerName({ name: 'New layer of apps' })).toBe(false)
  })
})

describe('mapLayerToEntity', () => {
  const start = () => layoutOf(
    [L('a', 'New layer', 0), L('b', 'Domains', 1), { ...L('c', 'Finance', 2), anchorUrn: 'fin', nameFromAnchor: true }],
    { fin: placed('c'), sales: placed('b') },
  )

  it('maps the layer to the entity and moves the entity\'s placement into it, inheriting', () => {
    const before = start()
    const out = mapLayerToEntity(before, 'a', 'sales', { name: 'Sales' })
    expect(out.layers.find((l) => l.id === 'a')).toMatchObject({ anchorUrn: 'sales', nameFromAnchor: true, name: 'Sales' })
    expect(out.assignments.sales).toMatchObject({ layerId: 'a', inheritsChildren: true })
    expect(out.assignments.fin).toBe(before.assignments.fin)
  })

  it('takes the entity from any other column mapped to it', () => {
    const out = mapLayerToEntity(start(), 'a', 'fin', { name: 'Finance' })
    expect(out.layers.find((l) => l.id === 'c')?.anchorUrn).toBeUndefined()
    expect(out.layers.find((l) => l.id === 'a')?.anchorUrn).toBe('fin')
    expect(out.assignments.fin.layerId).toBe('a')
  })

  it('keeps a name someone chose; follows the entity only where the name was nobody\'s', () => {
    const out = mapLayerToEntity(start(), 'b', 'sales', { name: 'Sales' })
    expect(out.layers.find((l) => l.id === 'b')).toEqual({ ...L('b', 'Domains', 1), anchorUrn: 'sales' })
    // Re-mapped, a column named after its entity is named after the new one.
    expect(mapLayerToEntity(start(), 'c', 'sales', { name: 'Sales' }).layers.find((l) => l.id === 'c'))
      .toMatchObject({ anchorUrn: 'sales', name: 'Sales', nameFromAnchor: true })
  })

  it('drops the placements of what is inside it that kept it in its old column', () => {
    const before = layoutOf([L('a', 'New layer', 0), L('b', 'Domains', 1)],
      { sales: placed('b'), crm: { layerId: 'b', inheritsChildren: true, orderKey: 'a0' } })
    const out = mapLayerToEntity(before, 'a', 'sales', { clearDescendants: ['crm'] })
    expect(Object.keys(out.assignments)).toEqual(['sales'])
  })

  it('returns the SAME layout when it already is so, or the layer is missing', () => {
    const mapped = start()
    expect(mapLayerToEntity(mapped, 'c', 'fin')).toBe(mapped)
    expect(mapLayerToEntity(mapped, 'zz', 'fin')).toBe(mapped)
  })
})

describe('unmapLayer', () => {
  const mapped = () => layoutOf([{ ...L('c', 'Finance', 0), anchorUrn: 'fin', nameFromAnchor: true }], { fin: placed('c') })

  it('clears the mapping; the entity keeps its placement, so it shows as a row in the column', () => {
    const before = mapped()
    const out = unmapLayer(before, 'c')
    expect(out.layers[0].anchorUrn).toBeUndefined()
    expect(out.assignments).toBe(before.assignments)
  })

  it('keeps the name the column showed, still free to follow a new mapping', () => {
    expect(unmapLayer(mapped(), 'c', { name: 'Money' }).layers[0]).toMatchObject({ name: 'Money', nameFromAnchor: true })
  })

  it('returns the SAME layout for a layer that is not mapped, or missing', () => {
    const out = unmapLayer(mapped(), 'c')
    expect(unmapLayer(out, 'c')).toBe(out)
    expect(unmapLayer(out, 'zz')).toBe(out)
  })
})

describe('unmapMovedAnchors', () => {
  const before = () => layoutOf(
    [{ ...L('fin', 'Finance', 0), anchorUrn: 'Finance' }, L('domains', 'Domains', 1), { ...L('dup', 'Other', 2), anchorUrn: 'Sales' }],
    { Finance: placed('fin'), Sales: placed('domains') },
  )

  it('a column whose entity was placed elsewhere is no longer mapped to it', () => {
    const b = before()
    const out = unmapMovedAnchors(b, assignEntities(b, ['Finance'], 'domains'))
    expect(out.layers.find((l) => l.id === 'fin')?.anchorUrn).toBeUndefined()
    expect(out.assignments.Finance.layerId).toBe('domains')
  })

  it('leaves columns the change did not take their entity from — the same layout when there are none', () => {
    const b = before()
    const other = assignEntities(b, ['Sales'], 'fin')
    // `dup` never held Sales (its placement was in Domains): it stays as it was.
    expect(unmapMovedAnchors(b, other)).toBe(other)
  })
})

describe('touchedBy / layoutPart / restoreLayoutPart — one change taken back alone', () => {
  const start = () => layoutOf([L('a', 'New layer', 0), L('b', 'Domains', 1)], { sales: placed('b'), mkt: placed('b') })

  it('says which layers\' mappings and which placements a change touched — no more', () => {
    const before = start()
    const after = mapLayerToEntity(before, 'a', 'sales', { name: 'Sales' })
    expect(touchedBy(before, after)).toEqual({ layerIds: ['a'], urns: ['sales'] })
    // A column inserted is touched; the ones it shifted along are not.
    const inserted = { ...before, layers: insertLayer(before.layers, L('n', 'Sales', 0), 1) }
    expect(touchedBy(before, inserted)).toEqual({ layerIds: ['n'], urns: [] })
  })

  it('discard puts back only what the change touched — a later edit stays', () => {
    const before = start()
    const after = mapLayerToEntity(before, 'a', 'sales', { name: 'Sales' })
    const touch = touchedBy(before, after)
    // Since: Marketing moved, column b recoloured.
    const later = assignEntities({ ...after, layers: recolorLayer(after.layers, 'b', '#123456') }, ['mkt'], 'a')
    const back = restoreLayoutPart(later, layoutPart(before, touch))
    expect(back.layers.find((l) => l.id === 'a')).toEqual(L('a', 'New layer', 0))
    expect(back.assignments.sales).toBe(before.assignments.sales)
    expect(back.assignments.mkt.layerId).toBe('a')
    expect(back.layers.find((l) => l.id === 'b')?.color).toBe('#123456')
    // Redo puts the change back, alone.
    const again = restoreLayoutPart(back, layoutPart(after, touch))
    expect(again.layers.find((l) => l.id === 'a')).toMatchObject({ anchorUrn: 'sales', name: 'Sales' })
    expect(again.assignments.sales.layerId).toBe('a')
  })

  it('a column the change added goes on discard, and comes back where it was on redo', () => {
    const before = start()
    const added = mapLayerToEntity({ ...before, layers: insertLayer(before.layers, L('n', '', 0), 1) }, 'n', 'sales', { name: 'Sales' })
    const touch = touchedBy(before, added)
    const back = restoreLayoutPart(added, layoutPart(before, touch))
    expect(back.layers.map((l) => [l.id, l.order])).toEqual([['a', 0], ['b', 1]])
    expect(back.assignments.sales).toBe(before.assignments.sales)
    const again = restoreLayoutPart(back, layoutPart(added, touch))
    expect(again.layers.map((l) => l.id)).toEqual(['a', 'n', 'b'])
    expect(again.layers[1]).toMatchObject({ anchorUrn: 'sales', name: 'Sales', order: 1 })
  })

  it('is plain data, so it survives a reload as it is', () => {
    const before = start()
    const after = mapLayerToEntity(before, 'a', 'sales')
    const part = layoutPart(before, touchedBy(before, after))
    expect(restoreLayoutPart(after, JSON.parse(JSON.stringify(part)))).toEqual(restoreLayoutPart(after, part))
  })

  it('returns the SAME layout when the layout already holds the part', () => {
    const before = start()
    expect(restoreLayoutPart(before, layoutPart(before, { layerIds: ['a'], urns: ['sales', 'nobody'] }))).toBe(before)
  })
})

describe('remapLayerAnchors / pruneTempAnchors — a column mapped to an entity new in this draft', () => {
  const temp = 'urn:staged:domain:new-1'
  const draft = () => layoutOf([{ ...L('a', 'Finance', 0), anchorUrn: temp }, { ...L('b', 'Sales', 1), anchorUrn: 'sales' }])

  it('on save, the column follows its entity to the urn the save gave it', () => {
    const out = remapLayerAnchors(draft(), new Map([[temp, 'urn:li:domain:finance']]))
    expect(out.layers.map((l) => l.anchorUrn)).toEqual(['urn:li:domain:finance', 'sales'])
    const none = draft()
    expect(remapLayerAnchors(none, new Map([['other', 'x']]))).toBe(none)
  })

  it('a column still mapped to a temp urn after the save is mapped to nothing — its create was discarded', () => {
    expect(pruneTempAnchors(draft()).layers.map((l) => l.anchorUrn)).toEqual([undefined, 'sales'])
    const clean = pruneTempAnchors(draft())
    expect(pruneTempAnchors(clean)).toBe(clean)
  })
})

describe('deleteColumn — a column taken out of the view, with the placements in it', () => {
  const start = () => layoutOf(
    [L('a', 'Domains', 0), { ...L('b', 'Picked', 1), logicalNodes: [{ id: 'g', name: 'Shelf', type: 'group', children: [{ id: 'g2', name: 'Deep', type: 'group' }] }] }, L('c', 'Apps', 2)],
    { sales: placed('a'), ops: placed('b'), archive: { ...placed('b'), logicalNodeId: 'g2' }, quotes: placed('c') },
  )

  it('removes the layer, its groups, and every placement in it — the rest stays as it was', () => {
    const before = start()
    const after = deleteColumn(before, 'b')
    expect(after.layers.map((l) => [l.id, l.order])).toEqual([['a', 0], ['c', 1]])
    expect(Object.keys(after.assignments).sort()).toEqual(['quotes', 'sales'])
    expect(after.assignments.sales).toBe(before.assignments.sales)
  })

  it('is taken back whole — the layer where it stood, its groups and placements — and a later edit stays', () => {
    const before = start()
    const after = deleteColumn(before, 'b')
    const touch = touchedBy(before, after)
    expect(touch).toEqual({ layerIds: ['b'], urns: ['ops', 'archive'] })
    const later = assignEntities(after, ['sales'], 'c')
    const back = restoreLayoutPart(later, layoutPart(before, touch))
    expect(back.layers.map((l) => l.id)).toEqual(['a', 'b', 'c'])
    expect(back.layers[1].logicalNodes).toEqual(before.layers[1].logicalNodes)
    expect(back.assignments.archive).toEqual(before.assignments.archive)
    expect(back.assignments.sales.layerId).toBe('c')
  })

  it('returns the SAME layout for a layer that is not there', () => {
    const before = start()
    expect(deleteColumn(before, 'nope')).toBe(before)
  })
})
