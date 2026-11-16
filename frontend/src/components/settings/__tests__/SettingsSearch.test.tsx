/**
 * Search finds a setting by any word for it — aliases, symptoms, the env var — says why each result
 * matched, works from the keyboard, and `/` jumps to it from anywhere outside a text field.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SCHEMA } from '../__fixtures__/schema'
import { searchSettings } from '../search'
import { SettingsSearch } from '../SettingsSearch'

describe('searchSettings', () => {
    it('matches aliases, symptoms, env vars and keys, best field first', () => {
        expect(searchSettings(SCHEMA.settings, 'stale reads')[0]).toMatchObject({ field: 'alias', setting: { key: 'reads.mode' } })
        expect(searchSettings(SCHEMA.settings, 'staleness')[0]).toMatchObject({ field: 'alias', setting: { key: 'reads.maxVersionsBehind' } })
        expect(searchSettings(SCHEMA.settings, 'slow after a big import')[0])
            .toMatchObject({ field: 'symptom', text: 'Canvases are slow after a big import', setting: { key: 'reads.mode' } })
        expect(searchSettings(SCHEMA.settings, 'GRAPHVER_PROJECTION_PACING_RATIO')[0]).toMatchObject({ field: 'env', setting: { key: 'updates.pacingRatio' } })
        expect(searchSettings(SCHEMA.settings, 'reads.mode')[0]).toMatchObject({ field: 'key' })
        expect(searchSettings(SCHEMA.settings, 'read mode')[0]).toMatchObject({ field: 'label', setting: { key: 'reads.mode' } })
        expect(searchSettings(SCHEMA.settings, 'zzzz')).toEqual([])
    })
})

describe('SettingsSearch', () => {
    it('lists matches with why they matched, and opens one from the keyboard', async () => {
        const user = userEvent.setup()
        const onSelect = vi.fn()
        render(<SettingsSearch settings={SCHEMA.settings} categories={SCHEMA.categories} onSelect={onSelect} />)
        const box = screen.getByRole('combobox', { name: 'Search settings' })
        await user.type(box, 'duplicates')
        expect(box).toHaveAttribute('aria-expanded', 'true')
        const list = screen.getByRole('listbox', { name: 'Settings found' })
        const first = within(list).getAllByRole('option')[0]
        expect(first).toHaveTextContent('Match rows by')
        expect(first).toHaveTextContent('Answers: Imports create duplicates instead of updating')
        expect(first).toHaveAttribute('aria-selected', 'true')
        await user.keyboard('{Enter}')
        expect(onSelect).toHaveBeenCalledWith('imports.identifier')
    })

    it('moves through results with the arrows and says when nothing matches', async () => {
        const user = userEvent.setup()
        render(<SettingsSearch settings={SCHEMA.settings} onSelect={() => {}} />)
        const box = screen.getByRole('combobox', { name: 'Search settings' })
        await user.type(box, 'unload')
        const options = screen.getAllByRole('option')
        expect(options.length).toBeGreaterThan(1)
        await user.keyboard('{ArrowDown}')
        expect(options[1]).toHaveAttribute('aria-selected', 'true')
        expect(box).toHaveAttribute('aria-activedescendant', options[1].id)
        await user.clear(box)
        await user.type(box, 'qqqq')
        expect(screen.getByText(/No setting matches “qqqq”/)).toBeInTheDocument()
    })

    it('“/” jumps to the search, but not while typing elsewhere', async () => {
        const user = userEvent.setup()
        render(<><input aria-label="Elsewhere" /><SettingsSearch settings={SCHEMA.settings} onSelect={() => {}} /></>)
        const box = screen.getByRole('combobox', { name: 'Search settings' })
        await user.click(screen.getByRole('textbox', { name: 'Elsewhere' }))
        await user.keyboard('/')
        expect(box).not.toHaveFocus()
        await user.click(document.body)
        await user.keyboard('/')
        expect(box).toHaveFocus()
        expect(box).toHaveValue('')
    })
})
