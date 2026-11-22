/**
 * RelationshipTypeEditor — the collision gate must never dead-end pure re-categorization.
 *
 * The edge-type id is frozen once created, so a pre-existing case-variant duplicate (`TO` next to
 * `To`) is not resolvable from this dialog. Gating an existing type's Save on that collision
 * permanently blocked moving the edge into Containment/Lineage (the reported bug). New types, whose
 * id the user CAN still change, must still be blocked.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { RelationshipTypeEditor } from './RelationshipTypeEditor'
import { relDefToSchema, relSchemaToBackend } from '@/features/ontology/lib/ontology-parsers'

const noop = () => {}

describe('RelationshipTypeEditor collision gate', () => {
  it('keeps Save enabled for an existing edge whose frozen id case-collides with another key', () => {
    const relType = relDefToSchema('To', { name: 'To', is_containment: false, is_lineage: false })
    render(
      <RelationshipTypeEditor
        relType={relType}
        existingTypeIds={['TO', 'To', 'HAS']}
        onSave={noop}
        onCancel={noop}
      />,
    )
    const save = screen.getByRole('button', { name: /stage changes/i }) as HTMLButtonElement
    expect(save.disabled).toBe(false)
    expect(screen.queryByText(/already exists in this ontology/i)).toBeNull()
  })

  it('still blocks a NEW type whose derived id case-collides with an existing one', async () => {
    render(<RelationshipTypeEditor existingTypeIds={['TO']} onSave={noop} onCancel={noop} />)
    await userEvent.type(screen.getByPlaceholderText(/Flows To, Contains, Depends On/i), 'to')
    const create = screen.getByRole('button', { name: /^create$/i }) as HTMLButtonElement
    expect(create.disabled).toBe(true)
    expect(screen.queryByText(/already exists in this ontology/i)).not.toBeNull()
  })
})

/**
 * Never encode by hue alone.
 *
 * The canvas separates edge types by colour AND dash. Two types that share a stroke
 * style are separated by hue and nothing else — nothing at all to a colour-blind
 * reader. Live dev stack, 2026-08-30: the seeded 11-type ontology draws PRODUCES,
 * CONSUMES, TRANSFORMS and AGGREGATED all `solid`, and DEFINED_BY next to
 * TAGGED_WITH both `dotted`. The Appearance tab is where the colour is chosen, so
 * it is where that has to be said — and fixed.
 */
