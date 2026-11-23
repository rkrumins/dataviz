/**
 * The bulk dialog's property name: every property the view carries is offered, not the first eight
 * — scrolled to with the mouse, by the list's scrollbar without the field losing focus, and by the
 * arrow keys to the last one.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSchemaStore } from '@/store/schema'
import type { SearchCatalogProperty } from '@/types/search'
import { WhatStep } from '../WhatStep'
import type { OpDraft } from '../opModel'

const op: OpDraft = { kind: 'set', key: '', to: '', value: '', onConflict: 'skip' }
const properties = Array.from({ length: 20 }, (_, i) => (
  { key: `col_${i + 1}_name`, count: 100 - i, distinct: 1, distinctExact: true, values: [] }
)) as unknown as SearchCatalogProperty[]

beforeEach(() => {
  useSchemaStore.setState({ schema: { entityTypes: [], relationshipTypes: [] } } as never)
})

describe('WhatStep — naming the property', () => {
  it('offers every property the view carries, past the first eight', async () => {
    const onChange = vi.fn()
    render(<WhatStep op={op} onChange={onChange} properties={properties} viewId="v1" />)
    await userEvent.setup().click(screen.getByRole('combobox', { name: 'Property' }))
    const list = screen.getByRole('listbox', { name: 'Properties in this view' })
    expect(within(list).getAllByRole('option')).toHaveLength(20)
    expect(screen.getByText('20 suggestions · type to narrow')).toBeInTheDocument()
    await userEvent.setup().click(within(list).getByRole('option', { name: /col_17_name/ }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ key: 'col_17_name' }))
  })

  it('stays open, the field focused, when the list’s scrollbar is pressed', async () => {
    const user = userEvent.setup()
    render(<WhatStep op={op} onChange={vi.fn()} properties={properties} viewId="v1" />)
    const field = screen.getByRole('combobox', { name: 'Property' })
    await user.click(field)
    const scroller = screen.getByRole('listbox', { name: 'Properties in this view' }).parentElement!
    await user.pointer({ keys: '[MouseLeft>]', target: scroller })
    await user.pointer({ keys: '[/MouseLeft]', target: scroller })
    await new Promise((r) => setTimeout(r, 150))   // past the field's close-on-blur delay
    expect(field).toHaveFocus()
    expect(screen.getByRole('listbox', { name: 'Properties in this view' })).toBeInTheDocument()
  })

  it('reaches the last property by keyboard', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<WhatStep op={op} onChange={onChange} properties={properties} viewId="v1" />)
    const field = screen.getByRole('combobox', { name: 'Property' })
    await user.click(field)
    await user.keyboard('{ArrowDown}'.repeat(25))
    expect(field).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: /col_20_name/ }).id)
    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ key: 'col_20_name' }))
  })
})
