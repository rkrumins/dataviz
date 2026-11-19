/**
 * EntityDiff — a changed entity, property by property: each property its own row (never one
 * `properties` line), a summary of what changed, the first rows then all on request, and the raw
 * before/after for the technical persona.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { usePersonaStore } from '@/store/persona'
import type { GraphChange } from '../../model/changeModel'
import { EntityDiff, FIRST_ROWS } from '../EntityDiff'

const modified = (before: Record<string, unknown>, after: Record<string, unknown>): GraphChange => ({
  entityId: 'e1', kind: 'node', status: 'modified', label: 'Orders', before, after, origin: { source: 'branch', branchId: 'b1' },
})

describe('EntityDiff', () => {
  it('shows each property that changed, with a summary', () => {
    render(<EntityDiff change={modified(
      { displayName: 'orders', properties: { owner: 'ana', keep: 1 } },
      { displayName: 'Orders', properties: { owner: 'bo', keep: 1, pii: true } },
    )} />)
    expect(screen.getByText('Name')).toBeInTheDocument()
    expect(screen.getByText('owner')).toBeInTheDocument()
    expect(screen.getByText('pii')).toBeInTheDocument()
    expect(screen.queryByText('keep')).not.toBeInTheDocument()
    expect(screen.queryByText('properties')).not.toBeInTheDocument()
    expect(screen.getByText('2 changed')).toBeInTheDocument()
    expect(screen.getByText('1 added')).toBeInTheDocument()
  })

  it('shows the first rows, then all of them on request', () => {
    const after: Record<string, unknown> = {}
    for (let i = 0; i < FIRST_ROWS + 15; i++) after[`p${String(i).padStart(3, '0')}`] = i + 1
    render(<EntityDiff change={modified({ properties: {} }, { properties: after })} />)
    expect(screen.queryByText('p030')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: `Show all ${FIRST_ROWS + 15}` }))
    expect(screen.getByText('p030')).toBeInTheDocument()
  })

  it('lists an added entity’s fields without repeating “Added” on each', () => {
    render(<EntityDiff change={{ ...modified({}, {}), status: 'added', before: undefined, after: { displayName: 'New', properties: { owner: 'ana' } } }} />)
    expect(screen.getByText('2 fields set')).toBeInTheDocument()
    expect(screen.queryByText('Added')).not.toBeInTheDocument()
  })

  it('offers the raw payloads to the technical persona only', () => {
    const change = modified({ displayName: 'a', version: 'v1' }, { displayName: 'b', version: 'v2' })
    usePersonaStore.setState({ mode: 'business' })
    const { unmount } = render(<EntityDiff change={change} />)
    expect(screen.queryByText('Technical details')).not.toBeInTheDocument()
    unmount()
    usePersonaStore.setState({ mode: 'technical' })
    render(<EntityDiff change={change} />)
    fireEvent.click(screen.getByText('Technical details'))
    expect(screen.getByText('Before')).toBeInTheDocument()
    expect(screen.getByText('After')).toBeInTheDocument()
  })
})