describe('RelationshipTypeEditor line-style advisory', () => {
  const sibling = (id: string, strokeStyle: 'solid' | 'dashed' | 'dotted', strokeColor: string) => ({
    id, name: id, visual: { strokeColor, strokeStyle },
  })

  const openAppearance = async () => {
    await userEvent.click(screen.getByRole('button', { name: /appearance/i }))
  }

  it('names the types this one is separated from by color alone', async () => {
    const relType = relDefToSchema('PRODUCES', { name: 'Produces', visual: { stroke_style: 'solid', stroke_color: '#3b82f6' } })
    render(
      <RelationshipTypeEditor
        relType={relType}
        existingTypeIds={['PRODUCES', 'CONSUMES', 'DEPENDS_ON']}
        siblingTypes={[
          sibling('PRODUCES', 'solid', '#3b82f6'),
          sibling('CONSUMES', 'solid', '#f59e0b'),
          sibling('DEPENDS_ON', 'dashed', '#ec4899'),
        ]}
        onSave={noop}
        onCancel={noop}
      />,
    )
    await openAppearance()
    expect(screen.getByText(/color is the only difference/i)).toBeTruthy()
    expect(screen.getByText(/CONSUMES/)).toBeTruthy()
    expect(screen.queryByText(/DEPENDS_ON/)).toBeNull()
  })

  it('clears once the stroke style stops matching', async () => {
    const relType = relDefToSchema('PRODUCES', { name: 'Produces', visual: { stroke_style: 'solid', stroke_color: '#3b82f6' } })
    render(
      <RelationshipTypeEditor
        relType={relType}
        existingTypeIds={['PRODUCES', 'CONSUMES']}
        siblingTypes={[sibling('PRODUCES', 'solid', '#3b82f6'), sibling('CONSUMES', 'solid', '#f59e0b')]}
        onSave={noop}
        onCancel={noop}
      />,
    )
    await openAppearance()
    expect(screen.getByText(/color is the only difference/i)).toBeTruthy()
    await userEvent.selectOptions(screen.getByDisplayValue('Solid'), 'dashed')
    expect(screen.queryByText(/color is the only difference/i)).toBeNull()
  })

  it('offers a style no other type has taken, and applying it clears the advisory', async () => {
    const relType = relDefToSchema('PRODUCES', { name: 'Produces', visual: { stroke_style: 'solid', stroke_color: '#3b82f6' } })
    render(
      <RelationshipTypeEditor
        relType={relType}
        existingTypeIds={['PRODUCES', 'CONSUMES', 'DEPENDS_ON']}
        siblingTypes={[
          sibling('PRODUCES', 'solid', '#3b82f6'),
          sibling('CONSUMES', 'solid', '#f59e0b'),
          sibling('DEPENDS_ON', 'dashed', '#ec4899'),
        ]}
        onSave={noop}
        onCancel={noop}
      />,
    )
    await openAppearance()
    await userEvent.click(screen.getByRole('button', { name: /use dotted/i }))
    expect(screen.queryByText(/color is the only difference/i)).toBeNull()
    expect((screen.getByDisplayValue('Dotted') as HTMLSelectElement).value).toBe('dotted')
  })

  it('says nothing when no other type shares the line', async () => {
    const relType = relDefToSchema('DEPENDS_ON', { name: 'Depends on', visual: { stroke_style: 'dashed', stroke_color: '#ec4899' } })
    render(
      <RelationshipTypeEditor
        relType={relType}
        existingTypeIds={['DEPENDS_ON', 'PRODUCES']}
        siblingTypes={[sibling('DEPENDS_ON', 'dashed', '#ec4899'), sibling('PRODUCES', 'solid', '#3b82f6')]}
        onSave={noop}
        onCancel={noop}
      />,
    )
    await openAppearance()
    expect(screen.queryByText(/color is the only difference/i)).toBeNull()
  })

  it('says nothing when the caller passes no siblings at all', async () => {
    render(<RelationshipTypeEditor existingTypeIds={[]} onSave={noop} onCancel={noop} />)
    await openAppearance()
    expect(screen.queryByText(/color is the only difference/i)).toBeNull()
  })
})

/**
 * The Appearance tab must describe the line the CANVAS draws — on BOTH sides.
 *
 * The siblings were already resolved that way by the caller (OntologySchemaPage
 * maps each through `appOwnedStrokeStyle`), but the SUBJECT was still read
 * declared. `AGGREGATED` is seeded `solid` on a live ontology and the canvas
 * dashes every roll-up on geometry, so the row swatch an inch above drew dashed
 * while this preview drew solid, and the advisory told the author the type was
 * separated from every solid type by colour alone.
 */
describe('RelationshipTypeEditor — the subject is read as drawn, not as declared', () => {
  const sibling = (id: string, strokeStyle: 'solid' | 'dashed' | 'dotted', strokeColor: string) => ({
    id, name: id, visual: { strokeColor, strokeStyle },
  })

  const openAppearance = async () => {
    await userEvent.click(screen.getByRole('button', { name: /appearance/i }))
  }

  const aggregated = () =>
    relDefToSchema('AGGREGATED', { name: 'Aggregated', visual: { stroke_style: 'solid', stroke_color: '#94a3b8' } })

  it('previews the roll-up dashed even though the ontology seeded it solid', async () => {
    const { container } = render(
      <RelationshipTypeEditor relType={aggregated()} existingTypeIds={['AGGREGATED']} onSave={noop} onCancel={noop} />,
    )
    await openAppearance()
    expect(container.querySelector('svg line')?.getAttribute('stroke-dasharray')).toBe('8,4')
  })

  it('does not call the roll-up a solid twin of the solid types', async () => {
    render(
      <RelationshipTypeEditor
        relType={aggregated()}
        existingTypeIds={['AGGREGATED', 'PRODUCES']}
        siblingTypes={[sibling('AGGREGATED', 'dashed', '#94a3b8'), sibling('PRODUCES', 'solid', '#3b82f6')]}
        onSave={noop}
        onCancel={noop}
      />,
    )
    await openAppearance()
    expect(screen.queryByText(/color is the only difference/i)).toBeNull()
  })

  it('still previews an ordinary type exactly as it is declared', async () => {
    const relType = relDefToSchema('PRODUCES', { name: 'Produces', visual: { stroke_style: 'dotted', stroke_color: '#3b82f6' } })
    const { container } = render(
      <RelationshipTypeEditor relType={relType} existingTypeIds={['PRODUCES']} onSave={noop} onCancel={noop} />,
    )
    await openAppearance()
    expect(container.querySelector('svg line')?.getAttribute('stroke-dasharray')).toBe('2,4')
  })
})

