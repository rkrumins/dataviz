/**
 * A workspace's Versioned graphs tab, against the settings API: every state a person can meet
 * (loading, an error with a retry, read-only, a workspace admin, a system admin), the platform's
 * limits shown and enforced, what only the platform sets listed read-only, and the one save model at
 * workspace scope — stage, the server's quick answer, Review with a reason, Save, Undo. Then the
 * workspace's graphs, each with what it sets itself, its read mode and class (a fork follows its
 * root), opening its settings in the drawer; and its history, with a change put back through the
 * workspace. Leaving for another page with changes staged asks first. The app's Business /
 * Technical switch sits above the tabs. The guided setup works at workspace scope: a workspace
 * admin stages within the platform's limits and saves to the workspace; a system admin also sets
 * the class, and the review warns when a value goes past the limits. Labels come from the
 * registry's generated catalogue.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Link, RouterProvider, createMemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationStack } from '@/components/ui/notifications'
import { CATALOGUE, describeLimits } from '@/components/settings'
import { formatValue } from '@/components/settings/format'
import { REASON_HEADER } from '@/services/activityReason'
import { useAuthStore } from '@/store/auth'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { usePersonaStore } from '@/store/persona'
import { versionedGraphsFetch } from '@/harness/versionedGraphsFixtures'
import { SETUP_STEPS } from '../setupSteps'
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
        expect(screen.queryByRole('button', { name: 'Start from a profile…' })).not.toBeInTheDocument()
        expect(screen.queryByRole('tab', { name: /History/ })).not.toBeInTheDocument()
        expect(calls(sent, 'GET', `${SETTINGS}/history`)).toHaveLength(0)
    })

    it('offers a workspace admin only what the platform allows, and shows its locks and limits', async () => {
        mockApi('workspace-admin')
        renderTab()
        const reads = await rowOnceDrawn('reads.mode')
        // The platform allows `latest` and `in_place`; `beside` is named, not offered.
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
        const category = CATALOGUE.categories.find((c) => c.id === 'updates')!.label
        const updates = within(screen.getByRole('region', { name: category }))
        // Each category's list has a name of its own.
        const fixed = within(updates.getByRole('region', { name: `${category}: set for the whole platform` }))
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

    it('offers the profiles, the compass and the guide at workspace scope, under a headline of what the workspace sets', async () => {
        mockApi('workspace-admin')
        renderTab()
        await rowOnceDrawn('reads.mode')
        expect(screen.getByRole('button', { name: 'Start from a profile…' })).toBeInTheDocument()
        expect(screen.getByText('What your settings trade')).toBeInTheDocument()
        expect(screen.getByText('Defaults · Finance')).toBeInTheDocument()
        // Every value Finance chose for itself, among the settings a workspace has.
        const own = workspaceValues().values.filter((r) => S[r.key].scopes.workspace && r.trail.find((t) => t.scope === 'workspace')?.value != null)
        const headline = screen.getByRole('heading', { level: 2, name: `${own.length} values set for this workspace` })
        // The guide is the hero's, and the tab's intro is one line above it.
        expect(within(headline.closest('section')!).getByRole('link', { name: 'The settings guide' })).toHaveAttribute('href', '/guide/versioned-graph-settings')
        expect(screen.getAllByRole('link', { name: 'The settings guide' })).toHaveLength(1)
    })

    it('asks each setting’s question in the Business view, with the app’s switch above the tabs', async () => {
        usePersonaStore.setState({ mode: 'business' })
        mockApi('workspace-admin')
        renderTab()
        expect(await screen.findByRole('article', { name: S['reads.mode'].question })).toBeInTheDocument()
        const view = screen.getByRole('radiogroup', { name: 'Business or Technical view' })
        expect(view.closest('[role="tabpanel"]')).toBeNull()
        await userEvent.click(within(view).getByRole('radio', { name: 'Technical' }))
        expect(usePersonaStore.getState().mode).toBe('technical')
        expect(await screen.findByRole('article', { name: S['reads.mode'].label })).toBeInTheDocument()
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
        // The default is the recommended value: one way back to it.
        await userEvent.click(trash.getByRole('button', { name: /^Use the default · .+ \(recommended\)$/ }))
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
        // `in_place`, chosen for the workspace and in force: where it was chosen, beside it.
        expect(rowOf('Orders').getByText(title('reads.mode', 'in_place')).closest('[role="cell"]')).toHaveTextContent('From Workspace')
        const fork = rowOf('Sales lineage · Q4 what-if')
        expect(fork.getByText('Follows Sales lineage')).toBeInTheDocument()
        expect(fork.getByText('Nothing: a fork follows its root’s settings')).toBeInTheDocument()
        expect(screen.getByText(/4 graphs · 2 set values of their own/)).toBeInTheDocument()

        await userEvent.click(sales.getByRole('button', { name: 'Settings for Sales lineage' }))
        const drawer = await screen.findByRole('dialog', { name: 'Sales lineage' })
        expect(await within(drawer).findByRole('article', { name: S['reads.mode'].label })).toBeInTheDocument()
    })

    it('shows the rest of what a graph sets itself from "+N more", in its row, and fewer again', async () => {
        const user = userEvent.setup()
        mockApi('workspace-admin')
        renderTab(`${PATH}&vg=graphs`)
        const table = await screen.findByRole('table', { name: 'This workspace’s graphs' })
        const own = WORKSPACE_GRAPHS.find((g) => g.label === 'Sales lineage')!.ownSettings
        const list = within(within(table).getByRole('list', { name: 'Set for Sales lineage' }))
        const last = S[own.at(-1)!].label
        expect(list.queryByText(last)).not.toBeInTheDocument()

        const more = list.getByRole('button', { name: `+${own.length - 3} more settings` })
        expect(more).toHaveAttribute('aria-expanded', 'false')
        await user.click(more)
        for (const key of own) expect(list.getByText(S[key].label)).toBeInTheDocument()
        expect(more).toHaveAttribute('aria-expanded', 'true')
        expect(more).toHaveTextContent('Show fewer')

        await user.click(more)
        expect(list.queryByText(last)).not.toBeInTheDocument()
    })

    it('says so when the workspace has no versioned graph yet, and offers its data sources', async () => {
        mockApi('empty')
        const onOpenDataSources = vi.fn()
        renderWithApi(<WorkspaceVersionedGraphs workspaceId={WS} workspaceName="Finance" onOpenDataSources={onOpenDataSources} />,
            { path: `${PATH}&vg=graphs`, route: '/workspaces/:wsId' })
        expect(await screen.findByText('No versioned graphs here yet')).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: 'Open data sources' }))
        expect(onOpenDataSources).toHaveBeenCalledTimes(1)
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

        await userEvent.click(within(wsChange).getByRole('button', { name: /^Put back Grace Hopper’s change to / }))
        const dialog = await screen.findByRole('dialog', { name: 'Review 1 change to the Finance workspace' })
        await userEvent.type(within(dialog).getByLabelText(/Why are you making this change/), 'Back to the latest for the audit')
        await userEvent.click(within(dialog).getByRole('button', { name: 'Save change' }))
        await waitFor(() => expect(calls(sent, 'POST', `${SETTINGS}/history/cs_w2/revert`)).toHaveLength(1))
    })
})

describe('Workspace → Versioned graphs: the guided setup', () => {
    const P = Object.fromEntries(CATALOGUE.profiles.map((p) => [p.id, p]))
    const LABELS = SETUP_STEPS.map((s) => s.label)
    const wizard = () => within(screen.getByRole('dialog', { name: 'Guided setup' }))
    const question = (key: string) => within(wizard().getByRole('article', { name: S[key].question }))
    const onStep = (step: string) => Boolean(wizard().queryByText(`Step ${LABELS.indexOf(step) + 1} of ${LABELS.length}: ${step}`))
    // The step's content follows the chrome once the last step's has left.
    const stepShown = (step: string) => wizard().findByRole('heading', { level: 3, name: step === 'Review' ? /^Review \d/ : step })
    /** Next, step by step, each step's content on screen before the next click. */
    async function nextTo(step: string) {
        while (!onStep(step)) {
            await userEvent.click(wizard().getByRole('button', { name: /^Next/ }))
            await stepShown(LABELS.find(onStep)!)
        }
    }

    beforeEach(() => usePersonaStore.setState({ mode: 'business' }))
    afterEach(() => usePersonaStore.setState({ mode: 'technical' }))

    it('lets a workspace admin set the defaults up within the platform’s limits, and saves them to the workspace', async () => {
        const sent = mockApi('workspace-admin')
        renderTab()
        await userEvent.click(await screen.findByRole('button', { name: 'Set up with a guide' }))
        const dialog = within(await screen.findByRole('dialog', { name: 'Guided setup' }))
        expect(dialog.getByText('For the Finance workspace')).toBeInTheDocument()
        await userEvent.click(dialog.getByRole('radio', { name: P.balanced.goal }))
        // Of what Balanced sets, a workspace admin may set the read mode here: no limit on versions
        // behind is past the platform's range, and the rest is the platform's.
        expect(dialog.getByText('Will be staged · 1')).toBeInTheDocument()
        expect(dialog.getByText('Outside what the platform allows here:')).toBeInTheDocument()
        await nextTo('While data loads')
        expect(screen.getByRole('tab', { name: /Defaults/ })).toHaveTextContent('1 not saved')
        // `beside` is outside what the platform allows here: named, not offered.
        expect(question('reads.mode').queryByRole('radio', { name: title('reads.mode', 'beside') })).not.toBeInTheDocument()

        await nextTo('Review')
        expect(wizard().getByRole('heading', { level: 3, name: 'Review 1 change to the Finance workspace' })).toBeInTheDocument()
        await userEvent.type(wizard().getByLabelText(/Why are you making this change/), reason)
        const save = wizard().getByRole('button', { name: 'Save change' })
        await waitFor(() => expect(save).toBeEnabled())
        await userEvent.click(save)
        await waitFor(() => expect(calls(sent, 'PATCH', SETTINGS)).toHaveLength(1))
        expect(calls(sent, 'PATCH', SETTINGS)[0].body).toEqual({ changes: [{ key: 'reads.mode', value: 'latest', expectedVersion: 2 }], reason })
        expect(await wizard().findByRole('heading', { name: 'Saved 1 change to the Finance workspace' })).toBeInTheDocument()
    })

    it('lets a system admin set the class too, and warns in the review when a value goes past the platform’s limits', async () => {
        signIn('system_admin')
        // As the server answers a value chosen outside the limits: kept as an exception.
        const harness = versionedGraphsFetch('ok')
        const past = { code: 'outside_limits_exception', text: CATALOGUE.why.outside_limits_exception!.text, fix: null }
        const sent = mockApi('ok', (req) => {
            if (!(req.method === 'POST' && req.path.endsWith(`${SETTINGS}/preview`) && req.query.get('mode') === 'full')) return undefined
            return harness(`${req.path}?${req.query}`, { method: 'POST', body: JSON.stringify(req.body) })
                .then((res) => res.json())
                .then((body) => json({ ...body, values: body.values.map((v: { key: string; declared: unknown; why: unknown[] }) => (
                    v.key === 'reads.mode' && v.declared === 'beside' ? { ...v, why: [...v.why, past] } : v)) }))
        })
        renderTab()
        await userEvent.click(await screen.findByRole('button', { name: 'Set up with a guide' }))
        await screen.findByRole('dialog', { name: 'Guided setup' })
        expect(wizard().getByRole('radio', { name: P['least-memory'].goal })).toBeEnabled()
        await nextTo('While data loads')
        await userEvent.click(question('reads.mode').getByRole('radio', { name: title('reads.mode', 'beside') }))
        await nextTo('Memory')
        expect(question('residency.class').getByRole('radio', { name: title('residency.class', 'always') })).toBeInTheDocument()

        await nextTo('Review')
        const warning = await wizard().findByText(`${S['reads.mode'].label}: ${title('reads.mode', 'beside')}. ${CATALOGUE.why.outside_limits_exception!.text}`)
        await userEvent.type(wizard().getByLabelText(/Why are you making this change/), reason)
        const save = wizard().getByRole('button', { name: 'Save change' })
        expect(save).toBeDisabled()
        await userEvent.click(within(warning.closest('label')!).getByRole('checkbox'))
        await waitFor(() => expect(save).toBeEnabled())
        await userEvent.click(save)
        await waitFor(() => expect(calls(sent, 'PATCH', SETTINGS)).toHaveLength(1))
        expect((calls(sent, 'PATCH', SETTINGS)[0].body as { changes: unknown[] }).changes).toEqual([{ key: 'reads.mode', value: 'beside', expectedVersion: 2 }])
    })

    it('is not offered to someone who may only read', async () => {
        signIn('viewer')
        mockApi('readonly')
        renderTab()
        expect(await screen.findByText(/A workspace admin can change them\./)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Set up with a guide' })).not.toBeInTheDocument()
    })
})
