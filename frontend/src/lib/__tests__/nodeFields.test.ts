/**
 * nodeFields decides where each node field lives. The reserved names must be exactly the ones
 * the backend strips from `properties` — a name missing here is offered as a property the backend
 * then throws away; a name extra here hides a real property.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RESERVED_PROPERTY_KEYS, readSchemaField, splitNodeFields, toPayloadShape, userProperties,
  withReserved, writeBusinessLabel, writeSchemaField,
} from '../nodeFields'

describe('RESERVED_PROPERTY_KEYS', () => {
  it('matches _RESERVED_NODE_KEYS in the FalkorDB provider exactly', () => {
    const py = readFileSync(resolve(__dirname, '../../../../backend/app/providers/falkordb_provider.py'), 'utf8')
    const body = py.match(/_RESERVED_NODE_KEYS: frozenset = frozenset\(\{([\s\S]*?)\}\)/)
    expect(body, '_RESERVED_NODE_KEYS must still be a frozenset literal').not.toBeNull()
    const code = body![1].split('\n').map((line) => line.replace(/#.*$/, '')).join('\n')
    const python = new Set([...code.matchAll(/"([^"]+)"/g)].map((m) => m[1]))
    expect([...RESERVED_PROPERTY_KEYS].sort()).toEqual([...python].sort())
  })
})

describe('userProperties / withReserved', () => {
  it('hides reserved names the reader mirrored into the bag', () => {
    expect(userProperties({ owner: 'ana', childCount: 3, urn: 'u' })).toEqual({ owner: 'ana' })
  })

  it('returns the same object when nothing is reserved', () => {
    const bag = { owner: 'ana' }
    expect(userProperties(bag)).toBe(bag)
    expect(userProperties(undefined)).toEqual({})
  })

  it('writes an edited bag back without dropping the mirrored reserved entries', () => {
    expect(withReserved({ owner: 'ana', childCount: 3 }, { steward: 'bo' })).toEqual({ steward: 'bo', childCount: 3 })
  })
})

describe('schema fields', () => {
  const data = { label: 'Orders', qualifiedName: 'db.orders', properties: { retention: '90' } }

  it('reads and writes a reserved name top-level, anything else in properties', () => {
    expect(readSchemaField(data, 'qualifiedName')).toBe('db.orders')
    expect(readSchemaField(data, 'displayName')).toBe('Orders')
    expect(readSchemaField(data, 'retention')).toBe('90')
    expect(writeSchemaField(data, 'retention', '30').properties).toEqual({ retention: '30' })
    expect(writeSchemaField(data, 'sourceSystem', 'dbt')).toMatchObject({ sourceSystem: 'dbt', properties: { retention: '90' } })
  })
})

describe('writeBusinessLabel', () => {
  it('stores the label as a property and mirrors it for the canvas', () => {
    expect(writeBusinessLabel({ properties: { a: 1 } }, 'Customer orders')).toEqual({
      properties: { a: 1, businessLabel: 'Customer orders' }, businessLabel: 'Customer orders',
    })
  })

  it('clearing it removes the property', () => {
    expect(writeBusinessLabel({ properties: { businessLabel: 'x' } }, ' ')).toEqual({
      properties: {}, businessLabel: undefined,
    })
  })
})

describe('splitNodeFields', () => {
  it('lifts the node fields a flat map carries; drops other reserved names', () => {
    expect(splitNodeFields({ description: 'd', qualifiedName: 'q', owner: 'o', childCount: 2 })).toEqual({
      topLevel: { description: 'd', qualifiedName: 'q' },
      properties: { owner: 'o' },
    })
  })
})

describe('toPayloadShape', () => {
  it('maps the canvas display shape to the stored one', () => {
    expect(toPayloadShape({
      label: 'A', type: 'Table', classifications: ['pii'], description: 'd', urn: 'u', version: 'v',
      properties: { owner: 'o', childCount: 1 },
    })).toEqual({ displayName: 'A', entityType: 'Table', tags: ['pii'], description: 'd', properties: { owner: 'o' } })
  })

  it('leaves properties undefined when the source recorded none', () => {
    expect(toPayloadShape({ label: 'A' })).toEqual({ displayName: 'A' })
  })
})
