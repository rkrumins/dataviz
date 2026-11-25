/**
 * The bulk dialog's What over relationships: a field of a relationship type — the ones the target
 * reaches when known, else any the schema has — offers its allowed values for the value, as an
 * entity type's field does, and says when the value given is one publishing refuses. Their values
 * are cleaned up as an entity's are, previewed on the values read from the relationships the
 * change reaches — never the view's entities' catalog.
 */
import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSchemaStore } from '@/store/schema'
import type { SearchCatalogProperty } from '@/types/search'
import type { OpDraft } from '../opModel'
import type { RelationshipValues } from '../useRelationshipValues'

const catalogAsked = vi.hoisted(() => [] as boolean[])
vi.mock('../useAllValues', () => ({
  useAllValues: (_view: string, _key: string, enabled = true) => {
    catalogAsked.push(enabled)
    return { values: enabled ? [{ value: 'an entity’s', kind: 'String', count: 99 }] : null, loading: false, error: null, retry: vi.fn() }
  },
}))

import { WhatStep } from '../WhatStep'

const field = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, type: 'string', required: false, showInNode: false, showInPanel: true, showInTooltip: false, displayOrder: 0, ...extra,
})
const op = (patch: Partial<OpDraft>): OpDraft => ({ kind: 'set', key: '', to: '', value: '', onConflict: 'skip', ...patch })

beforeEach(() => {
  catalogAsked.length = 0
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

describe('WhatStep — a clean-up of relationships', () => {
  const team: SearchCatalogProperty = {
    key: 'team', count: 3, distinct: 3, distinctExact: true, byEntityType: { FLOWS_TO: 3 }, kinds: { String: 2, Integer: 1 }, residual: 0,
    values: [{ value: ' Finance', kind: 'String', count: 2 }, { value: 'finance', kind: 'String', count: 1 }, { value: 7, kind: 'Integer', count: 1 }],
  }
  const read = (over: Partial<RelationshipValues> = {}): RelationshipValues => ({
    property: team, values: team.values, read: 3, truncated: false, loading: false, error: null, retry: vi.fn(), ...over,
  })

  it('offers every clean-up, and previews one on the values read from the relationships it reaches', () => {
    render(<WhatStep op={op({ kind: 'normalize', key: 'team' })} onChange={vi.fn()} properties={[team]} viewId="v1" edges
      relationshipValues={read()} />)
    const kinds = within(screen.getByRole('radiogroup', { name: 'Operation' })).getAllByRole('radio').map((r) => r.textContent)
    expect(kinds).toEqual(expect.arrayContaining(['Find & replace', 'Normalize', 'Merge values', 'Convert kind']))
    const changes = within(screen.getByRole('list', { name: 'Before and after' })).getAllByRole('listitem')
    expect(changes.map((li) => li.textContent)).toEqual(['“ Finance”“Finance”2'])
    expect(screen.getByText(/change — on/)).toHaveTextContent('1 value change — on 2 relationships it reaches.')
  })

  it('says when only the first of the relationships it reaches were read', () => {
    render(<WhatStep op={op({ kind: 'convert', key: 'team', toKind: 'Integer' })} onChange={vi.fn()} properties={[team]} viewId="v1" edges
      relationshipValues={read({ read: 400, truncated: true })} />)
    expect(screen.getByText(/^Stored as/)).toHaveTextContent('Stored as Text on 2 and Integer on 1 of the first 400 relationships it reaches.')
    expect(catalogAsked.every((asked) => !asked)).toBe(true)
  })

  it('merges only the values read, never the view’s entities’', () => {
    render(<WhatStep op={op({ kind: 'mapValues', key: 'team' })} onChange={vi.fn()} properties={[team]} viewId="v1" edges
      relationshipValues={read()} />)
    expect(screen.getByRole('list', { name: 'Values to merge' })).toHaveTextContent('2 values → “finance”3')
    expect(screen.queryByText(/an entity’s/)).toBeNull()
    expect(catalogAsked.length > 0 && catalogAsked.every((asked) => !asked)).toBe(true)
  })

  it('waits for the values while they are read, and says when they couldn’t be', () => {
    const { rerender } = render(<WhatStep op={op({ kind: 'replace', key: 'team', find: 'fin' })} onChange={vi.fn()} properties={[]} viewId="v1" edges
      relationshipValues={read({ property: null, values: null, read: 0, loading: true })} />)
    expect(screen.queryByText(/nothing to preview/)).toBeNull()
    rerender(<WhatStep op={op({ kind: 'replace', key: 'team', find: 'fin' })} onChange={vi.fn()} properties={[]} viewId="v1" edges
      relationshipValues={read({ property: null, values: [], read: 3 })} />)
    expect(screen.getByText('None of the relationships it reaches holds a value of it, so there is nothing to preview.')).toBeInTheDocument()
    rerender(<WhatStep op={op({ kind: 'replace', key: 'team', find: 'fin' })} onChange={vi.fn()} properties={[]} viewId="v1" edges
      relationshipValues={read({ property: null, values: null, read: 0, error: 'the server didn’t answer' })} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t read every value it holds: the server didn’t answer.')
  })
})
