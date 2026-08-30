/**
 * The words the canvas says about what the user just did.
 *
 * Six notifications used to say the same generic thing every time — "Child
 * entities loaded", three times over, for three different containers — and
 * their in-progress strings were system jargon ("Loading aggregated edges").
 * A message that cannot name its subject is noise, so the message building
 * lives here, apart from the 5k-line canvas, where every case can be read.
 *
 * Two rules run through all of it: numbers are localised, and no message ever
 * uses the words entity, edge, hydration, aggregated or "child entities".
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EntityTypeSchema } from '@/types/schema'
import {
  childLoadMessage,
  childNoun,
  connectionsLoadedMessage,
  layersPlacedMessage,
  loadingChildrenMessage,
  openedViewMessage,
  openingViewMessage,
  summarisedConnectionsMessage,
} from '../loadMessages'

const types = [
  { id: 'dataset', name: 'Dataset', pluralName: 'Datasets' },
  { id: 'column', name: 'Column', pluralName: 'Columns' },
] as EntityTypeSchema[]

describe('expanding a container', () => {
  it('names the container and the page it just delivered', () => {
    expect(childLoadMessage(
      { parentLabel: 'Snowflake', arrived: 5, offset: 0, total: 41, childTypes: ['dataset'] },
      types,
    )).toBe('Snowflake · 5 datasets')
  })

  it('says "more", and where the user has got to, on every page after the first', () => {
    expect(childLoadMessage(
      { parentLabel: 'Snowflake', arrived: 5, offset: 5, total: 41, childTypes: ['dataset'] },
      types,
    )).toBe('Snowflake · 5 more (10 of 41)')
  })

  it('says so plainly when the page brought nothing back', () => {
    expect(childLoadMessage(
      { parentLabel: 'Snowflake', arrived: 0, offset: 10, total: 41, childTypes: [] },
      types,
    )).toBe('Snowflake · nothing more to load')
  })

  it('drops the running total when the container never declared one', () => {
    expect(childLoadMessage(
      { parentLabel: 'Snowflake', arrived: 5, offset: 5, childTypes: ['dataset'] },
      types,
    )).toBe('Snowflake · 5 more')
  })

  it('uses the schema noun in the singular for one child', () => {
    expect(childLoadMessage(
      { parentLabel: 'Orders', arrived: 1, offset: 0, total: 1, childTypes: ['dataset'] },
      types,
    )).toBe('Orders · 1 dataset')
  })

  it('falls back to "items" when the page is type-mixed', () => {
    expect(childLoadMessage(
      { parentLabel: 'Snowflake', arrived: 7, offset: 0, total: 7, childTypes: ['dataset', 'column'] },
      types,
    )).toBe('Snowflake · 7 items')
  })

  it('falls back to "items" when the type is not in the schema', () => {
    expect(childLoadMessage(
      { parentLabel: 'Snowflake', arrived: 2, offset: 0, total: 2, childTypes: ['mystery'] },
      types,
    )).toBe('Snowflake · 2 items')
    expect(childNoun(1, [], types)).toBe('item')
  })

  it('separates thousands, in both halves of a load-more message', () => {
    expect(childLoadMessage(
      { parentLabel: 'Warehouse', arrived: 1000, offset: 4000, total: 12000, childTypes: ['column'] },
      types,
    )).toBe(`Warehouse · ${(1000).toLocaleString()} more (${(5000).toLocaleString()} of ${(12000).toLocaleString()})`)
  })

  it('names the container while the load is still running', () => {
    expect(loadingChildrenMessage('Snowflake')).toBe('Loading Snowflake…')
  })
})

describe('opening a view', () => {
  it('quotes the view by name, opening and opened', () => {
    expect(openingViewMessage('Customer 360')).toBe('Opening “Customer 360”…')
    expect(openedViewMessage('Customer 360', 1234)).toBe(`Opened “Customer 360” · ${(1234).toLocaleString()} items`)
  })

  it('says "this view" when the name has not arrived yet', () => {
    expect(openingViewMessage(undefined)).toBe('Opening this view…')
    expect(openedViewMessage(undefined, 12)).toBe('Opened this view · 12 items')
    expect(openedViewMessage('', 12)).toBe('Opened this view · 12 items')
  })
})

describe('the rest of the load', () => {
  it('counts connections rather than naming edges', () => {
    expect(connectionsLoadedMessage(2048)).toBe(`Connections · ${(2048).toLocaleString()}`)
    expect(summarisedConnectionsMessage(30)).toBe('Summarised connections · 30')
  })

  it('reports what was placed, and appends the leftovers only when there are some', () => {
    expect(layersPlacedMessage(120, 4, 0)).toBe('Placed 120 items across 4 layers')
    expect(layersPlacedMessage(1200, 4, 3)).toBe(`Placed ${(1200).toLocaleString()} items across 4 layers · 3 unplaced`)
  })
})

describe('the vocabulary the user never sees', () => {
  it('never says entity, edge, hydration or aggregated', () => {
    const all = [
      childLoadMessage({ parentLabel: 'P', arrived: 3, offset: 0, total: 3, childTypes: ['dataset'] }, types),
      childLoadMessage({ parentLabel: 'P', arrived: 3, offset: 3, total: 9, childTypes: ['dataset'] }, types),
      childLoadMessage({ parentLabel: 'P', arrived: 0, offset: 9, total: 9, childTypes: [] }, types),
      loadingChildrenMessage('P'),
      openingViewMessage('V'),
      openedViewMessage('V', 3),
      connectionsLoadedMessage(3),
      summarisedConnectionsMessage(3),
      layersPlacedMessage(3, 1, 1),
    ].join('\n').toLowerCase()
    for (const banned of ['entit', 'edge', 'hydrat', 'aggregat', 'child entities']) {
      expect(all).not.toContain(banned)
    }
  })
})

/**
 * Where the canvas wires these in. Not reachable in jsdom without mounting the
 * whole 5k-line component, and each of these is a property a future edit could
 * silently undo — the idiom of `dataLoadsDockWiring.test.ts`.
 */
