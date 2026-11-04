/**
 * Show where they sit: a subset view's matches, each drawn inside the containers
 * its base draws it in — the nearest `inLayer` of its path. A container is a row of
 * context (a `logical:` row: never counted, selected or fetched), shared by every
 * match beneath it; one that is a loaded row takes its matches itself.
 */
import { describe, expect, it } from 'vitest'

import type { HierarchyNode } from '@/types/hierarchy'
import { nestInContainers } from '../useLayerAssignment'

const byName = (a: HierarchyNode, b: HierarchyNode) => a.name.localeCompare(b.name)
const step = (urn: string, entityType = 'schema') => ({ urn, displayName: urn.replace('urn:', ''), entityType })

function row(urn: string, path: ReturnType<typeof step>[] = [], inLayer = 0, children: HierarchyNode[] = []): HierarchyNode {
  return {
    id: urn, urn, typeId: 'table', name: urn.replace('urn:', ''), children, depth: 0, entityTypeOption: 'table', tags: [],
    data: { ancestorPath: path, inLayer },
  }
}

const shape = (n: HierarchyNode): unknown =>
  n.children.length ? { [n.name]: n.children.map(shape) } : n.name

describe('nestInContainers', () => {
  it('draws each match inside the containers its layer shares, each container once', () => {
    const path = [step('urn:oracle_prod', 'database'), step('urn:sales')]
    const roots = [
      row('urn:oracle_orders', path, 2),
      row('urn:oracle_customers', path, 2),
      row('urn:loose', path, 0),
    ]
    const out = nestInContainers(roots, 'src', byName, byName)
    expect(out.map(shape)).toEqual([
      'loose',
      { oracle_prod: [{ sales: ['oracle_customers', 'oracle_orders'] }] },
    ])
    const top = out[1]
    expect(top.id).toBe('logical:context:src:urn:oracle_prod')
    expect(top.isLogical).toBe(true)
    expect(top.urn).toBe(top.id)                       // never the entity's own URN
    expect(top.data.context).toEqual({ urn: 'urn:oracle_prod', matches: 2 })
    expect(top.data.ancestorPath).toEqual([])          // nothing above it to name
    const sales = top.children[0]
    expect(sales.data.ancestorPath).toEqual([path[0]])
    expect([top.depth, sales.depth, sales.children[0].depth]).toEqual([0, 1, 2])
  })

  it('only the nearest the layer shares: what is above them is named, not drawn', () => {
    const path = [step('urn:warehouse', 'database'), step('urn:sales')]
    const [top] = nestInContainers([row('urn:orders', path, 1)], 'src', byName, byName)
    expect(shape(top)).toEqual({ sales: ['orders'] })
    expect(top.data.ancestorPath).toEqual([path[0]])
  })

  it('a container that is a loaded row here takes its matches itself', () => {
    const db = row('urn:oracle_prod', [], 0)
    const path = [step('urn:oracle_prod', 'database'), step('urn:sales')]
    const out = nestInContainers([db, row('urn:orders', path, 2)], 'src', byName, byName)
    expect(out.map(shape)).toEqual([{ oracle_prod: [{ sales: ['orders'] }] }])
    expect(out[0]).toBe(db)
    expect(out[0].children[0].data.context).toEqual({ urn: 'urn:sales', matches: 1 })
  })

  it('a match with no path, or none shared, stays where it is', () => {
    const roots = [row('urn:a'), row('urn:b', [step('urn:x')], 0)]
    expect(nestInContainers(roots, 'L', byName, byName).map(shape)).toEqual(['a', 'b'])
  })

  it('a container in two layers is two rows, one per layer', () => {
    const path = [step('urn:sales')]
    const [one] = nestInContainers([row('urn:a', path, 1)], 'L1', byName, byName)
    const [two] = nestInContainers([row('urn:b', path, 1)], 'L2', byName, byName)
    expect(one.id).not.toBe(two.id)
  })
})
