/** An import's identifier as the app reads and writes it: a property, then the urn, included. */
import { describe, expect, it } from 'vitest'
import { formatIdentifier, identifierLabel, parseIdentifier } from '../identifier'

describe('identifier', () => {
  it('reads and writes each identifier, a property then the urn too', () => {
    for (const id of ['entity_id', 'urn', 'prop.external_id', 'prop.external_id,urn']) {
      expect(formatIdentifier(parseIdentifier(id))).toBe(id)
    }
    expect(parseIdentifier('prop.MY_UNIQUE_ID,urn')).toEqual({ kind: 'prop', name: 'MY_UNIQUE_ID', orUrn: true })
    expect(formatIdentifier({ kind: 'prop', name: ' sap_id ', orUrn: false })).toBe('prop.sap_id')
  })

  it('names each as people read it', () => {
    expect(identifierLabel('prop.external_id,urn')).toBe('Property external_id, then URN')
    expect(identifierLabel('prop.external_id')).toBe('Property external_id')
    expect(identifierLabel('urn')).toBe('URN')
  })
})
