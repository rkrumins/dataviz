import { describe, it, expect } from 'vitest'
import {
  makeComposerNode,
  addChildAt,
  updateNodeAt,
  removeNodeAt,
  findNodeByKey,
  summarizeByType,
  flattenPreOrder,
  validateComposer,
} from '../composerModel'
import type { EntityTypeSchema, EntityFieldDefinition } from '@/types/schema'

const field = (id: string, required: boolean): EntityFieldDefinition => ({
  id, name: id, type: 'string', required, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 0,
})
const et = (id: string, fields: EntityFieldDefinition[] = []): EntityTypeSchema => ({
  id, name: id, pluralName: id, visual: {} as never, fields, behavior: {} as never,
  hierarchy: { level: 0, canContain: [], canBeContainedBy: [], defaultExpanded: false, rollUpFields: [] },
})

describe('composer tree ops', () => {
  it('makeComposerNode gives each node a unique tempKey', () => {
    const a = makeComposerNode('domain', 'A')
    const b = makeComposerNode('domain', 'B')
    expect(a.tempKey).not.toBe(b.tempKey)
    expect(a).toMatchObject({ entityType: 'domain', name: 'A', children: [] })
  })

  it('addChildAt(null) appends at the root level, addChildAt(key) nests', () => {
    let roots = addChildAt([], null, makeComposerNode('domain', 'Sales'))
    const domainKey = roots[0].tempKey
    roots = addChildAt(roots, domainKey, makeComposerNode('system', 'CRM'))
    expect(roots).toHaveLength(1)
    expect(roots[0].children).toHaveLength(1)
    expect(roots[0].children[0].name).toBe('CRM')
  })

  it('updateNodeAt patches a nested node immutably', () => {
    let roots = addChildAt([], null, makeComposerNode('domain', 'Sales'))
    const key = roots[0].tempKey
    const next = updateNodeAt(roots, key, { name: 'Sales v2', properties: { owner: 'x' } })
    expect(next[0].name).toBe('Sales v2')
    expect(next[0].properties).toEqual({ owner: 'x' })
    expect(roots[0].name).toBe('Sales') // original untouched
  })

  it('removeNodeAt drops a node and its subtree', () => {
    let roots = addChildAt([], null, makeComposerNode('domain', 'Sales'))
    const domainKey = roots[0].tempKey
    roots = addChildAt(roots, domainKey, makeComposerNode('system', 'CRM'))
    const sysKey = roots[0].children[0].tempKey
    roots = removeNodeAt(roots, sysKey)
    expect(roots[0].children).toHaveLength(0)
    roots = removeNodeAt(roots, domainKey)
    expect(roots).toHaveLength(0)
  })

  it('findNodeByKey locates a deep node', () => {
    let roots = addChildAt([], null, makeComposerNode('domain', 'Sales'))
    const domainKey = roots[0].tempKey
    roots = addChildAt(roots, domainKey, makeComposerNode('system', 'CRM'))
    const sysKey = roots[0].children[0].tempKey
    expect(findNodeByKey(roots, sysKey)?.name).toBe('CRM')
    expect(findNodeByKey(roots, 'nope')).toBeUndefined()
  })
})

describe('summarizeByType', () => {
  it('counts nodes per entity type across the whole tree', () => {
    let roots = addChildAt([], null, makeComposerNode('domain', 'D'))
    const d = roots[0].tempKey
    roots = addChildAt(roots, d, makeComposerNode('system', 'S1'))
    roots = addChildAt(roots, d, makeComposerNode('system', 'S2'))
    const s1 = roots[0].children[0].tempKey
    roots = addChildAt(roots, s1, makeComposerNode('dataset', 'DS'))
    const s = summarizeByType(roots)
    expect(s.total).toBe(4)
    expect(s.byType).toEqual({ domain: 1, system: 2, dataset: 1 })
  })
})

describe('flattenPreOrder', () => {
  it('emits parents before children with the correct parentKey, roots carry null', () => {
    let roots = addChildAt([], null, makeComposerNode('domain', 'GP'))
    const gp = roots[0].tempKey
    roots = addChildAt(roots, gp, makeComposerNode('system', 'P'))
    const p = roots[0].children[0].tempKey
    roots = addChildAt(roots, p, makeComposerNode('dataset', 'C'))
    const c = roots[0].children[0].children[0].tempKey

    const flat = flattenPreOrder(roots)
    expect(flat.map((f) => f.node.tempKey)).toEqual([gp, p, c])
    expect(flat.map((f) => f.parentKey)).toEqual([null, gp, p])
  })
})

describe('validateComposer', () => {
  const types = [et('domain'), et('dataset', [field('owner', true)])]

  it('flags nodes with empty names or missing required fields', () => {
    let roots = addChildAt([], null, makeComposerNode('domain', '')) // empty name
    const d = roots[0].tempKey
    roots = addChildAt(roots, d, makeComposerNode('dataset', 'Orders')) // missing required owner
    const orders = roots[0].children[0].tempKey

    const out = validateComposer(roots, types)
    expect(out.ok).toBe(false)
    expect(out.errorsByKey[d].errors.displayName).toBeTruthy()
    expect(out.errorsByKey[orders].errors.owner).toBeTruthy()
  })

  it('passes a fully-specified tree', () => {
    let roots = addChildAt([], null, makeComposerNode('domain', 'Sales'))
    const d = roots[0].tempKey
    roots = addChildAt(roots, d, makeComposerNode('dataset', 'Orders'))
    const orders = roots[0].children[0].tempKey
    roots = updateNodeAt(roots, orders, { properties: { owner: 'data-eng' } })
    expect(validateComposer(roots, types).ok).toBe(true)
  })
})
