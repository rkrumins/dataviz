/**
 * What kind of column a layer is, read off its config: mapped to an entity (only one that is loaded
 * and not claimed by another column), by type or rule, or hand-picked — and how each is explained.
 */
import { describe, expect, it } from 'vitest'
import { columnKind, columnKindCopy } from '../columnKind'

const ok = { resolved: true }

describe('columnKind', () => {
  it('is mapped when its anchor is loaded and its own', () => {
    expect(columnKind({ anchorUrn: 'Finance', entityTypes: [] }, ok)).toBe('mapped')
    // Even with types: the column IS the entity.
    expect(columnKind({ anchorUrn: 'Finance', entityTypes: ['app'] }, ok)).toBe('mapped')
  })

  it('is never mapped to an anchor that is missing, not loaded, or held by another column', () => {
    expect(columnKind({ anchorUrn: 'Gone', entityTypes: [] }, { resolved: false, issue: 'missing' })).toBe('handPicked')
    expect(columnKind({ anchorUrn: 'Later', entityTypes: [] }, { resolved: false })).toBe('handPicked')
    expect(columnKind({ anchorUrn: 'Finance', entityTypes: [] }, { resolved: true, issue: 'duplicate' })).toBe('handPicked')
    expect(columnKind({ anchorUrn: 'Finance', entityTypes: ['app'] }, { resolved: true, issue: 'duplicate' })).toBe('byType')
  })

  it('is by type with types or rules, and hand-picked with neither', () => {
    expect(columnKind({ entityTypes: ['app'] }, ok)).toBe('byType')
    expect(columnKind({ entityTypes: [], rules: [{ id: 'r' } as never] }, ok)).toBe('byType')
    expect(columnKind({ entityTypes: [] }, ok)).toBe('handPicked')
    expect(columnKind({ entityTypes: [], rules: [] }, ok)).toBe('handPicked')
  })
})

describe('columnKindCopy', () => {
  it('a mapped column: what is inside it, and that adding or dropping there changes the data', () => {
    expect(columnKindCopy('mapped', { persona: 'technical', anchorName: 'Finance', anchorUrn: 'urn:dom:finance' })).toEqual({
      label: 'Mapped to Finance',
      detail: 'This column is Finance’s contents. Adding or dropping here puts things inside Finance — changes the data.',
      technical: 'urn:dom:finance',
    })
    expect(columnKindCopy('mapped', { persona: 'business', anchorName: 'Money', anchorUrn: 'urn:dom:finance' })).toEqual({
      label: 'Mapped to Money',
      detail: 'This column is what’s inside Money. Adding or dropping here puts things inside Money — changes the data.',
      technical: undefined,
    })
  })

  it('a column by type: what it shows, what adding there creates — and what was placed by hand', () => {
    expect(columnKindCopy('byType', { persona: 'business', typeNames: ['App'], typeIds: ['app'] })).toEqual({
      label: 'By type: App',
      detail: 'A column for Apps — adding here creates an App. Dropping on its header only changes this view.',
      technical: undefined,
    })
    expect(columnKindCopy('byType', { persona: 'technical', typeNames: ['App', 'Service'], typePlurals: ['Apps', 'Services'], typeIds: ['app', 'service'], ruleCount: 2, handPlaced: 3 })).toEqual({
      label: 'By type: App and Service',
      detail: 'A column for Apps and Services — adding here creates one of them. And 3 placed here by hand. Dropping on its header only changes this view.',
      technical: 'types: app, service · 2 rules',
    })
    expect(columnKindCopy('byType', { persona: 'business', ruleCount: 1 }).label).toBe('By rule')
  })

  it('a hand-picked column: arranging it only changes this view', () => {
    expect(columnKindCopy('handPicked', { persona: 'business' })).toEqual({
      label: 'Hand-picked',
      detail: 'Entities placed here by hand. Arranging this column only changes this view.',
    })
  })
})
