import { describe, it, expect } from 'vitest'
import { resolveEntityName, technicalSubtitle } from '../entityDisplayName'

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

describe('technicalSubtitle', () => {
  it('is silent in business mode', () => {
    const data = { label: 'orders', qualifiedName: 'snowflake.prod.sales.orders' }
    expect(technicalSubtitle(data, 'business')).toBeUndefined()
  })

  it('reveals the qualified name in technical mode', () => {
    const data = { label: 'orders', qualifiedName: 'snowflake.prod.sales.orders' }
    expect(technicalSubtitle(data, 'technical')).toBe('snowflake.prod.sales.orders')
  })

  // Several loaders set qualifiedName from the name; a duplicated line is noise.
  it('returns NO subtitle when the qualified name is the display name', () => {
    const data = { label: 'Orders', qualifiedName: 'Orders' }
    expect(technicalSubtitle(data, 'technical')).toBeUndefined()
  })

  it('falls through to the URN when the qualified name repeats the name', () => {
    const data = { label: 'Orders', qualifiedName: 'Orders', urn: 'urn:li:dataset:orders' }
    expect(technicalSubtitle(data, 'technical')).toBe('urn:li:dataset:orders')
  })

  it('falls through to the URN when there is no qualified name at all', () => {
    expect(technicalSubtitle({ label: 'Orders', urn: 'urn:li:dataset:orders' }, 'technical'))
      .toBe('urn:li:dataset:orders')
  })

  it('never repeats the name when the URN IS the name', () => {
    expect(technicalSubtitle({ label: 'urn:li:dataset:orders', urn: 'urn:li:dataset:orders' }, 'technical'))
      .toBeUndefined()
  })

  it('compares against the technical-mode name, not the business override', () => {
    const data = { label: 'orders', businessLabel: 'Orders', qualifiedName: 'orders' }
    expect(technicalSubtitle(data, 'technical')).toBeUndefined()
  })

  it('is undefined when the entity carries no technical identity', () => {
    expect(technicalSubtitle({ label: 'Orders' }, 'technical')).toBeUndefined()
    expect(technicalSubtitle({ label: 'Orders', qualifiedName: '', urn: '' }, 'technical')).toBeUndefined()
  })
})
