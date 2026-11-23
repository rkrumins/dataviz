/**
 * The top of Admin → Versioned graphs → Settings, against the settings API: a headline counted from
 * the values (how many of the settings are changed from the default), the server's reads posture
 * under it, a pill while changes are staged that opens the review, a chip for what this platform's
 * facts suggest that jumps to the first, the actions (a profile to start from, the finder), and for
 * a viewer who may only read, why not in place of what would change anything. Labels come from the
 * registry's generated catalogue and the fixtures the API answers with.
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { CATALOGUE, sameValue } from '@/components/settings'
import { usePersonaStore } from '@/store/persona'
import { AdminVersionedGraphs } from '..'
import { SCHEMA, platformValues } from '../__fixtures__/api'
import { mockApi, renderWithApi } from './helpers'

const S = Object.fromEntries(CATALOGUE.settings.map((s) => [s.key, s]))
const SETTINGS = '/admin/versioned-graphs?tab=settings'
const title = (key: string, id: string) => S[key].choices.find((c) => c.id === id)!.title
const hero = async () => {
    const heading = await screen.findByRole('heading', { level: 2, name: /settings (changed from the default|at their defaults)$/ })
    return within(heading.closest('section')!)
}

/** What the fixture's platform chose for itself that differs from the default. */
const changed = platformValues().values.filter((r) => {
    const own = r.trail.find((t) => t.scope === 'platform')?.value
    return own != null && !sameValue(own, r.trail[0].value)
}).length

afterEach(() => usePersonaStore.setState({ mode: 'technical' }))

describe('Settings: the hero', () => {
    it('counts the settings changed from the default, with the reads posture under it', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        const top = await hero()
        expect(changed).toBeGreaterThan(0)
        expect(top.getByRole('heading', { level: 2 })).toHaveTextContent(`${changed} of ${CATALOGUE.settings.length} settings changed from the default`)
        // The number is drawn on its own, large.
        expect(top.getByText(String(changed))).toHaveClass('bg-clip-text')
        expect(top.getByText('Settings · the platform')).toBeInTheDocument()
        expect(top.getByText(SCHEMA.categories.find((c) => c.id === 'reads')!.posture)).toBeInTheDocument()
        expect(top.getByRole('button', { name: 'Start from a profile…' })).toBeInTheDocument()
        expect(top.getByRole('combobox', { name: 'Search settings' })).toBeInTheDocument()
        expect(top.getByRole('switch', { name: 'Show changed settings only' })).toBeInTheDocument()
        expect(top.getByRole('button', { name: /What your settings trade/ })).toHaveAttribute('aria-expanded', 'false')
    })

    it('says, while changes are staged, how many aren’t saved, and opens the review from there', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        const top = await hero()
        expect(top.queryByRole('button', { name: /not saved/ })).not.toBeInTheDocument()
        await userEvent.click(within(await screen.findByRole('article', { name: S['reads.mode'].label }))
            .getByRole('radio', { name: title('reads.mode', 'in_place') }))
        const pill = top.getByRole('button', { name: '1 change not saved · Review' })
        await userEvent.click(pill)
        expect(await screen.findByRole('dialog', { name: 'Review 1 change to the platform' })).toBeInTheDocument()
    })

    it('offers a system admin what this platform’s facts suggest, and jumps to the first', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        const top = await hero()
        // Suggested, and not in force: in the fixture, the copy room, the largest copy and builds per worker.
        const suggested = SCHEMA.settings.filter((s) => {
            const ftp = s.guidance.recommended.forThisPlatform
            return ftp && !sameValue(ftp.value, platformValues().values.find((r) => r.key === s.key)!.effective)
        })
        expect(suggested.map((s) => s.key)).toEqual(['builds.copyRoomPct', 'builds.copyMaxBytes', 'builds.perWorker'])
        await userEvent.click(top.getByRole('button', { name: `${suggested.length} suggestions for your platform` }))
        expect(screen.getByTestId('where')).toHaveTextContent(/#builds-copyroompct$/)
        const row = screen.getByRole('article', { name: S['builds.copyRoomPct'].label })
        await waitFor(() => expect(document.activeElement).toBe(row))
        expect(within(row).getByText(/^Suggested for your platform:/)).toBeInTheDocument()
    })

    it('in the Business view too: the same counts, and the business settings’ questions to start from', async () => {
        usePersonaStore.setState({ mode: 'business' })
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        const top = await hero()
        expect(top.getByRole('heading', { level: 2 })).toHaveTextContent(`${changed} of ${CATALOGUE.settings.length} settings changed from the default`)
        expect(screen.getByRole('heading', { level: 2, name: 'What do you want to do?' })).toBeInTheDocument()
    })

    it('says to a viewer who may only read why there is nothing to change, in place of the actions', async () => {
        mockApi('readonly')
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        const top = await hero()
        expect(top.getByRole('note')).toHaveTextContent('You can read these settings and why each is what it is. Only a system admin can change them.')
        expect(top.queryByRole('button', { name: 'Start from a profile…' })).not.toBeInTheDocument()
        expect(top.queryByRole('button', { name: /suggestions? for your platform/ })).not.toBeInTheDocument()
        // Finding the settings behind a problem changes nothing: still offered.
        expect(top.getByRole('button', { name: 'Something’s wrong?' })).toBeInTheDocument()
    })
})
