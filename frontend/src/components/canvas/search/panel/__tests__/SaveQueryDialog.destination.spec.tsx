/**
 * SaveQueryDialog — where a query is kept: the view's library (for
 * everyone who can open the view, the default for someone who can edit
 * it) or this browser; a name the view refuses keeps the dialog open.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { RecentQueryEntry } from '@/store/searchStore'

import { SaveQueryDialog } from '../SaveQueryDialog'


const entry: RecentQueryEntry = {
    viewId: 'view-1', label: 'type IN (table)', timestamp: 1, pinned: false,
    predicate: { kind: 'entityType', op: 'in', values: ['table'] },
}


describe('SaveQueryDialog — where it is kept', () => {
    it('saves for everyone on the view by default, for someone who can edit it', async () => {
        const onSave = vi.fn()
        render(<SaveQueryDialog entry={entry} canSaveToView onCancel={vi.fn()} onSave={onSave} />)
        const user = userEvent.setup()
        expect(screen.getByRole('radio', { name: /Everyone on this view/ })).toHaveAttribute('aria-checked', 'true')
        await user.type(screen.getByPlaceholderText(/PII columns/), 'Tables')
        await user.click(screen.getByRole('button', { name: /^Save$/ }))
        expect(onSave).toHaveBeenCalledWith('Tables', undefined, 'view')
    })

    it('keeps it in this browser when asked', async () => {
        const onSave = vi.fn()
        render(<SaveQueryDialog entry={entry} canSaveToView onCancel={vi.fn()} onSave={onSave} />)
        const user = userEvent.setup()
        await user.click(screen.getByRole('radio', { name: /Just me/ }))
        await user.type(screen.getByPlaceholderText(/PII columns/), 'Tables')
        await user.click(screen.getByRole('button', { name: /^Save$/ }))
        expect(onSave).toHaveBeenCalledWith('Tables', undefined, 'me')
    })

    it('offers only this browser to someone who can\'t edit the view', async () => {
        const onSave = vi.fn()
        render(<SaveQueryDialog entry={entry} onCancel={vi.fn()} onSave={onSave} />)
        expect(screen.queryByRole('radiogroup')).toBeNull()
        const user = userEvent.setup()
        await user.type(screen.getByPlaceholderText(/PII columns/), 'Tables{Enter}')
        expect(onSave).toHaveBeenCalledWith('Tables', undefined, 'me')
    })

    it('stays open with the reason when the view refuses the name', async () => {
        const onSave = vi.fn().mockRejectedValue(new Error('A query named “Tables” is already saved in this view.'))
        render(<SaveQueryDialog entry={entry} canSaveToView onCancel={vi.fn()} onSave={onSave} />)
        const user = userEvent.setup()
        await user.type(screen.getByPlaceholderText(/PII columns/), 'Tables')
        await user.click(screen.getByRole('button', { name: /^Save$/ }))
        expect(await screen.findByRole('alert')).toHaveTextContent('A query named “Tables” is already saved in this view.')
        expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    it('starts from the name a query of one\'s own already has, to share it', () => {
        render(<SaveQueryDialog entry={{ ...entry, source: 'mine', name: 'My tables', description: 'Mine' }}
            canSaveToView onCancel={vi.fn()} onSave={vi.fn()} />)
        expect(screen.getByDisplayValue('My tables')).toBeInTheDocument()
        expect(screen.getByDisplayValue('Mine')).toBeInTheDocument()
    })
})
