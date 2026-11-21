/**
 * The sort a list-header click chooses, and what the sort menu calls it.
 *
 * The menu used to read "Recently modified" with nothing ticked whenever a column
 * sort (Type, Owner, Least liked) or an unknown `?sort=` was in force, and cycling
 * off a column landed on "Newest created" instead of the page's default.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ExplorerSortControl } from '../ExplorerSortControl'
import { ExplorerListHeader } from '../ExplorerListHeader'
import { cycleColumnSort as cycle, parseSort } from '../sortOptions'

describe('parseSort', () => {
  it('keeps every sort the list knows and falls back to the default otherwise', () => {
    expect(parseSort('owner-za')).toBe('owner-za')
    expect(parseSort('most-opened')).toBe('most-opened')
    expect(parseSort('bogus')).toBe('recently-modified')
    expect(parseSort('')).toBe('recently-modified')
    expect(parseSort(null)).toBe('recently-modified')
  })
})

describe('ExplorerSortControl', () => {
  it('names a column sort it does not list', () => {
    render(<ExplorerSortControl sort="type-az" onSortChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Type A → Z/ })).toBeInTheDocument()
  })
})

describe('list header cycling', () => {
  it('goes none → asc → desc → the page default', () => {
    expect(cycle('recently-modified', 'owner')).toBe('owner-az')
    expect(cycle('owner-az', 'owner')).toBe('owner-za')
    expect(cycle('owner-za', 'owner')).toBe('recently-modified')
  })

  it('sorts Updated by the time it shows, toggling around the default', () => {
    expect(cycle('newest', 'updated')).toBe('modified-asc')
    expect(cycle('modified-asc', 'updated')).toBe('recently-modified')
    expect(cycle('recently-modified', 'updated')).toBe('modified-asc')
  })

  it('reports the click as the next sort', () => {
    const onSortChange = vi.fn()
    render(<ExplorerListHeader sort="recently-modified" onSortChange={onSortChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Type/i }))
    expect(onSortChange).toHaveBeenCalledWith('type-az')
  })
})
