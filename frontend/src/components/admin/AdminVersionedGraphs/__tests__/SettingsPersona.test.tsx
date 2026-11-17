/**
 * Admin → Versioned graphs in the app's Business view: each row asks its setting's question; the
 * header holds the app's own switch, which changes the persona everywhere and stays put across the
 * tabs; and nothing technical leaks in: no env var as a search result's reason, no glossary term's
 * technical note, and no id or node name in the review. A change of view made elsewhere is followed
 * live. Labels come from the registry's generated catalogue.
 */
import { act, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOGUE } from '@/components/settings'
import { usePersonaStore } from '@/store/persona'
import { AdminVersionedGraphs } from '..'
import { mockApi, renderWithApi } from './helpers'

vi.mock('@tanstack/react-virtual', async () => (await import('./helpers')).virtualizerMock())

const S = Object.fromEntries(CATALOGUE.settings.map((s) => [s.key, s]))
const title = (key: string, id: string) => S[key].choices.find((c) => c.id === id)!.title
/** A row's title in the Business view: its question, where it asks one. */
const asked = (key: string) => S[key].question || S[key].label
const SETTINGS = '/admin/versioned-graphs?tab=settings'
const view = () => screen.getByRole('radiogroup', { name: 'Business or Technical view' })
const reads = S['reads.mode']

beforeEach(() => usePersonaStore.setState({ mode: 'business' }))
afterEach(() => usePersonaStore.setState({ mode: 'technical' }))