/**
 * Four of the Appearance controls persist to the database and reach no canvas:
 * `EdgeTypeDefinition` carries colour, stroke style and animated only, and even
 * `animated` is read by nothing but the legend's icon — every canvas computes
 * motion from projection state. An author who set width 3 and arrow none saw
 * every canvas draw the type exactly as before. Say so rather than ship a
 * control whose only observable effect is a database row.
 */
describe('RelationshipTypeEditor — the Appearance tab says which channels are drawn', () => {
  it('marks width, arrow and animation as not drawn yet', async () => {
    render(<RelationshipTypeEditor existingTypeIds={[]} onSave={noop} onCancel={noop} />)
    await userEvent.click(screen.getByRole('button', { name: /appearance/i }))
    expect(screen.getByText(/the canvas does not draw them yet/i)).toBeTruthy()
  })
})

/**
 * A relationship type's fields: the properties its relationships carry that publishing checks, set
 * on a Fields tab as an entity type's are — required, allowed values — without what only an entity
 * type's field means (where it shows, import matching, uniqueness). They travel with the type, and
 * a save keeps what the editor doesn't hold (its label field, a key a later server added).
 */
describe('RelationshipTypeEditor — fields', () => {
  const owns = () => relDefToSchema('OWNS', {
    name: 'Owns', label_field: 'since', rank: 3,
    fields: [{ id: 'since', name: 'Since', type: 'date', required: true, display_order: 0 }],
  })

  it('adds a field bound to a property key the type’s relationships carry, and saves it with the type', async () => {
    const onSave = vi.fn()
    render(<RelationshipTypeEditor relType={owns()} existingTypeIds={['OWNS']} propertyKeys={['tier', 'weight']}
      onSave={onSave} onCancel={noop} />)
    await userEvent.click(screen.getByRole('button', { name: /^fields$/i }))
    expect(screen.getByText('since', { selector: 'code' })).toBeInTheDocument()
    // An entity type's options alone are not offered.
    expect(screen.queryByRole('checkbox', { name: 'Must be unique' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: 'Match imports by this' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: 'Node' })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Add Field' }))
    expect(screen.getByRole('button', { name: /stage changes/i })).toBeDisabled()
    await userEvent.type(screen.getAllByRole('textbox', { name: 'Field name' })[1], 'Tier')
    // Offered the keys its relationships carry (an input with suggestions is a combobox).
    expect(screen.getByRole('combobox', { name: 'Property key' })).toHaveValue('tier')
    expect(document.querySelector('datalist option[value="weight"]')).not.toBeNull()
    await userEvent.type(screen.getByRole('textbox', { name: 'Add to allowed values of tier' }), 'gold{Enter}silver{Enter}')
    await userEvent.click(screen.getAllByRole('checkbox', { name: 'Required' })[1])
    await userEvent.click(screen.getByRole('button', { name: /stage changes/i }))

    const saved = onSave.mock.calls[0][0]
    expect(saved.fields.map((f: { id: string; required: boolean }) => [f.id, f.required])).toEqual([['since', true], ['tier', true]])
    expect(saved.fields[1]).toMatchObject({ allowedValues: ['gold', 'silver'] })
    expect(relSchemaToBackend(saved, { name: 'Owns', label_field: 'since', rank: 3 })).toMatchObject({
      rank: 3, label_field: 'since',
      fields: [{ id: 'since', required: true, type: 'date' }, { id: 'tier', required: true, allowed_values: ['gold', 'silver'] }],
    })
  })

  it('round-trips through the ontology: stored as set, read back as stored, nothing stored when none', () => {
    const read = owns()
    expect(read.labelField).toBe('since')
    expect(read.fields).toEqual([expect.objectContaining({ id: 'since', name: 'Since', type: 'date', required: true })])
    const stored = relSchemaToBackend(read, { name: 'Owns', label_field: 'since', rank: 3, fields: [] })
    expect(relDefToSchema('OWNS', stored)).toEqual(read)
    // A type without fields or a label field stores neither — and drops the ones it no longer has.
    const plain = relSchemaToBackend({ ...read, fields: [], labelField: undefined }, stored)
    expect('fields' in plain || 'label_field' in plain).toBe(false)
    expect(plain.rank).toBe(3)
  })
})
