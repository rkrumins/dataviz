/**
 * fillRequired — the bulk dialog opened to fill a required field: "Fill if empty" on it, over every
 * entity of the type missing it (a search, from a drawer) or over the entities a publish refused
 * for it (by id, so ones new in the draft too), named so the Where step and the job say which.
 */
import { describe, expect, it } from 'vitest'

import { entityTypesOf, fillRefusedRequest, fillRequiredConnectionsRequest, fillRequiredRequest } from '../fillRequired'
import { isEdgeTarget, targetLabel, targetOf } from '../opModel'

describe('fillRequiredRequest', () => {
  it('fills the field where it is empty on every entity of the type, searched where asked', () => {
    const seed = fillRequiredRequest({ entityType: 'table', entityTypeName: 'Table', field: 'owner', fieldName: 'Owner', scopeMode: 'data_source' })
    expect(seed.op).toEqual({ kind: 'fillEmpty', key: 'owner' })
    expect(seed.scopeMode).toBe('data_source')
    expect(seed.target).toEqual({
      kind: 'search', scopeMode: 'data_source', label: 'every Table missing Owner',
      predicate: { kind: 'group', op: 'and', children: [
        { kind: 'entityType', op: 'in', values: ['table'] },
        { kind: 'property', key: 'owner', op: 'isEmpty' },
      ] },
    })
    expect(targetLabel(seed.target!)).toBe('every Table missing Owner')
    expect(targetOf(seed.target!, 'v1', 'data_source')).toMatchObject({ viewId: 'v1', scopeMode: 'data_source' })
  })

  it('names the type and the field by their ids when it has no names for them', () => {
    expect(fillRequiredRequest({ entityType: 'table', field: 'owner', scopeMode: 'view' }).target)
      .toMatchObject({ label: 'every table missing owner', scopeMode: 'view' })
  })
})

describe('fillRequiredConnectionsRequest', () => {
  it('fills the field where it is empty on every relationship of the type, as a Connections search', () => {
    const seed = fillRequiredConnectionsRequest({ edgeType: 'OWNS', edgeTypeName: 'Owns', field: 'since', fieldName: 'Since', scopeMode: 'view' })
    expect(seed.op).toEqual({ kind: 'fillEmpty', key: 'since' })
    expect(seed.target).toEqual({
      kind: 'connections', scopeMode: 'view', label: 'every Owns relationship missing Since',
      predicate: { kind: 'edges', edgeTypes: ['OWNS'], edgePredicate: { kind: 'edgeGroup', op: 'or', children: [
        { kind: 'edgeHasProperty', key: 'since', negate: true },
        { kind: 'edgeProperty', key: 'since', op: 'eq', value: '' },
      ] } },
    })
    expect(isEdgeTarget(seed.target!)).toBe(true)
    expect(targetLabel(seed.target!)).toBe('every Owns relationship missing Since')
  })
})

describe('fillRefusedRequest', () => {
  it('fills the refused entities by id — all of them, or the first that fit, saying so', () => {
    const all = fillRefusedRequest({ entityType: 'Table', field: 'owner', fieldName: 'Owner', ids: ['gv:a', 'gv:b'], complete: true })
    expect(all.op).toEqual({ kind: 'fillEmpty', key: 'owner' })
    expect(all.target).toEqual({
      kind: 'selection', ids: ['gv:a', 'gv:b'], entityTypes: ['Table'], label: 'every Table the publish refused for missing Owner' })
    expect(targetOf(all.target!, 'v1', 'view')).toEqual({ ids: ['gv:a', 'gv:b'] })

    const first = fillRefusedRequest({ entityType: 'Table', field: 'owner', ids: Array.from({ length: 1200 }, (_, i) => `gv:${i}`), complete: false })
    expect(targetLabel(first.target!)).toBe('the first 1,200 the publish refused for missing owner on Table')
  })

  it('fills refused relationships by their own ids', () => {
    const seed = fillRefusedRequest({ entityType: 'Owns', field: 'since', ids: ['e1', 'e2'], complete: true, edges: true })
    expect(seed.target).toEqual({ kind: 'relationships', ids: ['e1', 'e2'] })
    expect(targetOf(seed.target!, 'v1', 'view')).toEqual({ edgeIds: ['e1', 'e2'] })
  })
})

describe('entityTypesOf', () => {
  const custom = (predicate: unknown) => entityTypesOf({ kind: 'custom', predicate: predicate as never })
  it('reads the types a target keeps to: the ids’ own, or a search’s condition — alone, or one of an AND', () => {
    expect(entityTypesOf(fillRequiredRequest({ entityType: 'table', field: 'owner', scopeMode: 'view' }).target!)).toEqual(['table'])
    expect(entityTypesOf(fillRefusedRequest({ entityType: 'Table', field: 'owner', ids: ['gv:a'], complete: true }).target!)).toEqual(['Table'])
    expect(custom({ kind: 'entityType', op: 'in', values: ['a', 'b'] })).toEqual(['a', 'b'])
    expect(custom({ kind: 'entityType', op: 'notIn', values: ['a'] })).toBeNull()
    expect(custom({ kind: 'group', op: 'or', children: [{ kind: 'entityType', values: ['a'] }] })).toBeNull()
    expect(entityTypesOf({ kind: 'view' })).toBeNull()
    expect(entityTypesOf({ kind: 'selection', ids: ['a'] })).toBeNull()
    expect(custom(null)).toBeNull()
  })
})
