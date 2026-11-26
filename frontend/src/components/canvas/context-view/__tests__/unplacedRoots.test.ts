/**
 * What a view's health check asks about: the root types the view is about, less those an open
 * view's type layers already load; and the urns it places of them.
 */
import { describe, expect, it } from 'vitest'
import { placedOfTypes, rootTypesToCheck } from '../unplacedRoots'

describe('rootTypesToCheck', () => {
  const rootTypes = ['domain', 'platform', 'glossary']

  it('the root types the view places entities of, or has a column for', () => {
    expect(rootTypesToCheck({
      rootTypes, layers: [{ entityTypes: ['platform'] }], placedTypes: ['domain', 'app'], fedTypes: [],
    })).toEqual(['domain', 'platform'])
  })

  it('none the view is not about: a curated view of Domains is not asked about Glossaries', () => {
    expect(rootTypesToCheck({ rootTypes, layers: [], placedTypes: ['domain'], fedTypes: [] })).toEqual(['domain'])
  })

  it('not the types an open view’s type layers load anyway', () => {
    expect(rootTypesToCheck({
      rootTypes, layers: [{ entityTypes: ['domain'] }], placedTypes: ['domain', 'platform'], fedTypes: ['Domain'],
    })).toEqual(['platform'])
  })

  it('matches types whatever their case', () => {
    expect(rootTypesToCheck({ rootTypes: ['Domain'], layers: [], placedTypes: ['domain'], fedTypes: [] })).toEqual(['Domain'])
  })
})

describe('placedOfTypes', () => {
  it('the placed urns of those types — never a temp urn — sorted', () => {
    const at = { layerId: 'l', inheritsChildren: true }
    const types: Record<string, string> = { b: 'domain', a: 'Domain', c: 'app', 'urn:staged:domain:1': 'domain' }
    expect(placedOfTypes({ b: at, a: at, c: at, 'urn:staged:domain:1': at, gone: at }, (u) => types[u], ['domain']))
      .toEqual(['a', 'b'])
  })
})
