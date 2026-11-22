/**
 * The bulk dialog's What over relationships: a field of a relationship type — the ones the target
 * reaches when known, else any the schema has — offers its allowed values for the value, as an
 * entity type's field does, and says when the value given is one publishing refuses.
 */
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSchemaStore } from '@/store/schema'
import { WhatStep } from '../WhatStep'
import type { OpDraft } from '../opModel'

const field = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, type: 'string', required: false, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 0, ...extra,
})
const op = (patch: Partial<OpDraft>): OpDraft => ({ kind: 'set', key: '', to: '', value: '', onConflict: 'skip', ...patch })

beforeEach(() => {
  useSchemaStore.setState({ schema: {
    entityTypes: [{ id: 'table', name: 'Table', fields: [field('tier', 'Tier', { allowedValues: ['bronze'] })] }],
    relationshipTypes: [
      { id: 'FLOWS_TO', name: 'Flows to', fields: [] },
      { id: 'OWNS', name: 'Owns', fields: [field('tier', 'Tier', { type: 'status', allowedValues: ['gold', 'silver'] })] },
    ],
  } } as never)
})

describe('WhatStep — a change of relationships', () => {
  it('offers the allowed values of the relationship type’s field, never an entity type’s', () => {
    render(<WhatStep op={op({ key: 'tier' })} onChange={vi.fn()} properties={[]} viewId="v1" edges />)
    const picker = screen.getByRole('group', { name: 'Allowed values of Tier' })
    expect(within(picker).getAllByRole('button').map((b) => b.textContent)).toEqual(['gold', 'silver'])
    expect(screen.getByText('Tier takes only these values — publishing refuses any other.')).toBeInTheDocument()
  })

  it('keeps to the relationship types the target reaches, when it says', () => {
    render(<WhatStep op={op({ key: 'tier' })} onChange={vi.fn()} properties={[]} viewId="v1" edges entityTypes={['FLOWS_TO']} />)
    expect(screen.queryByRole('group', { name: /values of Tier/ })).toBeNull()
  })

  it('says when the value given is one the field refuses', () => {
    useSchemaStore.setState({ schema: { entityTypes: [], relationshipTypes: [
      { id: 'OWNS', name: 'Owns', fields: [field('tier', 'Tier', { allowedValues: ['gold'], allowOther: false })] },
    ] } } as never)
    render(<WhatStep op={op({ key: 'tier', value: 'lead' })} onChange={vi.fn()} properties={[]} viewId="v1" edges />)
    expect(screen.getByText(/Must be one of gold — “lead” isn’t\. Publishing will refuse it\./)).toBeInTheDocument()
  })
})
