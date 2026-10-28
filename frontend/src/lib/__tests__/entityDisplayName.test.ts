import { describe, it, expect } from 'vitest'
import { resolveEntityName, technicalIdentity } from '../entityDisplayName'

describe('resolveEntityName', () => {
  it('prefers a curated businessLabel in business mode', () => {
    const data = { label: 'customer_orders', businessLabel: 'Customer Orders' }
    expect(resolveEntityName(data, 'business')).toBe('Customer Orders')
  })

  it('prefers the source name in technical mode', () => {
    const data = { label: 'customer_orders', businessLabel: 'Customer Orders' }
    expect(resolveEntityName(data, 'technical')).toBe('customer_orders')
  })

  it('resolves the SAME string in both modes when there is no override', () => {
    const data = { label: 'Orders' }
    expect(resolveEntityName(data, 'business')).toBe('Orders')
    expect(resolveEntityName(data, 'technical')).toBe('Orders')
  })

  it('accepts the flat entity shape that spells the name `name`', () => {
    expect(resolveEntityName({ name: 'Orders' }, 'business')).toBe('Orders')
  })

  it('falls back to the override rather than rendering blank in technical mode', () => {
    expect(resolveEntityName({ businessLabel: 'Customer Orders' }, 'technical')).toBe('Customer Orders')
  })

  it('ignores empty and blank strings', () => {
    expect(resolveEntityName({ label: '', businessLabel: '   ' }, 'business', 'urn:x')).toBe('urn:x')
  })

  it('returns the fallback, then the empty string, when nothing is named', () => {
    expect(resolveEntityName({}, 'business', 'urn:x')).toBe('urn:x')
    expect(resolveEntityName(undefined, 'technical')).toBe('')
  })
})

describe('technicalIdentity — the identifier technical mode shows under a name', () => {
  const orders = { label: 'Orders', urn: 'urn:li:dataset:orders', qualifiedName: 'snowflake.prod.sales.orders',
    properties: { id: 'ORD-000417' } }

  it('is silent in business mode', () => {
    expect(technicalIdentity(orders, 'business', { identityProperty: 'id', name: 'Orders' })).toBeUndefined()
  })

  it("shows the data source's identifier property when the source maps one", () => {
    expect(technicalIdentity(orders, 'technical', { identityProperty: 'id', name: 'Orders' }))
      .toEqual({ property: 'id', value: 'ORD-000417' })
  })

  it('writes a numeric identifier out', () => {
    expect(technicalIdentity({ label: 'Orders', properties: { id: 42 } }, 'technical', { identityProperty: 'id', name: 'Orders' }))
      .toEqual({ property: 'id', value: '42' })
  })

  it('reads an identifier the platform owns from the entity itself', () => {
    expect(technicalIdentity(orders, 'technical', { identityProperty: 'qualifiedName', name: 'Orders' }))
      .toEqual({ property: 'qualifiedName', value: 'snowflake.prod.sales.orders' })
  })

  // One kind of value per source: never a path on one row and a URN on the next.
  it('shows the URN — never the qualified name — when the source keys by urn or maps nothing', () => {
    for (const identityProperty of ['urn', undefined, null, '  ']) {
      expect(technicalIdentity(orders, 'technical', { identityProperty, name: 'Orders' }))
        .toEqual({ property: 'urn', value: 'urn:li:dataset:orders' })
    }
  })

  it('falls back to the URN for an entity without a value of its own', () => {
    expect(technicalIdentity({ label: 'Orders', urn: 'urn:li:dataset:orders', properties: { id: '' } }, 'technical',
      { identityProperty: 'id', name: 'Orders' })).toEqual({ property: 'urn', value: 'urn:li:dataset:orders' })
  })

  it("takes the row's own URN for data that carries none", () => {
    expect(technicalIdentity({}, 'technical', { identityProperty: 'id', urn: 'urn:li:dataset:orders', name: 'Orders' }))
      .toEqual({ property: 'urn', value: 'urn:li:dataset:orders' })
  })

  it('never repeats the name on the row: an identifier that is the name adds nothing, not the URN', () => {
    expect(technicalIdentity({ label: 'ORD-1', urn: 'urn:x', properties: { id: 'ORD-1' } }, 'technical',
      { identityProperty: 'id', name: 'ORD-1' })).toBeUndefined()
    // A node with no name of its own shows its URN as the name — once.
    expect(technicalIdentity({ label: '', urn: 'urn:x' }, 'technical', { name: 'urn:x' })).toBeUndefined()
  })

  it('is undefined when the entity has no identifier at all', () => {
    expect(technicalIdentity({ label: 'Orders' }, 'technical', { identityProperty: 'id', name: 'Orders' })).toBeUndefined()
    expect(technicalIdentity({ label: 'Orders', urn: '' }, 'technical', { name: 'Orders' })).toBeUndefined()
  })
})