describe('Settings in the Business view', () => {
    it('titles every row by its question, and follows a change of view made elsewhere', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        const row = await screen.findByRole('article', { name: reads.question })
        expect(within(row).getByText(reads.label)).toBeInTheDocument()
        const titles = () => [...document.querySelectorAll('article')].map((a) => document.getElementById(a.getAttribute('aria-labelledby')!)?.textContent)
        expect(titles().sort()).toEqual(CATALOGUE.settings.map((s) => asked(s.key)).sort())

        // The top bar, or ⌘/: the page follows at once.
        act(() => usePersonaStore.getState().toggleMode())
        expect(await screen.findByRole('article', { name: reads.label })).toBeInTheDocument()
        expect(titles().sort()).toEqual(CATALOGUE.settings.map((s) => s.label).sort())
    })

    it('changes the app’s view from the switch in the header, and shows the env vars in Technical', async () => {
        const user = userEvent.setup()
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        const row = within(await screen.findByRole('article', { name: reads.question }))
        expect(row.queryByText(reads.default.env!)).not.toBeInTheDocument()
        // One switch, in the section's header: not beside the search any more.
        expect(view().closest('header')).not.toBeNull()
        expect(screen.getAllByRole('radiogroup', { name: 'Business or Technical view' })).toHaveLength(1)

        await user.click(within(view()).getByRole('radio', { name: 'Technical' }))
        expect(usePersonaStore.getState().mode).toBe('technical')
        expect(within(await screen.findByRole('article', { name: reads.label })).getByText(reads.default.env!)).toBeInTheDocument()
    })

    it('keeps the view going from Settings to the Overview and back, the switch on every tab', async () => {
        const user = userEvent.setup()
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        await screen.findByRole('article', { name: reads.question })
        await user.click(within(view()).getByRole('radio', { name: 'Technical' }))

        await user.click(screen.getByRole('tab', { name: /Overview/ }))
        expect(await screen.findByText('Where things stand')).toBeInTheDocument()
        expect(within(view()).getByRole('radio', { name: 'Technical' })).toHaveAttribute('aria-checked', 'true')

        await user.click(screen.getByRole('tab', { name: /Settings/ }))
        expect(await screen.findByRole('article', { name: reads.label })).toBeInTheDocument()
        expect(screen.queryByRole('article', { name: reads.question })).not.toBeInTheDocument()
    })

    it('finds a setting by its env var or key, and says the question it asks rather than the env var', async () => {
        const user = userEvent.setup()
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        const box = await screen.findByRole('combobox', { name: 'Search settings' })
        const first = () => within(screen.getByRole('listbox', { name: 'Settings found' })).getAllByRole('option')[0]

        await user.type(box, reads.default.env!)
        expect(first()).toHaveTextContent(reads.label)
        expect(first()).toHaveTextContent(`Asks: ${reads.question}`)
        expect(screen.getByRole('listbox', { name: 'Settings found' })).not.toHaveTextContent('Env var')

        // By its key: the question it asks, or, while it asks none, what it is about.
        const pacing = S['updates.pacingRatio']
        await user.clear(box)
        await user.type(box, pacing.key)
        expect(first()).toHaveTextContent(pacing.label)
        expect(first()).toHaveTextContent(pacing.question ? `Asks: ${pacing.question}` : `About: ${pacing.guidance.summary}`)
        expect(first()).not.toHaveTextContent('Key:')
        expect(first().querySelector('.font-mono')).toBeNull()
    })

    it('defines a glossary term in plain words, and keeps its technical note for the Technical view', async () => {
        const user = userEvent.setup()
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        const row = within(await screen.findByRole('article', { name: reads.question }))
        await user.click(row.getByRole('button', { name: 'How it works' }))
        const store = CATALOGUE.glossary.find((t) => t.term === 'Graph store')!
        expect(store.technical).not.toBe('')
        // A tap, so it reads on a phone: the term is a button that opens its definition.
        const term = () => within(document.getElementById('reads-mode-guidance')!)
            .getAllByRole('button', { name: new RegExp(`^${store.term}$`, 'i') })[0]

        await user.click(term())
        const tip = screen.getByRole('dialog', { name: store.term })
        expect(tip).toHaveTextContent(store.definition)
        expect(within(tip).queryByText('Technical')).not.toBeInTheDocument()
        expect(tip).not.toHaveTextContent(store.technical)
        await user.keyboard('{Escape}')

        act(() => usePersonaStore.getState().setMode('technical'))
        await user.click(term())
        const technical = screen.getByRole('dialog', { name: store.term })
        expect(within(technical).getByText('Technical')).toBeInTheDocument()
        expect(technical).toHaveTextContent(store.technical)
    })

    it('reviews a change with names and sentences: each value outside the limits by where it was chosen, no id, no node by name', async () => {
        const user = userEvent.setup()
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        // A limit that leaves a workspace's and a graph's values outside it, and a memory mark.
        const row = within(await screen.findByRole('article', { name: reads.question }))
        await user.click(row.getByRole('button', { name: 'Change…' }))
        await user.click(row.getByRole('checkbox', { name: new RegExp(title('reads.mode', 'in_place')) }))
        const start = within(screen.getByRole('article', { name: asked('residency.unloadStartPct') }))
        fireEvent.keyDown(start.getAllByRole('slider')[0], { key: 'ArrowRight' })

        await user.click(within(screen.getByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Review changes' }))
        const dialog = await screen.findByRole('dialog', { name: 'Review 2 changes to the platform' })
        // Named as the server names them: a workspace by its name, a graph by its data source's.
        expect(await within(dialog).findByText('The Finance workspace')).toBeInTheDocument()
        expect(within(dialog).getByText('Sales lineage')).toBeInTheDocument()
        expect(dialog).toHaveTextContent('Fits on 0 of 3 nodes.')
        expect(dialog).toHaveTextContent('On 1 node.')
        expect(dialog.textContent).not.toMatch(/\b(ws|ds|graph)_\w+/)
        expect(dialog).not.toHaveTextContent(/Node \d|falkordb/)
        expect(dialog.querySelector('.font-mono')).toBeNull()

        // The Technical view: the same names with their ids, and each node.
        act(() => usePersonaStore.getState().setMode('technical'))
        expect(await within(dialog).findByText('(ws_finance)')).toBeInTheDocument()
        expect(dialog).toHaveTextContent('The Finance workspace (ws_finance)')
        expect(dialog).toHaveTextContent('Sales lineage (ds_sales)')
        expect(dialog).toHaveTextContent(/Node 1 has .+ free under its start mark/)
        expect(dialog).toHaveTextContent('falkordb-2:6379')
    })
})
