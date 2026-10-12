/** Settling a conflict in Review: per-field choice (yours by default), all-at-once shortcuts. */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StagedChange } from '@/store/stagedChangesStore'

const resolveConflict = vi.fn()
vi.mock('../../model/rebaseStagedChange', () => ({ resolveConflict: (...a: unknown[]) => resolveConflict(...a) }))

import { ConflictChoices } from '../ConflictChoices'

const change = {
  id: 'c1', type: 'update_entity', targetId: 'n', summary: '', timestamp: 0, after: {},
  conflict: {
    fields: [
      { key: 'properties.owner', path: ['properties', 'owner'], base: 'ana', mine: 'bo', theirs: 'cy' },
      { key: 'displayName', path: ['displayName'], base: 'A', mine: 'B', theirs: 'C' },
    ],
    current: { kind: 'node', version: 'v2', node: {} },
  },
} as unknown as StagedChange

beforeEach(() => resolveConflict.mockReset())

describe('ConflictChoices', () => {
  it('shows each field with the value it had, yours and theirs', () => {
    render(<ConflictChoices change={change} />)
    expect(screen.getByText('2 fields changed by someone else')).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: /owner/ })).toBeInTheDocument()
    expect(screen.getByRole('radiogroup', { name: /Name/ })).toBeInTheDocument()
    expect(screen.getByText('was ana')).toBeInTheDocument()
  })

  it('keeps yours by default and applies a per-field choice', async () => {
    const user = userEvent.setup()
    render(<ConflictChoices change={change} />)
    await user.click(screen.getAllByRole('radio', { name: /Theirs/ })[1])
    await user.click(screen.getByRole('button', { name: 'Use these values' }))
    expect(resolveConflict).toHaveBeenCalledWith('c1', { 'properties.owner': 'mine', displayName: 'theirs' })
  })

  it('takes all of theirs at once', async () => {
    const user = userEvent.setup()
    render(<ConflictChoices change={change} />)
    await user.click(screen.getByRole('button', { name: 'Use all theirs' }))
    await user.click(screen.getByRole('button', { name: 'Use these values' }))
    expect(resolveConflict).toHaveBeenCalledWith('c1', { 'properties.owner': 'theirs', displayName: 'theirs' })
  })

  it('offers only to drop a change whose entity was deleted meanwhile', async () => {
    const gone = { ...change, conflict: { ...change.conflict!, current: { kind: 'node', version: null, deleted: true } } } as StagedChange
    render(<ConflictChoices change={gone} />)
    await userEvent.click(screen.getByRole('button', { name: 'Drop this change' }))
    expect(resolveConflict).toHaveBeenCalledWith('c1', {})
  })
})
