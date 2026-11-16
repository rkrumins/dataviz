/**
 * A workspace's Versioned graphs tab, against the settings API: every state a person can meet
 * (loading, an error with a retry, read-only, a workspace admin, a system admin), the platform's
 * limits shown and enforced, what only the platform sets listed read-only, and the one save model at
 * workspace scope — stage, the server's quick answer, Review with a reason, Save, Undo. Then the
 * workspace's graphs, each with what it sets itself, its read mode and class (a fork follows its
 * root), opening its settings in the drawer; and its history, with a change put back through the
 * workspace. Leaving for another page with changes staged asks first. Labels come from the
 * registry's generated catalogue.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Link, RouterProvider, createMemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { NotificationStack } from '@/components/ui/notifications'
import { CATALOGUE, describeLimits } from '@/components/settings'
import { formatValue } from '@/components/settings/format'
import { REASON_HEADER } from '@/services/activityReason'
import { useAuthStore } from '@/store/auth'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { WorkspaceVersionedGraphs } from '../WorkspaceVersionedGraphs'
import { WORKSPACE_GRAPHS, WS, workspaceValues } from '../__fixtures__/api'
import { allowMenus, calls, json, mockApi, renderWithApi } from './helpers'

const S = Object.fromEntries(CATALOGUE.settings.map((s) => [s.key, s]))
const title = (key: string, id: string) => S[key].choices.find((c) => c.id === id)!.title
const PATH = `/workspaces/${WS}?tab=versioned-graphs`
const SETTINGS = `/${WS}/versioning/settings`
const reason = 'Nightly imports were slowing the finance canvases'
const row = (key: string) => within(screen.getByRole('article', { name: S[key].label }))
const rowOnceDrawn = async (key: string) => within(await screen.findByRole('article', { name: S[key].label }))

type Viewer = 'system_admin' | 'workspace_admin' | 'viewer'
function signIn(as: Viewer) {
    const permissions = as === 'system_admin' ? { sid: 't', global: ['system:admin'], ws: {} }
        : { sid: 't', global: [], ws: { [WS]: as === 'workspace_admin' ? ['workspace:admin', 'workspace:datasource:read'] : ['workspace:datasource:read'] } }
    useAuthStore.setState({ permissions, permissionsStatus: 'ready' } as never)
}

function renderTab(path = PATH) {
    return renderWithApi(<WorkspaceVersionedGraphs workspaceId={WS} workspaceName="Finance" />, { path, route: '/workspaces/:wsId' })
}

beforeAll(allowMenus)
beforeEach(() => {
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, versioningEnabled: true, residencyEnabled: true, candidateKeysEnabled: false } } as never)
    signIn('workspace_admin')
})
afterEach(() => useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } } as never))

describe('Workspace → Versioned graphs: what a person meets', () => {
    it('shows the settings’ shape while they load', async () => {
        mockApi('loading')
        renderTab()
        expect(await screen.findByLabelText('Loading the settings')).toBeInTheDocument()
    })

    it('says what failed and reads the workspace’s settings again on "Try again"', async () => {
        let fail = true
        mockApi('workspace-admin', (req) => (fail && req.method === 'GET' && req.path.endsWith(SETTINGS)
            ? json({ detail: 'The settings store couldn’t be read' }, 500) : undefined))
        renderTab()
        expect(await screen.findByText(/Couldn’t read this workspace’s settings: The settings store couldn’t be read/, {}, { timeout: 4000 })).toBeInTheDocument()
        fail = false
        await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
        expect(await screen.findByRole('article', { name: S['reads.mode'].label })).toBeInTheDocument()
    })

    it('reads, but offers nothing to change, to someone who may only read; no history', async () => {
        signIn('viewer')
        const sent = mockApi('readonly')
        renderTab()
        expect(await screen.findByText(/You can read this workspace’s settings and why each is what it is\. A workspace admin can change them\./)).toBeInTheDocument()
        expect(row('reads.mode').queryByRole('radio')).not.toBeInTheDocument()
        expect(row('reads.mode').getByText('Only a workspace admin can change it here.')).toBeInTheDocument()
        expect(screen.queryByText('Start from a profile.')).not.toBeInTheDocument()
        expect(screen.queryByRole('tab', { name: /History/ })).not.toBeInTheDocument()
        expect(calls(sent, 'GET', `${SETTINGS}/history`)).toHaveLength(0)
    })

    it('offers a workspace admin only what the platform allows, and shows its locks and limits', async () => {
        mockApi('workspace-admin')
        renderTab()
        const reads = await rowOnceDrawn('reads.mode')
        // The platform allows Always the latest and update in place; switch when ready is named, not offered.
        expect(reads.getByRole('radio', { name: title('reads.mode', 'latest') })).toBeInTheDocument()
        expect(reads.queryByRole('radio', { name: title('reads.mode', 'beside') })).not.toBeInTheDocument()
        expect(reads.getByText(`Not offered here: ${title('reads.mode', 'beside')}.`)).toBeInTheDocument()
        expect(reads.getByText(/Workspaces and graphs may choose:/)).toHaveTextContent(
            `Workspaces and graphs may choose: ${describeLimits(S['reads.mode'], { allowed: ['latest', 'in_place'] })}. Set by a system admin.`)
        // Locked by the platform, and a system admin's to set: read-only, saying why.
        expect(row('imports.replaceGuard').getByText('The platform locked this value.')).toBeInTheDocument()
        expect(row('residency.class').queryByRole('radio')).not.toBeInTheDocument()
        expect(row('residency.class').getByText('Only a system admin can change it here.')).toBeInTheDocument()
        expect(screen.getByText(/You choose within the limits a system admin set for the platform/)).toBeInTheDocument()
    })

    it('lists what only the platform sets, read-only with the value in force, and counts what the workspace sets', async () => {
        mockApi('workspace-admin')
        renderTab()
        await rowOnceDrawn('reads.mode')
        const updates = within(screen.getByRole('region', { name: CATALOGUE.categories.find((c) => c.id === 'updates')!.label }))
        const fixed = within(updates.getByRole('region', { name: 'Set for the whole platform' }))
        const target = workspaceValues().values.find((r) => r.key === 'updates.statementTargetMs')!
        expect(fixed.getByText(S['updates.statementTargetMs'].label)).toBeInTheDocument()
        expect(fixed.getByText(formatValue(S['updates.statementTargetMs'], target.effective))).toBeInTheDocument()
        expect(updates.queryByRole('article')).not.toBeInTheDocument()
        expect(updates.getByText('Only a system admin sets these, for the whole platform')).toBeInTheDocument()
        // Of the two read settings, the workspace sets both.
        const rail = screen.getByRole('navigation', { name: 'Setting categories' })
        expect(within(rail).getByRole('button', { name: /Reads & consistency/ })).toHaveTextContent('2 values set here')
        expect(within(rail).getByRole('button', { name: /Updates & loading/ })).toHaveTextContent('Platform-wide')
        // A switch is the platform's: shown, not flipped.
        expect(screen.getAllByText('Switch for this category').length).toBeGreaterThan(0)
        expect(screen.queryByRole('switch', { name: 'Graph residency' })).not.toBeInTheDocument()
    })

    it('lets a system admin set the class and go past the platform’s limits', async () => {
        signIn('system_admin')
        mockApi('ok')
        renderTab()
        const cls = await rowOnceDrawn('residency.class')
        expect(cls.getByRole('radio', { name: title('residency.class', 'always') })).toBeInTheDocument()
        expect(row('reads.mode').getByRole('radio', { name: title('reads.mode', 'beside') })).toBeInTheDocument()
        expect(screen.getByText(/As a system admin you can also choose values outside the platform’s limits here/)).toBeInTheDocument()
    })

    it('opens at a setting a link points to, and focuses it', async () => {
        mockApi('workspace-admin')
        renderTab(`${PATH}&vg=graphs#drafts-levels`)
        const target = await screen.findByRole('article', { name: S['drafts.levels'].label })
        await waitFor(() => expect(document.activeElement).toBe(target))
    })

    it('offers the profiles and the compass at workspace scope', async () => {
        mockApi('workspace-admin')
        renderTab()
        await rowOnceDrawn('reads.mode')
        expect(screen.getByText('Start from a profile.')).toBeInTheDocument()
        expect(screen.getByText('What your settings trade')).toBeInTheDocument()
    })
})

describe('Workspace → Versioned graphs: stage, review, save, undo', () => {
    it('stages a default, says what the server makes of it, saves it with a reason after Review, and undoes it', async () => {
        const sent = mockApi('workspace-admin')
        renderTab()
        await userEvent.click((await rowOnceDrawn('reads.mode')).getByRole('radio', { name: title('reads.mode', 'latest') }))

        expect(screen.getByRole('region', { name: 'Unsaved changes' })).toHaveTextContent('1 change not saved yet')
        expect(await row('reads.mode').findByText(`Once saved: ${title('reads.mode', 'latest')}`)).toBeInTheDocument()
        expect(calls(sent, 'POST', `${SETTINGS}/preview`).at(-1)?.query.get('mode')).toBe('quick')
        // Nothing is read over a staged value.
        expect(calls(sent, 'GET', SETTINGS)).toHaveLength(1)
        expect(screen.getByRole('tab', { name: /Defaults/ })).toHaveTextContent('1 not saved')

        await userEvent.click(within(screen.getByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Review changes' }))
        const dialog = await screen.findByRole('dialog', { name: 'Review 1 change to the Finance workspace' })
        await userEvent.type(within(dialog).getByLabelText(/Why are you making this change/), reason)
        await userEvent.click(within(dialog).getByRole('button', { name: 'Save change' }))

        await waitFor(() => expect(calls(sent, 'PATCH', SETTINGS)).toHaveLength(1))
        const save = calls(sent, 'PATCH', SETTINGS)[0]
        expect(save.body).toEqual({ changes: [{ key: 'reads.mode', value: 'latest', expectedVersion: 2 }], reason })
        expect(decodeURIComponent(save.headers.get(REASON_HEADER) ?? '')).toBe(reason)
        expect(calls(sent, 'POST', `${SETTINGS}/preview`).some((r) => r.query.get('mode') === 'full')).toBe(true)

        expect((await screen.findAllByText('Saved 1 change to the Finance workspace.')).length).toBeGreaterThan(0)
        await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
        await waitFor(() => expect(calls(sent, 'PATCH', SETTINGS)).toHaveLength(2))
        expect(calls(sent, 'PATCH', SETTINGS)[1].body).toEqual({
            changes: [{ key: 'reads.mode', value: 'in_place', expectedVersion: 3 }], reason: `Undo: ${reason}`,
        })
    })

    it('asks before another page drops what is staged, and stays when asked to', async () => {
        mockApi('workspace-admin')
        const router = createMemoryRouter([
            { path: '/workspaces/:wsId', element: <><WorkspaceVersionedGraphs workspaceId={WS} workspaceName="Finance" /><Link to="/elsewhere">Elsewhere</Link></> },
            { path: '/elsewhere', element: <p>Somewhere else</p> },
        ], { initialEntries: [PATH] })
        render(
            <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
                <RouterProvider router={router} />
                <NotificationStack />
            </QueryClientProvider>,
        )
        await userEvent.click((await rowOnceDrawn('reads.mode')).getByRole('radio', { name: title('reads.mode', 'latest') }))
        await userEvent.click(screen.getByRole('link', { name: 'Elsewhere' }))
        const dialog = await screen.findByRole('dialog', { name: 'Leave without saving 1 change?' })
        await userEvent.click(within(dialog).getByRole('button', { name: 'Stay' }))
        expect(screen.queryByText('Somewhere else')).not.toBeInTheDocument()
        expect(await row('reads.mode').findByText(`Once saved: ${title('reads.mode', 'latest')}`)).toBeInTheDocument()

        await userEvent.click(screen.getByRole('link', { name: 'Elsewhere' }))
        await userEvent.click(within(await screen.findByRole('dialog', { name: 'Leave without saving 1 change?' })).getByRole('button', { name: 'Discard and leave' }))
        expect(await screen.findByText('Somewhere else')).toBeInTheDocument()
    })

    it('puts a refusal of the platform’s limits on its row (422)', async () => {
        mockApi('workspace-admin', (req) => (req.method === 'PATCH' ? json({ detail: {
            type: 'invalid_settings', message: 'Some values can’t be saved',
            errors: [{ key: 'trash.restoreDays', code: 'outside_limits', message: 'Keep within 1 day to 90 days.' }],
        } }, 422) : undefined))
        renderTab()
        const trash = await rowOnceDrawn('trash.restoreDays')
        await userEvent.click(trash.getByRole('button', { name: /^Use recommended/ }))
        await userEvent.click(within(screen.getByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Review changes' }))
        const dialog = await screen.findByRole('dialog', { name: 'Review 1 change to the Finance workspace' })
        await userEvent.type(within(dialog).getByLabelText(/Why are you making this change/), reason)
        await userEvent.click(within(dialog).getByRole('button', { name: 'Save change' }))
        expect(await within(dialog).findByRole('alert')).toHaveTextContent(`Nothing was saved. ${S['trash.restoreDays'].label}: Keep within 1 day to 90 days.`)
        await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }))
        expect(row('trash.restoreDays').getByText('Keep within 1 day to 90 days.')).toBeInTheDocument()
    })
})

describe('Workspace → Versioned graphs: its graphs and its history', () => {
    it('lists each graph with what it sets itself, its read mode and class, and opens its settings in the drawer', async () => {
        mockApi('workspace-admin')
        renderTab(`${PATH}&vg=graphs`)
        const table = await screen.findByRole('table', { name: 'This workspace’s graphs' })
        const rowOf = (name: string) => within(within(table).getByText(name, { selector: 'span' }).closest('[role="row"]') as HTMLElement)

        const sales = rowOf('Sales lineage')
        const own = WORKSPACE_GRAPHS.find((g) => g.label === 'Sales lineage')!.ownSettings
        expect(sales.getByText(`${own.length} settings of its own`)).toBeInTheDocument()
        expect(sales.getByRole('list', { name: 'Set for Sales lineage' })).toHaveTextContent(S[own[0]].label)
        expect(sales.getByText(`+${own.length - 3} more settings`)).toBeInTheDocument()
        expect(sales.getByText(title('reads.mode', 'in_place'))).toBeInTheDocument()
        expect(sales.getByText(`Chosen: ${title('reads.mode', 'beside')}`)).toBeInTheDocument()
        expect(sales.getByText(CATALOGUE.why.builds_off!.text)).toBeInTheDocument()

        expect(rowOf('Orders').getByText('Nothing: it follows the workspace')).toBeInTheDocument()
        // Update in place, chosen for the workspace and in force: where it was chosen, beside it.
        expect(rowOf('Orders').getByText(title('reads.mode', 'in_place')).closest('[role="cell"]')).toHaveTextContent('From Workspace')
        const fork = rowOf('Sales lineage · Q4 what-if')
        expect(fork.getByText('Follows Sales lineage')).toBeInTheDocument()
        expect(fork.getByText('Nothing: a fork follows its root’s settings')).toBeInTheDocument()
        expect(screen.getByText(/4 graphs · 2 set values of their own/)).toBeInTheDocument()

        await userEvent.click(sales.getByRole('button', { name: 'Settings for Sales lineage' }))
        const drawer = await screen.findByRole('dialog', { name: 'Sales lineage' })
        expect(await within(drawer).findByRole('article', { name: S['reads.mode'].label })).toBeInTheDocument()
    })

    it('says so when the workspace has no versioned graph yet', async () => {
        mockApi('empty')
        renderTab(`${PATH}&vg=graphs`)
        expect(await screen.findByText('No versioned graphs here yet')).toBeInTheDocument()
    })

    it('lists the workspace’s changes and its graphs’, named, and puts one back through the workspace', async () => {
        const sent = mockApi('workspace-admin')
        renderTab(`${PATH}&vg=history`)
        expect(await screen.findByText('“Sales rows carry their SKU”')).toBeInTheDocument()
        expect(calls(sent, 'GET', `${SETTINGS}/history`)).toHaveLength(1)
        // Only the platform's history can be narrowed to a level.
        expect(screen.queryByRole('combobox', { name: 'Where' })).not.toBeInTheDocument()
        const graphChange = screen.getByText('“Sales rows carry their SKU”').closest('article')!
        expect(await within(graphChange).findByText('Sales lineage')).toBeInTheDocument()
        const wsChange = screen.getByText(`“${reason}”`).closest('article')!
        expect(within(wsChange).getByText('Finance')).toBeInTheDocument()

        await userEvent.click(within(wsChange).getByRole('button', { name: 'Put back…' }))
        const dialog = await screen.findByRole('dialog', { name: 'Review 1 change to the Finance workspace' })
        await userEvent.type(within(dialog).getByLabelText(/Why are you making this change/), 'Back to the latest for the audit')
        await userEvent.click(within(dialog).getByRole('button', { name: 'Save change' }))
        await waitFor(() => expect(calls(sent, 'POST', `${SETTINGS}/history/cs_w2/revert`)).toHaveLength(1))
    })
})
