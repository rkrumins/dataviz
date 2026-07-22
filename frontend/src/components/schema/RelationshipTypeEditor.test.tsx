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
import { describe, it, expect } from 'vitest'
import { RelationshipTypeEditor } from './RelationshipTypeEditor'
import { relDefToSchema } from '@/features/ontology/lib/ontology-parsers'

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
