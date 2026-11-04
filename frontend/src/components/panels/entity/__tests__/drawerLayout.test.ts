/**
 * drawerLayout — each view's sections and their order, made whole from what a
 * browser stored, and the properties featured at a glance.
 */
import { describe, expect, it } from 'vitest'

import type { EntityFieldDefinition } from '@/types/schema'

import {
  defaultFeatured, defaultLayout, featurableKeys, isDefaultLayout, moveSection, resolveFeatured,
  resolveLayout, setSectionShown, shownSections,
} from '../drawerLayout'

const field = (id: string, displayOrder: number, showInPanel = true) =>
  ({ id, name: id, type: 'string', required: false, showInNode: false, showInPanel, showInTooltip: false, displayOrder }) as EntityFieldDefinition

describe('drawerLayout — sections', () => {
  it('the Technical view shows every section it always had, in the same order', () => {
    expect(shownSections(defaultLayout('technical')))
      .toEqual(['identifier', 'details', 'relationship', 'properties', 'classifications', 'lineage', 'history'])
  })

  it('the Business view opens at a glance, and keeps the technical sections switched off', () => {
    expect(shownSections(defaultLayout('business'))).toEqual(['overview', 'properties', 'classifications', 'lineage'])
  })

  it('makes a stored layout whole: unknown ids dropped, unnamed sections as the default has them', () => {
    const stored = { order: ['lineage', 'bogus', 'overview'] as never[], hidden: ['overview'] as never[] }
    const layout = resolveLayout(stored, 'business')
    expect(layout.order.slice(0, 2)).toEqual(['lineage', 'overview'])
    expect(layout.order).not.toContain('bogus')
    expect(layout.order).toHaveLength(8)
    // Named and hidden stays hidden; never named takes the view's default.
    expect(layout.hidden).toContain('overview')
    expect(layout.hidden).toContain('history')
    expect(layout.hidden).not.toContain('properties')
  })

  it('moves a section one step, and not past either end', () => {
    const base = defaultLayout('business')
    expect(moveSection(base, 'properties', -1).order.slice(0, 2)).toEqual(['properties', 'overview'])
    expect(moveSection(base, 'overview', -1)).toBe(base)
  })

  it('shows and hides, and knows the default when it sees it', () => {
    const shown = setSectionShown(defaultLayout('business'), 'history', true)
    expect(shownSections(shown)).toContain('history')
    expect(isDefaultLayout(shown, 'business')).toBe(false)
    expect(isDefaultLayout(setSectionShown(shown, 'history', false), 'business')).toBe(true)
  })
})

describe('drawerLayout — featured properties', () => {
  it('defaults to the type\'s panel fields, in order, then an owner', () => {
    expect(defaultFeatured([field('steward', 2), field('status', 1), field('internal', 0, false), field('description', 0)]))
      .toEqual(['status', 'steward', 'owner'])
  })

  it('shows defaults the entity has, and a pinned choice whole — "Not set" where it lacks one', () => {
    const data = { properties: { owner: 'ana', sla: '1h' } }
    expect(resolveFeatured(undefined, [field('status', 0)], data)).toEqual([{ key: 'owner', value: 'ana' }])
    expect(resolveFeatured(['sla', 'status'], [], data)).toEqual([
      { key: 'sla', value: '1h' }, { key: 'status', value: undefined },
    ])
  })

  it('offers the entity\'s own properties and the fields it has a value for, never the name or description', () => {
    const data = { description: 'Orders', qualifiedName: 'db.orders', properties: { owner: 'ana' } }
    expect(featurableKeys([field('qualifiedName', 0), field('description', 1), field('status', 2)], data, { owner: 'ana' }))
      .toEqual(['owner', 'qualifiedName'])
  })
})
