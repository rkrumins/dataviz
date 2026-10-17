/**
 * Every option says how many views it would leave given the other filters. A zero
 * is a dead end, shown dimmed — but still pickable, since with several picked any
 * one is enough. Single-select menus (Source, Visibility) pick one and close.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Tag } from 'lucide-react'
import { FilterDropdown } from '../FilterDropdown'

const OPTIONS = [
  { id: 'pii', label: 'pii', count: 12 },
  { id: 'gdpr', label: 'gdpr', count: 0 },
]

describe('FilterDropdown counts', () => {
  it('shows each option\'s count and dims a dead end without disabling it', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<FilterDropdown icon={Tag} label="Tag" accent="amber" options={OPTIONS} selectedIds={[]} onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: /Tag/ }))
    const pii = screen.getByRole('button', { name: /pii\s*12/ })
    const gdpr = screen.getByRole('button', { name: /gdpr\s*0/ })
    expect(pii.className).not.toMatch(/opacity-50/)
    expect(gdpr.className).toMatch(/opacity-50/)
    await user.click(gdpr)
    expect(onChange).toHaveBeenCalledWith(['gdpr'])
  })

  it('in single mode, picks one, closes, and lets go on a second pick', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { rerender } = render(
      <FilterDropdown icon={Tag} label="Source" accent="emerald" selectionMode="single" options={OPTIONS} selectedIds={[]} onChange={onChange} />,
    )
    await user.click(screen.getByRole('button', { name: /Source/ }))
    await user.click(screen.getByRole('button', { name: /pii/ }))
    expect(onChange).toHaveBeenLastCalledWith(['pii'])
    expect(screen.queryByRole('button', { name: /gdpr/ })).toBeNull()

    rerender(
      <FilterDropdown icon={Tag} label="Source" accent="emerald" selectionMode="single" options={OPTIONS} selectedIds={['pii']} onChange={onChange} />,
    )
    await user.click(screen.getByRole('button', { name: /1 source/ }))
    await user.click(screen.getByRole('button', { name: /pii\s*12/ }))
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it('closes on Escape and hands focus back to its trigger', async () => {
    const user = userEvent.setup()
    render(<FilterDropdown icon={Tag} label="Tag" accent="amber" options={OPTIONS} selectedIds={[]} onChange={() => {}} />)
    const trigger = screen.getByRole('button', { name: /Tag/ })
    await user.click(trigger)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('button', { name: /gdpr/ })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
