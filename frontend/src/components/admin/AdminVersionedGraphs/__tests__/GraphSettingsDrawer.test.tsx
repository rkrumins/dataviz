/**
 * A graph's settings drawer: how the graph is doing now, each setting a graph can have with where
 * its value came from, only the choices allowed here, a setting only a system admin may change
 * shown read-only to a workspace admin (saying who may), a fork's settings followed from its root,
 * and the same save model as the platform's: stage, review, a reason, save, undo. Labels come from
 * the registry's generated catalogue.
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CATALOGUE } from '@/components/settings'
import { REASON_HEADER } from '@/services/activityReason'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { GraphSettingsDrawer } from '../GraphSettingsDrawer'
import { GRAPH, HEALTH, ROOT, WS } from '../__fixtures__/api'
import type { GraphHealth } from '@/services/settingsService'
import { calls, json, mockApi, renderWithApi } from './helpers'

const S = Object.fromEntries(CATALOGUE.settings.map((s) => [s.key, s]))
const title = (key: string, id: string) => S[key].choices.find((c) => c.id === id)!.title
const settingsPath = `/${WS}/versioning/graphs/${GRAPH}/settings`

function renderDrawer() {
    return renderWithApi(<GraphSettingsDrawer workspaceId={WS} graphId={GRAPH} open onOpenChange={() => {}} label="Sales lineage" />)
}
const row = async (key: string) => within(await screen.findByRole('article', { name: S[key].label }))

beforeEach(() => useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, versioningEnabled: true } } as never))
afterEach(() => useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } } as never))

describe('GraphSettingsDrawer', () => {
    it('shows a setting only a system admin may change read-only to a workspace admin, saying who may', async () => {
        mockApi('workspace-admin')
        renderDrawer()
        const cls = await row('residency.class')
        expect(cls.queryByRole('radio')).not.toBeInTheDocument()
        expect(cls.getByText('Only a system admin can change it here.')).toBeInTheDocument()
        // A workspace admin's own: the choices allowed here, with the trail down to this graph.
        const reads = await row('reads.mode')
        expect(reads.getByRole('radio', { name: title('reads.mode', 'latest') })).toBeInTheDocument()
        expect(reads.getByRole('list', { name: `Where ${S['reads.mode'].label} comes from` })).toHaveTextContent('Graph')
    })

    it('lists what a graph can’t set, read-only, with where and by whom it is set', async () => {
        mockApi('workspace-admin')
        renderDrawer()
        const elsewhere = (await screen.findByText(/^Set for every graph/)).closest('details')!
        expect(within(elsewhere).getByText(S['updates.statementTargetMs'].label)).toBeInTheDocument()
        expect(within(elsewhere).getAllByText('Set on the platform, by a system admin.').length).toBeGreaterThan(0)
    })

    it('says how the graph is doing, each part as the server reports it, and "—" with why for a part it couldn’t read', async () => {
        mockApi('workspace-admin')
        renderDrawer()
        const health = within((await screen.findByRole('heading', { name: 'Health now' })).closest('section')!)
        expect(health.getByText('1 version behind')).toBeInTheDocument()
        expect(health.getByText(/Version #213/)).toBeInTheDocument()
        // The version served is told by its own revision; the latest by its own.
        expect(health.getByText(/^#213 published/)).toHaveTextContent('by Alice Martin: “Q3 corrections”')
        expect(health.getByText(/^Latest: #214 published/)).toHaveTextContent('by Alice Martin: “Q4 import”')
        expect(health.getByText('Read from the graph store')).toBeInTheDocument()
        expect(health.getByText(title('reads.mode', 'in_place'))).toBeInTheDocument()
        expect(health.getByText('In memory')).toBeInTheDocument()
        expect(health.getByText('The build record couldn’t be read: it was being written at the time.')).toBeInTheDocument()
        const behind = CATALOGUE.signals?.find((d) => d.id === 'reads.from_database_while_behind')?.label
        const counted = health.getByText(behind ?? 'Reads: from database while behind').closest('li')!
        expect(counted).toHaveTextContent('12 times')
        // A description list of name and value groups, and nothing else.
        const list = health.getByText('Readers are').closest('dl')!
        for (const group of list.children) {
            expect(group.tagName).toBe('DIV')
            expect([...group.children].map((c) => c.tagName)).toEqual(['DT', 'DD'])
        }
    })

    const withHealth = (h: Partial<GraphHealth>) => mockApi('workspace-admin', (req) => (req.path.endsWith('/health') ? json({ ...HEALTH, ...h }) : undefined))
    const healthPanel = async () => within((await screen.findByRole('heading', { name: /^Health/ })).closest('section')!)
    const buildFact = async () => (await healthPanel()).getByText('Last new-version build').parentElement as HTMLElement
    const build = (b: Partial<NonNullable<GraphHealth['lastBuild']>>) => ({
        outcome: 'none', since: null, at: null, waitingFor: null, why: null, attempts: null, copyRemovedAfter: null, windowSecs: null, ...b,
    }) as NonNullable<GraphHealth['lastBuild']>

    it('says what is known of the last build, in the server’s terms', async () => {
        withHealth({ problems: [], lastBuild: build({ outcome: 'none', windowSecs: 900 }) })
        const { unmount } = renderDrawer()
        expect(await buildFact()).toHaveTextContent('None in flight, and none switched to in the last 15 minutes')
        unmount()
        withHealth({ problems: [], lastBuild: build({ outcome: 'waiting', waitingFor: 'lock', why: 'a capacity pass is under way; try again shortly', since: '2026-11-16T16:20:00Z' }) })
        const second = renderDrawer()
        expect(await buildFact()).toHaveTextContent('Waiting for another change to finish')
        expect(await buildFact()).not.toHaveTextContent('room')
        second.unmount()
        withHealth({ problems: [], lastBuild: build({ outcome: 'not_switched', at: '2026-11-16T16:00:00Z', copyRemovedAfter: '2026-11-16T16:00:00Z' }) })
        renderDrawer()
        const fact = await buildFact()
        expect(fact).toHaveTextContent('Not switched to')
        expect(fact).not.toHaveTextContent(/dropped|attempts/i)
        expect(fact).toHaveTextContent('Its copy due to be removed')
    })

    it('says a fork’s health is its root’s, naming the root', async () => {
        mockApi('fork')
        renderDrawer()
        const heading = await screen.findByRole('heading', { name: /^Health of Revenue lineage/ })
        expect(heading).toHaveTextContent('Health of Revenue lineage — this fork reads through it')
        const health = within(heading.closest('section')!)
        expect(health.getByText('Serving, through its root')).toBeInTheDocument()
        expect(health.getByText('Memory, its root’s copy')).toBeInTheDocument()
        // The inventory's words for its state: being loaded, not "Unloaded".
        expect(health.getByText('Loading')).toBeInTheDocument()
        expect(health.queryByText('Unloaded')).not.toBeInTheDocument()
        expect(health.getByText('Waiting for room for its copy')).toBeInTheDocument()
    })

    it('draws no health panel while the server can’t report one', async () => {
        mockApi('workspace-admin', (req) => (req.path.endsWith('/health') ? json({ detail: 'Not Found' }, 404) : undefined))
        renderDrawer()
        await row('reads.mode')
        expect(screen.queryByRole('heading', { name: 'Health now' })).not.toBeInTheDocument()
    })

    it('follows a fork to its root: it has no settings of its own', async () => {
        const sent = mockApi('fork')
        renderDrawer()
        expect(await screen.findByText('This graph is a fork, so it has no settings of its own.')).toBeInTheDocument()
        expect(screen.queryByRole('article')).not.toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: 'Open the root graph’s settings' }))
        expect(await screen.findByRole('article', { name: S['reads.mode'].label })).toBeInTheDocument()
        expect(calls(sent, 'GET', `/graphs/${ROOT}/settings`)).toHaveLength(1)
        expect(screen.getByRole('dialog', { name: 'The graph Sales lineage follows' })).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: /Back to Sales lineage/ }))
        expect(await screen.findByText('This graph is a fork, so it has no settings of its own.')).toBeInTheDocument()
    })

    it('stages a graph’s own value, saves it with a reason after Review, and undoes it', async () => {
        const sent = mockApi('workspace-admin')
        renderDrawer()
        await userEvent.click((await row('drafts.selfApproval')).getByRole('switch'))
        await userEvent.click(within(await screen.findByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Review changes' }))
        const dialog = await screen.findByRole('dialog', { name: 'Review 1 change to Sales lineage' })
        await userEvent.type(within(dialog).getByLabelText(/Why are you making this change/), 'Finance reviews its own drafts')
        // Save waits for what the change does.
        await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Save change' })).toBeEnabled())
        await userEvent.click(within(dialog).getByRole('button', { name: 'Save change' }))

        await waitFor(() => expect(calls(sent, 'PATCH', settingsPath)).toHaveLength(1))
        const save = calls(sent, 'PATCH', settingsPath)[0]
        expect(save.body).toEqual({ changes: [{ key: 'drafts.selfApproval', value: true, expectedVersion: 3 }], reason: 'Finance reviews its own drafts' })
        expect(decodeURIComponent(save.headers.get(REASON_HEADER) ?? '')).toBe('Finance reviews its own drafts')
        expect((await screen.findAllByText('Saved 1 change to Sales lineage.')).length).toBeGreaterThan(0)
        // The drawer holds the keyboard's focus: its own Undo, inside it, not only the app's toast's.
        await userEvent.click(within(screen.getByRole('dialog', { name: 'Sales lineage' })).getByRole('button', { name: 'Undo this save' }))
        await waitFor(() => expect(calls(sent, 'PATCH', settingsPath)).toHaveLength(2))
        // Back to inheriting: the graph had no value of its own.
        expect((calls(sent, 'PATCH', settingsPath)[1].body as { changes: unknown[] }).changes).toEqual([{ key: 'drafts.selfApproval', value: null, expectedVersion: 3 }])
    })

    // Ported from VersionedGraphsPanel's "sets a graph's class, and shows why Always cannot be had on a
    // full master": the class is now one of the graph's settings.
    it("sets a graph's class, and shows why Always cannot be had when the server refuses it", async () => {
        let refuse = true
        const sent = mockApi('ok', (req) => {
            if (req.method !== 'PATCH' || !refuse) return undefined
            refuse = false
            return json({ detail: { type: 'invalid_settings', message: 'Some values can’t be saved', errors: [{
                key: 'residency.class', code: 'capacity_insufficient',
                message: 'master 10.0.0.2:6379 has no room for this graph: it needs 3.0 GiB more under its start mark' }] } }, 422)
        })
        renderDrawer()
        await userEvent.click((await row('residency.class')).getByRole('radio', { name: title('residency.class', 'always') }))
        await userEvent.click(within(await screen.findByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Review changes' }))
        const dialog = await screen.findByRole('dialog', { name: 'Review 1 change to Sales lineage' })
        await userEvent.type(within(dialog).getByLabelText(/Why are you making this change/), 'Keep the sales graph loaded')
        await userEvent.click(within(dialog).getByRole('button', { name: 'Save change' }))
        expect(await within(dialog).findByRole('alert')).toHaveTextContent('has no room for this graph: it needs 3.0 GiB more under its start mark')
        expect(calls(sent, 'PATCH', settingsPath)[0].body).toMatchObject({ changes: [{ key: 'residency.class', value: 'always' }] })

        await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }))
        expect((await row('residency.class')).getByText(/has no room for this graph/)).toBeInTheDocument()
        await userEvent.click((await row('residency.class')).getByRole('radio', { name: title('residency.class', 'standard') }))
        await userEvent.click(within(screen.getByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Review changes' }))
        const again = await screen.findByRole('dialog', { name: 'Review 1 change to Sales lineage' })
        await userEvent.type(within(again).getByLabelText(/Why are you making this change/), 'Standard will do')
        await userEvent.click(within(again).getByRole('button', { name: 'Save change' }))
        expect((await screen.findAllByText('Saved 1 change to Sales lineage.')).length).toBeGreaterThan(0)
        expect(calls(sent, 'PATCH', settingsPath)[1].body).toMatchObject({ changes: [{ key: 'residency.class', value: 'standard' }] })
    })

    it('reads, but offers nothing to change, while version control is off', async () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, versioningEnabled: false } } as never)
        mockApi('workspace-admin')
        renderDrawer()
        expect(await screen.findByText(/Version control is turned off for this deployment/)).toBeInTheDocument()
        expect((await row('reads.mode')).queryByRole('radio')).not.toBeInTheDocument()
        expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument()
    })
})
