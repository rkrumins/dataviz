/**
 * Tags as chips: Enter or a comma adds, Backspace takes the last off, the same tag in other
 * letters is the same tag, the limits hold, and suggestions — most used first — are a
 * listbox the arrow keys walk.
 */
import { useState } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TagInput } from '../TagInput'
import { rankTags } from '@/lib/tags'

function Harness({ initial = [], suggestions, max, onChange }: {
    initial?: string[]; suggestions?: string[]; max?: number; onChange?: (t: string[]) => void
}) {
    const [tags, setTags] = useState(initial)
    return <TagInput value={tags} suggestions={suggestions} max={max} onChange={t => { setTags(t); onChange?.(t) }} />
}

const chips = () => within(screen.queryByRole('list', { name: 'Tags' }) ?? document.createElement('ul'))
    .queryAllByRole('listitem').map(li => li.textContent)

describe('TagInput', () => {
    it('adds with Enter or a comma, tidied, and Backspace in an empty box takes the last off', async () => {
        const user = userEvent.setup()
        render(<Harness />)
        const box = screen.getByRole('combobox', { name: 'Tags' })
        await user.type(box, '  month   end {Enter}')
        await user.type(box, 'finance,ledger,')
        expect(chips()).toEqual(['month end', 'finance', 'ledger'])
        await user.type(box, '{Backspace}')
        expect(chips()).toEqual(['month end', 'finance'])
        await user.click(screen.getByRole('button', { name: 'Remove month end' }))
        expect(chips()).toEqual(['finance'])
    })

    it('treats the same tag in other letters as the same tag', async () => {
        const user = userEvent.setup()
        const onChange = vi.fn()
        render(<Harness initial={['Finance']} onChange={onChange} />)
        await user.type(screen.getByRole('combobox'), 'FINANCE{Enter}')
        expect(onChange).not.toHaveBeenCalled()
        expect(chips()).toEqual(['Finance'])
    })

    it('holds to the limits: so many tags, so many characters', async () => {
        const user = userEvent.setup()
        render(<Harness initial={['a', 'b']} max={3} />)
        const box = screen.getByRole('combobox')
        expect(box).toHaveAttribute('maxLength', '40')
        await user.type(box, 'c,d,e,')
        expect(chips()).toEqual(['a', 'b', 'c'])
        expect(box).toHaveAttribute('placeholder', '3 tags — the most there can be')
        expect(screen.getByText('3/3')).toBeInTheDocument()
    })

    it('suggests tags in use, most used first, leaving out the chosen; the arrows and Enter pick one', async () => {
        const user = userEvent.setup()
        const suggestions = rankTags([['finance', 'ledger'], ['Finance', 'gl'], ['finance', 'gl'], null])
        expect(suggestions).toEqual(['finance', 'gl', 'ledger'])
        render(<Harness initial={['gl']} suggestions={suggestions} />)
        const box = screen.getByRole('combobox')
        await user.click(box)
        expect(box).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['finance', 'ledger'])
        await user.type(box, 'le')
        expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['ledger'])
        await user.keyboard('{ArrowDown}')
        expect(screen.getByRole('option', { name: 'ledger' })).toHaveAttribute('aria-selected', 'true')
        expect(box).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'ledger' }).id)
        await user.keyboard('{Enter}')
        expect(chips()).toEqual(['gl', 'ledger'])
        await user.click(screen.getByRole('option', { name: 'finance' }))
        expect(chips()).toEqual(['gl', 'ledger', 'finance'])
        expect(box).toHaveAttribute('aria-expanded', 'false')
    })
})
