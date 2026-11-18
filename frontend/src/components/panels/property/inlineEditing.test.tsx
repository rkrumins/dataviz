/**
 * Inline property editing: what each row says it changed, and a number that is not one never
 * becomes 0 — the field says why and keeps the typing.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PropertyEditor } from '../PropertyEditor'
import { propertyMarks, shortValue } from './changeMarks'

describe('propertyMarks', () => {
  it('tells new, changed and removed keys from the properties as read', () => {
    const { marks, removed } = propertyMarks(
      { owner: 'bea', sla: '1h', tier: 'gold' },
      { owner: 'ana', sla: '1h', legacy: true },
    )
    expect([...marks]).toEqual([['owner', { mark: 'changed', was: 'ana', unsaved: true }], ['tier', { mark: 'new', unsaved: true }]])
    expect(removed).toEqual([['legacy', true]])
  })

  it('a value put back reads as unchanged', () => {
    const { marks, removed } = propertyMarks({ tags: ['a', 'b'] }, { tags: ['a', 'b'] })
    expect(marks.size).toBe(0)
    expect(removed).toEqual([])
  })

  it('says a value in one short line', () => {
    expect(shortValue(true)).toBe('Yes')
    expect(shortValue(['pii', 'gdpr'])).toBe('pii, gdpr')
    expect(shortValue('')).toBe('empty')
  })
})

describe('PropertyEditor — inline', () => {
  it('a number that is not one is refused with a reason, never kept as 0', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<PropertyEditor value={{ rows: 10 }} onChange={onChange} inline groupByPath bare />)
    await user.click(screen.getByRole('button', { name: 'Edit rows' }))
    const field = screen.getByRole('textbox', { name: 'rows' })
    await user.clear(field)
    await user.type(field, 'ten{Enter}')
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('isn’t a number')

    await user.clear(field)
    await user.type(field, '12{Enter}')
    expect(onChange).toHaveBeenCalledWith({ rows: 12 })
  })

  it('a date has Today and Clear; a number reads back grouped; a link names its site', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<PropertyEditor value={{ due: '2026-01-02', rows: 10, docs: 'https://example.com/a' }} onChange={onChange} inline groupByPath bare />)
    await user.click(screen.getByRole('button', { name: 'Edit due' }))
    await user.click(screen.getByRole('button', { name: 'Today' }))
    const d = new Date()
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ due: today }))

    await user.click(screen.getByRole('button', { name: 'Edit rows' }))
    const rows = screen.getByRole('textbox', { name: 'rows' })
    await user.clear(rows)
    await user.type(rows, '1250000')
    expect(screen.getByText(`Reads as ${(1250000).toLocaleString()}`)).toBeInTheDocument()
    await user.keyboard('{Escape}')

    await user.click(screen.getByRole('button', { name: 'Edit docs' }))
    const docs = screen.getByRole('textbox', { name: 'docs' })
    expect(screen.getByText('Opens example.com/a')).toBeInTheDocument()
    await user.clear(docs)
    await user.type(docs, 'wiki page')
    expect(screen.getByText(/Doesn’t look like a web address yet/)).toBeInTheDocument()
  })

  it('a date and time is picked in the reader’s time and stored in UTC; opened and left, it is untouched', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<PropertyEditor value={{ due: '2026-11-18T05:42:00Z' }} onChange={onChange} inline groupByPath bare />)
    await user.click(screen.getByRole('button', { name: 'Edit due' }))
    const field = screen.getByLabelText('due') as HTMLInputElement
    expect(field.type).toBe('datetime-local')
    // Left as it was: nothing is kept.
    await user.keyboard('{Enter}')
    expect(onChange).not.toHaveBeenCalled()
    // An hour later in the reader's time: stored in UTC, to the second.
    await user.click(screen.getByRole('button', { name: 'Edit due' }))
    const later = new Date(Date.parse('2026-11-18T05:42:00Z') + 3600_000)
    const pick = `${later.getFullYear()}-${String(later.getMonth() + 1).padStart(2, '0')}-${String(later.getDate()).padStart(2, '0')}T${String(later.getHours()).padStart(2, '0')}:${String(later.getMinutes()).padStart(2, '0')}:00`
    fireEvent.change(screen.getByLabelText('due'), { target: { value: pick } })
    expect(screen.getByText(/stored as 2026-11-18T06:42:00Z/)).toBeInTheDocument()
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenLastCalledWith({ due: '2026-11-18T06:42:00Z' })
  })

  it('a Yes/No is kept the moment it flips', async () => {
    const onChange = vi.fn()
    render(<PropertyEditor value={{ pii: false }} onChange={onChange} inline groupByPath bare />)
    await userEvent.click(screen.getByRole('switch'))
    expect(onChange).toHaveBeenCalledWith({ pii: true })
  })

  it('offers suggested names, and one click starts the form with it', async () => {
    const user = userEvent.setup()
    render(<PropertyEditor value={{ owner: 'ana' }} onChange={vi.fn()} inline groupByPath bare suggestions={['owner', 'domain']} />)
    expect(screen.queryByRole('button', { name: 'Add owner' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add domain' }))
    expect(screen.getByPlaceholderText('Property name')).toHaveValue('domain')
  })
})
