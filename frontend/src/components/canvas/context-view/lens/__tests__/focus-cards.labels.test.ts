/**
 * `edgeLabelFor` — the schema's own display name for a relationship, never
 * the raw id (2026-08-23).
 *
 * The Lens used to prove this through the List body's relationship column;
 * the list is gone, and the guarantee belongs to the function anyway —
 * every surface that names a relationship (a row's chip, a frame header's
 * shared type, a wire's tooltip) goes through it.
 */
import { describe, it, expect } from 'vitest'
import { edgeLabelFor } from '../focus-cards'

describe('edgeLabelFor', () => {
  it("prefers the schema's display name", () => {
    const info = new Map([['DERIVES_FROM', { label: 'Derives from', description: 'Computed from' }]])
    expect(edgeLabelFor('DERIVES_FROM', info)).toBe('Derives from')
  })

  it('falls back to a readable form of the id when the schema says nothing', () => {
    expect(edgeLabelFor('DERIVES_FROM')).not.toBe('DERIVES_FROM')
    expect(edgeLabelFor('DERIVES_FROM').toLowerCase()).toContain('derives')
    expect(edgeLabelFor('DERIVES_FROM', new Map())).toBe(edgeLabelFor('DERIVES_FROM'))
  })

  it('says "relationship" when there is no type at all', () => {
    expect(edgeLabelFor('')).toBe('relationship')
  })

  it('reads the system AGGREGATED type in plain English, over the ontology name', () => {
    const info = new Map([['AGGREGATED', { label: 'Aggregated', description: 'A synthetic aggregated lineage edge.' }]])
    expect(edgeLabelFor('AGGREGATED', info)).toBe('Combined flow')
    expect(edgeLabelFor('AGGREGATED')).toBe('Combined flow')
  })
})
