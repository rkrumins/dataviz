/**
 * GraphSettingsSummary — on a data source's Versioning tab, the settings an owner looks at first,
 * against the settings API: each with the value in force exactly as served and where it was chosen
 * (this graph, this workspace, the platform…); one held back says what was chosen there and why;
 * how many values the graph sets itself, and the properties its imports match by. A fork says it
 * follows its root, with what its imports match by. "Open settings" opens the graph's settings
 * drawer from the data source. Each tile is headed by the setting's question in the Business view,
 * and its label in the Technical view. Loading, an error with a retry. Labels come from the
 * registry's generated catalogue.
 */
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CATALOGUE, STATUS_META } from '@/components/settings'
import { formatValue } from '@/components/settings/format'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { usePersonaStore } from '@/store/persona'
import { GRAPH, WS, graphValues } from '@/components/admin/AdminVersionedGraphs/__fixtures__/api'
import { calls, json, mockApi, renderWithApi } from '@/components/admin/AdminVersionedGraphs/__tests__/helpers'
import { GraphSettingsSummary } from '../GraphSettingsSummary'
import { SOURCE_WORDS, SUMMARY_KEYS } from '../../model/settingWords'

const S = Object.fromEntries(CATALOGUE.settings.map((s) => [s.key, s]))
const title = (key: string, id: string) => S[key].choices.find((c) => c.id === id)!.title
const SETTINGS = `/${WS}/versioning/graphs/${GRAPH}/settings`

const renderCard = () => renderWithApi(<GraphSettingsSummary wsId={WS} graphId={GRAPH} label="Sales lineage" />,
    { path: `/workspaces/${WS}?ds=ds_sales&dstab=versioning`, route: '/workspaces/:wsId' })
/** A setting's entry in the card: its name, and what is said of it. */
const item = (key: string) => within(screen.getByText(S[key].label, { selector: 'dt' }).parentElement!)

beforeEach(() => useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, versioningEnabled: true } } as never))
afterEach(() => useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } } as never))

describe('GraphSettingsSummary', () => {
    it('shows each setting’s value in force exactly as served, and where it was chosen', async () => {
        mockApi('workspace-admin')
        renderCard()
        await screen.findByText(S['reads.mode'].label, { selector: 'dt' })
        const served = Object.fromEntries(graphValues('workspace_admin').values.map((r) => [r.key, r]))
        for (const key of SUMMARY_KEYS) {
            expect(item(key).getByText(formatValue(S[key], served[key].effective))).toBeInTheDocument()
            expect(item(key).getByText(SOURCE_WORDS[served[key].source])).toBeInTheDocument()
            if (served[key].status !== 'in_effect') expect(item(key).getByText(STATUS_META[served[key].status].label)).toBeInTheDocument()
        }
        // Chosen for this graph, held back while New-version builds are off: in force, then what was chosen, where, and why.
        const reads = item('reads.mode')
        expect(reads.getByText(title('reads.mode', 'in_place'))).toBeInTheDocument()
        expect(reads.getByText(`Chosen: ${title('reads.mode', 'beside')}`).parentElement).toHaveTextContent('From This graph')
        expect(reads.getByText(CATALOGUE.why.builds_off!.text)).toBeInTheDocument()
        // The workspace's value reads as this workspace's; the platform's lock as the platform's.
        expect(item('drafts.levels').getByText('This workspace')).toBeInTheDocument()
        expect(item('imports.replaceGuard').getByText('The platform')).toBeInTheDocument()
        expect(item('residency.class').getByText(/Loaded only when needed/)).toBeInTheDocument()

        const own = graphValues('workspace_admin').values.filter((r) => r.trail.some((t) => t.scope === 'graph' && t.value !== null)).length
        expect(screen.getByText(`${own} values set for this graph`)).toBeInTheDocument()
        expect(item('imports.identifier').getByText(/Indexed for matching:/)).toHaveTextContent(
            'Indexed for matching: sku (up to date), legacy_code (indexing). 2 properties of 10 at most.')
    })

    it('heads each tile with the setting’s question in the Business view, and its label in the Technical view', async () => {
        usePersonaStore.setState({ mode: 'business' })
        mockApi('workspace-admin')
        renderCard()
        for (const key of SUMMARY_KEYS) expect(await screen.findByText(S[key].question!, { selector: 'dt' })).toBeInTheDocument()
        expect(screen.queryByText(S['reads.mode'].label, { selector: 'dt' })).not.toBeInTheDocument()
        // The values, where they came from and why one is held back, as in the Technical view.
        const reads = within(screen.getByText(S['reads.mode'].question!, { selector: 'dt' }).parentElement!)
        expect(reads.getByText(title('reads.mode', 'in_place'))).toBeInTheDocument()
        expect(reads.getByText(CATALOGUE.why.builds_off!.text)).toBeInTheDocument()

        act(() => usePersonaStore.getState().setMode('technical'))
        for (const key of SUMMARY_KEYS) expect(await screen.findByText(S[key].label, { selector: 'dt' })).toBeInTheDocument()
        expect(screen.queryByText(S['reads.mode'].question!, { selector: 'dt' })).not.toBeInTheDocument()
    })

    it('says when the graph sets nothing itself', async () => {
        const none = graphValues('workspace_admin')
        const values = none.values.map((r) => ({ ...r, trail: r.trail.map((t) => (t.scope === 'graph' ? { ...t, value: null } : t)) }))
        mockApi('workspace-admin', (req) => (req.method === 'GET' && req.path.endsWith(SETTINGS) ? json({ ...none, values }) : undefined))
        renderCard()
        expect(await screen.findByText('No value set for this graph')).toBeInTheDocument()
    })

    it('opens the graph’s settings drawer from the data source', async () => {
        mockApi('workspace-admin')
        renderCard()
        await screen.findByText(S['reads.mode'].label, { selector: 'dt' })
        await userEvent.click(screen.getByRole('button', { name: 'Open settings' }))
        const drawer = await screen.findByRole('dialog', { name: 'Sales lineage' })
        expect(await within(drawer).findByRole('article', { name: S['reads.mode'].label })).toBeInTheDocument()
    })

    it('says a fork has no settings of its own, and what its imports match by', async () => {
        const sent = mockApi('fork')
        renderCard()
        expect(await screen.findByText(/This graph is a fork, so it has no settings of its own/)).toBeInTheDocument()
        const ident = item('imports.identifier')
        expect(await ident.findByText('Entity ID')).toBeInTheDocument()
        expect(ident.getByText('This fork')).toBeInTheDocument()
        expect(ident.getByText('A fork can’t match by a property yet, so its imports match by Entity ID.')).toBeInTheDocument()
        expect(calls(sent, 'GET', SETTINGS)).toHaveLength(1)
    })

    it('says what failed, and reads the settings again on "Try again"', async () => {
        let fail = true
        mockApi('workspace-admin', (req) => (fail && req.method === 'GET' && req.path.endsWith(SETTINGS)
            ? json({ detail: 'The settings store couldn’t be read' }, 500) : undefined))
        renderCard()
        expect(await screen.findByText(/Couldn’t read this graph’s settings: The settings store couldn’t be read/, {}, { timeout: 4000 })).toBeInTheDocument()
        fail = false
        await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
        await waitFor(() => expect(screen.getByText(S['reads.mode'].label, { selector: 'dt' })).toBeInTheDocument())
    })

    it('shows the card’s shape while the settings load', async () => {
        mockApi('loading')
        renderCard()
        expect(await screen.findByLabelText('Loading this graph’s settings')).toBeInTheDocument()
    })
})
