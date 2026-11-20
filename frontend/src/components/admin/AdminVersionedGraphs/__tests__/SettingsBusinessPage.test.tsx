/**
 * Admin → Versioned graphs → Settings in the Business view: nothing is hidden or folded away. All
 * seven categories and every setting's row are there, the business categories first and the rest
 * under "For your platform team", on the page and in the rail; "What do you want to do?" offers
 * business settings' own questions, chosen in the registry's order (the first of each business
 * category, then the next ones), each a link that takes the page to its setting, by mouse or
 * keyboard. The Technical view has neither. Labels come from the registry's generated catalogue.
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CATALOGUE } from '@/components/settings'
import { usePersonaStore } from '@/store/persona'
import { AdminVersionedGraphs } from '..'
import { mockApi, renderWithApi } from './helpers'

const SETTINGS = '/admin/versioned-graphs?tab=settings'
const TEAM = 'For your platform team: how writes, builds and database reads run'
const business = (id: string) => CATALOGUE.categories.find((c) => c.id === id)!.audience.includes('business')
const after = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

beforeEach(() => usePersonaStore.setState({ mode: 'business' }))
afterEach(() => usePersonaStore.setState({ mode: 'technical' }))

describe('Settings in the Business view: the whole page', () => {
    it('shows every category and every setting, the business ones first and the platform team’s under a divider', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        await screen.findByRole('article', { name: CATALOGUE.settings[0].question })
        expect(screen.getAllByRole('article')).toHaveLength(CATALOGUE.settings.length)
        for (const s of CATALOGUE.settings) expect(screen.getByRole('article', { name: s.question })).toBeInTheDocument()

        // On the page (the rail and a phone's category picker say it too).
        const divider = screen.getByText(TEAM, { selector: 'p' })
        expect(CATALOGUE.categories).toHaveLength(7)
        for (const c of CATALOGUE.categories) {
            const heading = screen.getByRole('heading', { level: 2, name: c.label })
            expect(after(heading, divider)).toBe(business(c.id))
        }

        // The rail: the same order, the same divider.
        const rail = within(screen.getByRole('navigation', { name: 'Setting categories' }))
        const railDivider = rail.getByText(TEAM)
        for (const c of CATALOGUE.categories) {
            expect(after(rail.getByRole('button', { name: (name) => name.includes(c.label) }), railDivider)).toBe(business(c.id))
        }
    })

    it('asks “What do you want to do?” with business settings’ own questions, the first of each business category first', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        const tasks = within((await screen.findByRole('heading', { level: 2, name: 'What do you want to do?' })).closest('section')!)
        const cards = tasks.getAllByRole('link')
        expect(cards.length).toBeGreaterThan(0)
        expect(cards.length).toBeLessThanOrEqual(6)
        const asked = CATALOGUE.settings.filter((s) => s.audience === 'business')
        const firsts = CATALOGUE.categories.filter((c) => c.audience.includes('business')).sort((a, b) => a.order - b.order)
            .map((c) => asked.find((s) => s.category === c.id)!)
        const expected = [...firsts, ...asked.filter((s) => !firsts.includes(s))].slice(0, 6)
        expect(cards.map((a) => a.textContent)).toEqual(expected.map((s) => `${s.question}${s.guidance.summary}`))
    })

    it('takes the page to a task card’s setting, by click and by keyboard', async () => {
        const user = userEvent.setup()
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        const tasks = within((await screen.findByRole('heading', { level: 2, name: 'What do you want to do?' })).closest('section')!)
        const residency = CATALOGUE.settings.find((s) => s.key === 'residency.class')!

        await user.click(tasks.getByRole('link', { name: new RegExp(`^${residency.question.replace('?', '\\?')}`) }))
        expect(screen.getByTestId('where')).toHaveTextContent(/#residency-class$/)
        const row = screen.getByRole('article', { name: residency.question })
        await waitFor(() => expect(document.activeElement).toBe(row))

        // The keyboard: a link like any other.
        const reads = CATALOGUE.settings.find((s) => s.key === 'reads.mode')!
        const card = tasks.getByRole('link', { name: new RegExp(`^${reads.question.replace('?', '\\?')}`) })
        card.focus()
        await user.keyboard('{Enter}')
        expect(screen.getByTestId('where')).toHaveTextContent(/#reads-mode$/)
        await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('article', { name: reads.question })))
    })

    it('in the Technical view, category order with neither the cards nor the divider', async () => {
        usePersonaStore.setState({ mode: 'technical' })
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        await screen.findByRole('article', { name: CATALOGUE.settings[0].label })
        expect(screen.queryByRole('heading', { name: 'What do you want to do?' })).not.toBeInTheDocument()
        expect(screen.queryByText(TEAM)).not.toBeInTheDocument()
        expect(screen.getAllByRole('article')).toHaveLength(CATALOGUE.settings.length)
    })
})
