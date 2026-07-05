/**
 * resolveRowLayer — pure, ONTOLOGY-AGNOSTIC per-row layer resolution.
 *
 * Build Mode must place each entity in the column configured for ITS TYPE, for
 * ANY schema. Nothing here hard-codes a type or layer name in the module under
 * test — every decision derives from (a) the view's `sortedLayers[].entityTypes`
 * and (b) the row's own typeId/override. These tests prove genericity with
 * THREE unrelated ontologies:
 *   (a) Layer → Object → Group → Attribute      (one column per type)
 *   (b) Domain → Application → Database → Table → Column
 *   (c) System → Database → Table               (FEWER columns than types:
 *       proves fallback + a column holding two types + deterministic multi-map)
 */
import { describe, it, expect } from 'vitest'
import { buildTypeLayerMap, resolveRowLayer } from '../resolveRowLayer'

type Layer = { id: string; entityTypes?: string[] }
const row = (typeId: string | null, extra?: { id?: string; layerId?: string }) => ({ typeId, ...extra })

// (a) Layer → Object → Group → Attribute — a column per type.
const ontologyA: Layer[] = [
  { id: 'la-layer', entityTypes: ['Layer'] },
  { id: 'la-object', entityTypes: ['Object'] },
  { id: 'la-group', entityTypes: ['Group'] },
  { id: 'la-attr', entityTypes: ['Attribute'] },
]

// (b) Domain → Application → Database → Table → Column — a column per type.
const ontologyB: Layer[] = [
  { id: 'lb-domain', entityTypes: ['Domain'] },
  { id: 'lb-app', entityTypes: ['Application'] },
  { id: 'lb-db', entityTypes: ['Database'] },
  { id: 'lb-table', entityTypes: ['Table'] },
  { id: 'lb-col', entityTypes: ['Column'] },
]

// (c) System → Database → Table, but only TWO columns: one holds System+Database,
// the other holds Table. Type 'Table' also appears (first) in the infra column of
// a variant below to prove deterministic multi-map. Type 'Column' maps to nothing.
const ontologyC: Layer[] = [
  { id: 'lc-infra', entityTypes: ['System', 'Database'] },
  { id: 'lc-data', entityTypes: ['Table'] },
]

describe('buildTypeLayerMap', () => {
  it('(a) column-per-type: maps each type to its own layer, case-insensitively', () => {
    const map = buildTypeLayerMap(ontologyA)
    expect(map.get('layer')).toBe('la-layer')
    expect(map.get('object')).toBe('la-object')
    expect(map.get('group')).toBe('la-group')
    expect(map.get('attribute')).toBe('la-attr')
  })

  it('(b) a different five-level ontology maps identically — no type names baked in', () => {
    const map = buildTypeLayerMap(ontologyB)
    expect(map.get('domain')).toBe('lb-domain')
    expect(map.get('application')).toBe('lb-app')
    expect(map.get('table')).toBe('lb-table')
    expect(map.get('column')).toBe('lb-col')
  })

  it('(c) fewer columns than types: two types share one column; an unmapped type is absent', () => {
    const map = buildTypeLayerMap(ontologyC)
    expect(map.get('system')).toBe('lc-infra')
    expect(map.get('database')).toBe('lc-infra') // same column holds two types
    expect(map.get('table')).toBe('lc-data')
    expect(map.has('column')).toBe(false) // maps to no column
  })

  it('deterministic multi-map: when a type appears in several layers, the FIRST wins', () => {
    const map = buildTypeLayerMap([
      { id: 'first', entityTypes: ['Shared'] },
      { id: 'second', entityTypes: ['Shared'] },
    ])
    expect(map.get('shared')).toBe('first')
  })

  it('tolerates layers with no entityTypes', () => {
    const map = buildTypeLayerMap([{ id: 'empty' }, { id: 'x', entityTypes: ['T'] }])
    expect(map.get('t')).toBe('x')
    expect(map.size).toBe(1)
  })
})

describe('resolveRowLayer', () => {
  it('(a) returns the layer configured for the row\'s TYPE', () => {
    const typeLayerMap = buildTypeLayerMap(ontologyA)
    expect(resolveRowLayer(row('Object'), { typeLayerMap, fallbackLayerId: 'fb' })).toBe('la-object')
    expect(resolveRowLayer(row('Attribute'), { typeLayerMap, fallbackLayerId: 'fb' })).toBe('la-attr')
  })

  it('(b) same code, unrelated ontology — Table lands in the Table column', () => {
    const typeLayerMap = buildTypeLayerMap(ontologyB)
    expect(resolveRowLayer(row('Table'), { typeLayerMap, fallbackLayerId: 'fb' })).toBe('lb-table')
    expect(resolveRowLayer(row('Database'), { typeLayerMap, fallbackLayerId: 'fb' })).toBe('lb-db')
  })

  it('(c) falls back to fallbackLayerId when the type maps to no column', () => {
    const typeLayerMap = buildTypeLayerMap(ontologyC)
    expect(resolveRowLayer(row('Column'), { typeLayerMap, fallbackLayerId: 'lc-infra' })).toBe('lc-infra')
    // and two types sharing a column both resolve to it
    expect(resolveRowLayer(row('System'), { typeLayerMap, fallbackLayerId: 'fb' })).toBe('lc-infra')
    expect(resolveRowLayer(row('Database'), { typeLayerMap, fallbackLayerId: 'fb' })).toBe('lc-infra')
  })

  it('a null / unknown typeId falls back', () => {
    const typeLayerMap = buildTypeLayerMap(ontologyA)
    expect(resolveRowLayer(row(null), { typeLayerMap, fallbackLayerId: 'fb' })).toBe('fb')
    expect(resolveRowLayer(row('Nonexistent'), { typeLayerMap, fallbackLayerId: 'fb' })).toBe('fb')
    // no fallback configured → undefined
    expect(resolveRowLayer(row(null), { typeLayerMap })).toBeUndefined()
  })

  it('an explicit per-row override (overrides map by row id) WINS over the type-derived layer', () => {
    const typeLayerMap = buildTypeLayerMap(ontologyA)
    const overrides = new Map([['r1', 'la-attr']])
    // typeId Object would resolve to la-object, but the override forces la-attr.
    expect(resolveRowLayer(row('Object', { id: 'r1' }), { typeLayerMap, overrides, fallbackLayerId: 'fb' })).toBe('la-attr')
    // a row without an override entry still resolves by type.
    expect(resolveRowLayer(row('Object', { id: 'r2' }), { typeLayerMap, overrides, fallbackLayerId: 'fb' })).toBe('la-object')
  })

  it('an explicit per-row override (row.layerId field, set by the Grid in Task 2) WINS', () => {
    const typeLayerMap = buildTypeLayerMap(ontologyA)
    expect(resolveRowLayer(row('Object', { layerId: 'la-group' }), { typeLayerMap, fallbackLayerId: 'fb' })).toBe('la-group')
  })
})
