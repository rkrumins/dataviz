import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { Predicate } from '@/types/search'

import { SearchOmnibox } from '../SearchOmnibox'



/**
 * Suggestions are addressed by their stable id rather than their text.
 * The visible label is split across <span>/<mark> nodes by
 * HighlightedText, and testing-library's text queries only look at an
 * element's direct text children — so a label query would be asserting
 * the absence of highlighting, not the presence of the suggestion.
 */
function option(id: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[cmdk-item][data-value="${id}"]`)
}

const optionLabels = () =>
    Array.from(document.querySelectorAll('[cmdk-item]'))
        .map((el) => el.getAttribute('data-value'))


function renderOmnibox(onAdd = vi.fn()) {
    render(
        <SearchOmnibox
            onAdd={onAdd}
            entityTypes={['dataset', 'PII_Report']}
            tagValues={['PII', 'deprecated']}
            propertyKeys={['classification', 'owner']}
            valueSamples={[
                { key: 'classification', value: 'PII', lc: 'pii' },
            ]}
            layers={[{ value: 'gold', label: 'Gold' }]}
        />,
    )
    return { onAdd }
}


describe('SearchOmnibox', () => {
    it('reaches a property filter directly, with no text search first', async () => {
        // The reported problem: getting to a property filter meant
        // running a text search, adding a filter, then deleting the
        // text row. One keystroke should be enough.
        const user = userEvent.setup()
        const { onAdd } = renderOmnibox()

        await user.type(screen.getByRole('combobox'), 'classification')
        await waitFor(() => expect(option('key:classification')).not.toBeNull())
        await user.click(option('key:classification')!)

        expect(onAdd).toHaveBeenCalledTimes(1)
        const [predicate] = onAdd.mock.calls[0] as [Predicate, boolean]
        expect(predicate).toMatchObject({ kind: 'hasProperty', key: 'classification' })
    })

    it('offers the tag, the value and the name search for one token', async () => {
        const user = userEvent.setup()
        renderOmnibox()

        await user.type(screen.getByRole('combobox'), 'PII')

        await waitFor(() => expect(option('tag:PII')).not.toBeNull())
        expect(optionLabels()).toEqual(expect.arrayContaining([
            'tag:PII',                      // the tag
            'value:classification:PII',     // a sampled property value
            'text:name',                    // the always-available floor
        ]))
        expect(option('tag:PII')).toHaveTextContent('Tagged #PII')
    })

    it('adds the highlighted suggestion on Enter', async () => {
        const user = userEvent.setup()
        const { onAdd } = renderOmnibox()

        await user.type(screen.getByRole('combobox'), 'PII')
        await waitFor(() => expect(option('tag:PII')).not.toBeNull())
        await user.keyboard('{Enter}')

        expect(onAdd).toHaveBeenCalledTimes(1)
        const [predicate] = onAdd.mock.calls[0] as [Predicate, boolean]
        expect(predicate).toMatchObject({ kind: 'tag', values: ['PII'] })
    })

    it('clears the input after adding so filters chain', async () => {
        const user = userEvent.setup()
        renderOmnibox()

        const input = screen.getByRole('combobox')
        await user.type(input, 'PII')
        await user.keyboard('{Enter}')

        expect(input).toHaveValue('')
    })

    it('narrows to one facet when a browse tile is picked', async () => {
        const user = userEvent.setup()
        renderOmnibox()

        await user.click(screen.getByRole('button', { name: /^Tags$/ }))

        await waitFor(() => expect(option('tag:deprecated')).not.toBeNull())
        expect(option('type:dataset')).toBeNull()
    })

    it('unwinds the facet filter before the typed text on Escape', async () => {
        // Escape throwing away everything at once loses work the user
        // cannot get back.
        const user = userEvent.setup()
        renderOmnibox()

        await user.click(screen.getByRole('button', { name: /^Tags$/ }))
        const input = screen.getByRole('combobox')
        await user.type(input, 'dep')

        await user.keyboard('{Escape}')
        expect(input).toHaveValue('dep')

        await user.keyboard('{Escape}')
        expect(input).toHaveValue('')
    })

    it('flags a suggestion that still needs a value', async () => {
        const user = userEvent.setup()
        const { onAdd } = renderOmnibox()

        await user.click(screen.getByRole('button', { name: /^Name$/ }))
        await waitFor(() => expect(option('text:name')).not.toBeNull())
        await user.click(option('text:name')!)

        const [, complete] = onAdd.mock.calls[0] as [Predicate, boolean]
        expect(complete).toBe(false)
    })
})
