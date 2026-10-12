/**
 * What the canvas asks `/edges/aggregated` about: the rows the reader sees
 * and has not opened, read off the RENDERED tree.
 *
 * The old rule walked store parents: a node was a target when its store
 * parent was expanded or it had none. An anchored column draws its anchor as
 * the column itself and the anchor's children as its rows, and the anchor is
 * never "expanded", so the anchors (store roots) were the targets and the
 * rows never were. The rows got no roll-up lines.
 */
import { describe, it, expect } from 'vitest'

import { renderedAggregationTargets, unparentedRows } from '../aggregationTargets'
import type { HierarchyNode } from '@/types/hierarchy'

const row = (id: string, children: HierarchyNode[] = [], extra: Partial<HierarchyNode> = {}): HierarchyNode => ({
  id, urn: id, typeId: 'dataset', name: id, data: { urn: id }, children,
  depth: 0, entityTypeOption: 'dataset', tags: [], ...extra,
})

const group = (id: string, members: HierarchyNode[]): HierarchyNode =>
  row(id, members, { urn: '', isLogical: true })

const targets = (byLayer: Record<string, HierarchyNode[]>, expanded: string[] = []) =>
  renderedAggregationTargets(new Map(Object.entries(byLayer)), new Set(expanded)).sort()

describe('renderedAggregationTargets', () => {
  it("an anchored column's rows are the targets; the anchor, which is not a row, is not", () => {
    // useLayerAssignment hands an anchored column its anchor's CHILDREN as
    // the layer's roots; the anchor itself appears nowhere in the tree.
    expect(targets({ src: [row('SRC.a'), row('SRC.b')], dst: [row('DST.x')] }))
      .toEqual(['DST.x', 'SRC.a', 'SRC.b'])
  })

  it('an open row stands aside for its children', () => {
    expect(targets({ L: [row('p', [row('c1'), row('c2')]), row('q')] }, ['p']))
      .toEqual(['c1', 'c2', 'q'])
  })

  it("a closed row is the target, not what is inside it", () => {
    expect(targets({ L: [row('p', [row('c1', [row('g1')])])] })).toEqual(['p'])
  })

  it('a logical group is never a target; its members are, whether it is open or closed', () => {
    const byLayer = () => ({ L: [group('logical:g', [row('m1'), row('m2', [row('m2.c')])])] })
    expect(targets(byLayer())).toEqual(['m1', 'm2'])
    expect(targets(byLayer(), ['logical:g'])).toEqual(['m1', 'm2'])
  })

  it('asks by urn, once each', () => {
    const a = row('node-a', [], { urn: 'urn:a' })
    expect(targets({ L1: [a], L2: [{ ...a, id: 'node-a-2' }] })).toEqual(['urn:a'])
  })
})

describe('unparentedRows — drawn rows whose containment parent is not loaded', () => {
  const unparented = (byLayer: Record<string, HierarchyNode[]>, parents: Record<string, string>, anchors?: Record<string, string>) =>
    unparentedRows(new Map(Object.entries(byLayer)), new Map(Object.entries(parents)),
      anchors && new Map(Object.entries(anchors))).sort()

  it("names the columns' top rows (and a group's members) that no loaded parent holds", () => {
    // `split` is placed apart from a parent that is not loaded; `anchored`
    // sits under its column's anchor, which is.
    expect(unparented(
      { A: [row('top', [row('child')])], B: [row('split'), row('anchored')], C: [group('logical:g', [row('member')])] },
      { child: 'top', anchored: 'ANCHOR' },
    )).toEqual(['member', 'split', 'top'])
  })

  it('names an anchor whose parent is not loaded, so what holds its column is known', () => {
    // A is drawn as column L2 and nothing loaded holds it; B sits under P,
    // which is loaded. Neither is a row, so the walk never reaches them.
    expect(unparented(
      { L2: [row('a1'), row('a2')], L3: [row('b1')] },
      { a1: 'A', a2: 'A', b1: 'B', B: 'P' },
      { A: 'L2', B: 'L3' },
    )).toEqual(['A'])
  })
})