describe('the canvas raises them from the sites that know the subject', () => {
  const canvas = readFileSync(resolve(__dirname, '../ContextViewCanvas.tsx'), 'utf8')

  it('no longer keeps a notification that cannot name what is loading', () => {
    // `ctx-children` ran off `loadingNodes.size > 0` — a global "≥1 container
    // busy" boolean, so three containers expanded gave three identical
    // "Child entities loaded". `ctx-regions` ran off `loadingRegions`, which
    // has no producer anywhere in the app and could never fire at all.
    expect(canvas).not.toContain("useLoadingNotification('ctx-children'")
    expect(canvas).not.toContain("useLoadingNotification('ctx-regions'")
    expect(canvas).not.toContain('loadingRegions')
    expect(canvas).not.toContain('Child entities loaded')
  })

  it('announces a child load only from the two the user asked for', () => {
    // Expand and "Load N more". The auto-first-page effect, the search
    // reveal's ancestor walk and the paging sentinel go through the silent
    // `loadChildrenSorted`.
    expect(canvas).toContain('const announceChildLoad = useCallback')
    expect(canvas.match(/await announceChildLoad\(|: announceChildLoad\(/g) ?? []).toHaveLength(2)
    expect(canvas).toMatch(/loadMoreChildren = useCallback\(async \(parentId: string, auto\?: boolean\)/)
    expect(canvas).toMatch(/auto \? loadChildrenSorted\(parentId\) : announceChildLoad\(parentId\)/)
  })

  it('computes every success message at the transition, never at declaration', () => {
    for (const call of ['ctx-hydrating-entities', 'ctx-hydrating-edges', 'ctx-assignments', 'ctx-agg-edges']) {
      const at = canvas.indexOf(`'${call}'`)
      expect(at).toBeGreaterThan(-1)
      expect(canvas.slice(at, canvas.indexOf('  )', at))).toContain('() =>')
    }
  })
})
