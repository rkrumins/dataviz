/**
 * Admin → Versioned graphs → Overview: where things stand, in a sentence built from the fleet's
 * figures and the read mode the server describes, then each category's posture; the figures, each
 * defined and dated, "—" with why (never 0) when they couldn't be read, and a way into the list;
 * "Something's wrong?"; and every graph. The opening and closing tests replace Infrastructure's
 * ProjectionPanel ones for this page (graphs loading and waiting for room are counted).
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { CATALOGUE } from '@/components/settings'
import { AdminVersionedGraphs } from '..'
import { SCHEMA, SUMMARY } from '../__fixtures__/api'
import { allowMenus, calls, json, mockApi, renderWithApi } from './helpers'

vi.mock('@tanstack/react-virtual', async () => (await import('./helpers')).virtualizerMock())

beforeAll(allowMenus)

const OVERVIEW = '/admin/versioned-graphs'
const tile = async (label: string) => within((await screen.findByText(label, { selector: 'p' })).closest('section')!)

describe('Overview', () => {
    it('says where things stand from the figures and the read mode in force, then each category’s posture', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: OVERVIEW })
        const reads = SCHEMA.categories.find((c) => c.id === 'reads')!
        expect(await screen.findByText((text) => text.startsWith('42 versioned graphs: 35 in memory, 4 unloaded, 1 loading, 2 waiting for room.')
            && text.endsWith(reads.posture))).toBeInTheDocument()
        expect(await screen.findByText('New-version builds is off; Graph residency is on.')).toBeInTheDocument()
        for (const c of SCHEMA.categories.filter((x) => x.id !== 'reads')) expect(screen.getByText(c.posture)).toBeInTheDocument()
    })

    it('shows each figure with what it counts and when it was read, counting graphs loading and waiting for room', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: OVERVIEW })
        await screen.findByText('The fleet now')
        expect((await tile('Versioned graphs')).getByText(String(SUMMARY.graphs))).toBeInTheDocument()
        expect((await tile('In memory')).getByRole('img')).toHaveAccessibleName('In memory: 35, Unloaded: 4, Loading: 1, Waiting for room: 2')
        expect((await tile('Failing')).getByText('1')).toBeInTheDocument()
        expect(screen.getAllByRole('button', { name: 'What this counts' })).toHaveLength(5)
        expect(screen.getByText(/^As of /)).toBeInTheDocument()
    })

    it('shows "—" and why when the figures couldn’t be read, never 0', async () => {
        mockApi('ok', (req) => (req.path.endsWith('/graphs/summary') ? json({ detail: 'The graph store didn’t answer in time' }, 503) : undefined))
        renderWithApi(<AdminVersionedGraphs />, { path: OVERVIEW })
        expect(await screen.findByText(/Couldn’t read the figures: The graph store didn’t answer in time/, {}, { timeout: 4000 })).toBeInTheDocument()
        expect(screen.getAllByLabelText('Not known')).toHaveLength(5)
        expect(screen.queryByText(/^0$/)).not.toBeInTheDocument()
    })

    it('opens the list on the graphs a figure counts', async () => {
        const sent = mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: OVERVIEW })
        await screen.findByText('The fleet now')
        await userEvent.click((await tile('Failing')).getByRole('button', { name: /Show them/ }))
        await waitFor(() => expect(calls(sent, 'GET', '/admin/versioning/graphs').at(-1)?.query.get('status')).toBe('failed'))
        await userEvent.click((await tile('In memory')).getByRole('button', { name: /2 waiting for room/ }))
        await waitFor(() => expect(calls(sent, 'GET', '/admin/versioning/graphs').at(-1)?.query.get('status')).toBe('waiting_capacity'))
    })

    it('opens a category’s settings from its posture, and a graph’s settings from the list', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: OVERVIEW })
        const imports = SCHEMA.categories.find((c) => c.id === 'imports')!
        await userEvent.click((await screen.findByText(imports.posture)).closest('button')!)
        expect(screen.getByTestId('where')).toHaveTextContent('?tab=settings')

        await userEvent.click(screen.getByRole('tab', { name: /Overview/ }))
        const sales = (await screen.findByText('Sales lineage')).closest('[role="row"]') as HTMLElement
        await userEvent.click(within(sales).getByRole('button', { name: 'Settings…' }))
        expect(await screen.findByRole('dialog', { name: 'Sales lineage' })).toBeInTheDocument()
    })

    it('stages a symptom’s recommended value on the platform and shows it in Settings', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: OVERVIEW })
        const finder = within((await screen.findByRole('heading', { name: 'Something’s wrong?' })).closest('section')!)
        // The platform keeps 250% free for a copy; the registry recommends less here.
        const symptom = CATALOGUE.settings.find((s) => s.key === 'builds.copyRoomPct')!.guidance.symptoms[0]
        await userEvent.type(finder.getByRole('textbox', { name: 'Describe the problem' }), symptom)
        await userEvent.click(finder.getByRole('button', { name: symptom }))
        await userEvent.click(finder.getAllByRole('button', { name: 'Use recommended' })[0])
        await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('?tab=settings#'))
        expect(await screen.findByRole('region', { name: 'Unsaved changes' })).toHaveTextContent('1 change not saved yet')
    })
})
