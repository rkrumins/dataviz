/**
 * RelTypeRow's line preview — a sample of the edge, so it has to be a sample of
 * the edge the CANVAS draws.
 *
 * AGGREGATED's stroke style is owned by the app (`appOwnedStrokeStyle`): every
 * one of those edges is a roll-up and the canvas dashes it, whatever the seeded
 * ontology says. Live dev stack, 2026-08-30, the Synodic Default Ontology
 * declares it `solid`, so the row drew a solid green line two inches below an
 * advisory that had just called it dashed.
 *
 * Every other type keeps its declared stroke exactly as written — this row is
 * how an author checks what they typed.
 */
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { RelTypeRow } from './RelationshipsPanel'
import { relDefToSchema } from '../../lib/ontology-parsers'

const noop = () => {}

const row = (id: string, strokeStyle: string, isSystem = false) =>
  render(
    <RelTypeRow
      relType={{
        ...relDefToSchema(id, {
          name: id,
          is_system: isSystem,
          visual: { stroke_style: strokeStyle, stroke_color: '#22c55e', stroke_width: 2 },
        }),
      }}
      isLocked={false}
      isEditing={false}
      onEdit={noop}
      onDelete={noop}
    />,
  ).container.querySelector('line') as SVGLineElement

describe('RelTypeRow line preview', () => {
  it('dashes AGGREGATED even though the ontology declares it solid', () => {
    expect(row('AGGREGATED', 'solid', true).getAttribute('stroke-dasharray')).toBe('6,4')
  })

  it('leaves every other type on its declared stroke', () => {
    expect(row('PRODUCES', 'solid').getAttribute('stroke-dasharray')).toBeNull()
    expect(row('DEPENDS_ON', 'dashed').getAttribute('stroke-dasharray')).toBe('6,4')
    expect(row('TAGGED_WITH', 'dotted').getAttribute('stroke-dasharray')).toBe('2,3')
  })

  it('still renders the type name', () => {
    row('PRODUCES', 'solid')
    expect(screen.getAllByText('PRODUCES').length).toBeGreaterThan(0)
  })
})
