/**
 * A property's whole life, edited the way the drawer edits it (in place, in sections, told against
 * the properties as read): added, read, edited, renamed, retyped, deleted and restored, reverted —
 * and the same for a folder. Every step hands back the whole bag, ready to stage.
 */
import { useState } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PropertyEditor } from '../../PropertyEditor'

function Drawer({ initial, onChange }: { initial: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const [value, setValue] = useState(initial)
  return (
    <PropertyEditor value={value} original={initial} inline groupByPath searchable bare
      onChange={(next) => { setValue(next as Record<string, unknown>); onChange(next as Record<string, unknown>) }} />
  )
}

const rowOf = (key: string) => screen.getByRole('button', { name: `Rename ${key}` }).closest('.group') as HTMLElement

describe('a property, from start to finish', () => {
  it('adds one, edits it, renames it, retypes it, deletes it', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Drawer initial={{ tier: 'gold' }} onChange={onChange} />)

    // Create
    await user.click(screen.getByRole('button', { name: 'Add property' }))
    await user.type(screen.getByRole('combobox', { name: 'Property name' }), 'owner')
    await user.type(screen.getByRole('textbox', { name: 'Value' }), 'Finance{Enter}')
    expect(onChange).toHaveBeenLastCalledWith({ tier: 'gold', owner: 'Finance' })
    expect(within(rowOf('owner')).getByText('New')).toBeInTheDocument()

    // Read and update, in place
    await user.click(screen.getByRole('button', { name: 'Edit owner' }))
    const field = screen.getByRole('textbox', { name: 'owner' })
    await user.clear(field)
    await user.type(field, 'Data platform{Enter}')
    expect(onChange).toHaveBeenLastCalledWith({ tier: 'gold', owner: 'Data platform' })
    expect(screen.getByText('Data platform')).toBeInTheDocument()

    // Rename
    await user.click(screen.getByRole('button', { name: 'Rename owner' }))
    const name = screen.getByDisplayValue('owner')
    await user.clear(name)
    await user.type(name, 'steward{Enter}')
    expect(onChange).toHaveBeenLastCalledWith({ tier: 'gold', steward: 'Data platform' })

    // Retype: as tags, the text becomes one
    await user.click(within(rowOf('steward')).getByLabelText('Change type'))
    await user.click(screen.getByText('Tags'))
    expect(onChange).toHaveBeenLastCalledWith({ tier: 'gold', steward: ['Data platform'] })

    // Delete — a new one simply goes
    await user.click(screen.getByRole('button', { name: 'Delete steward' }))
    expect(onChange).toHaveBeenLastCalledWith({ tier: 'gold' })
    expect(screen.queryByText('steward')).not.toBeInTheDocument()
  })

  it('an edited one says what it was and reverts; a deleted one stays listed and restores', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Drawer initial={{ tier: 'gold', sla: '1h' }} onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: 'Edit tier' }))
    const field = screen.getByRole('textbox', { name: 'tier' })
    await user.clear(field)
    await user.type(field, 'silver{Enter}')
    expect(within(rowOf('tier')).getByText('Edited')).toBeInTheDocument()
    expect(within(rowOf('tier')).getByText('gold')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Revert tier' }))
    expect(onChange).toHaveBeenLastCalledWith({ tier: 'gold', sla: '1h' })

    await user.click(screen.getByRole('button', { name: 'Delete sla' }))
    expect(onChange).toHaveBeenLastCalledWith({ tier: 'gold' })
    expect(screen.getByText('Removed')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Restore' }))
    expect(onChange).toHaveBeenLastCalledWith({ tier: 'gold', sla: '1h' })
  })

  it('a folder: add inside it, rename it, delete it whole', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<Drawer initial={{ 'Tech/db': 'pg', top: 1 }} onChange={onChange} />)
    const tech = () => screen.getByRole('region', { name: 'Tech' })

    await user.click(within(tech()).getByRole('button', { name: 'Add property in this folder' }))
    await user.type(within(tech()).getByRole('combobox', { name: 'Property name' }), 'port')
    await user.type(within(tech()).getByRole('textbox', { name: 'Value' }), '5432{Enter}')
    expect(onChange).toHaveBeenLastCalledWith({ 'Tech/db': 'pg', top: 1, 'Tech/port': 5432 })

    await user.click(within(tech()).getByRole('button', { name: 'Rename folder Tech' }))
    const name = within(tech()).getByDisplayValue('Tech')
    await user.clear(name)
    await user.type(name, 'Technical{Enter}')
    expect(onChange).toHaveBeenLastCalledWith({ 'Technical/db': 'pg', top: 1, 'Technical/port': 5432 })

    const technical = screen.getByRole('region', { name: 'Technical' })
    await user.click(within(technical).getByRole('button', { name: /Delete folder/ }))
    await user.click(within(technical).getByRole('button', { name: 'Delete 2?' }))
    expect(onChange).toHaveBeenLastCalledWith({ top: 1 })
  })

  it('long text is edited in place and reads wrapped, a few lines first', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const long = Array(10).fill('A sentence about the table and what it holds.').join('\n')
    render(<Drawer initial={{ notes: long }} onChange={onChange} />)
    expect(screen.getByRole('button', { name: /Show more/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit notes' }))
    const field = screen.getByRole('textbox', { name: 'notes' })
    await user.type(field, '{Shift>}{Enter}{/Shift}One more line.{Enter}')
    expect(onChange).toHaveBeenLastCalledWith({ notes: `${long}\nOne more line.` })
  })
})
