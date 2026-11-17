/**
 * "Set up with a guide", against the settings API, in the Business view: a goal shows what it would
 * stage and stages nothing until Next, then stages through the page (its save bar and its tab count
 * it) and a new goal unstages what the last one staged; a workspace admin is offered only what they
 * can stage, and sees memory read-only with who can change it; the review holds Save until there is
 * a reason and every warning is acknowledged, and saves once with them; the guide says it saved,
 * and its Undo puts it back; a version conflict names the other person's change to acknowledge.
 * Closing with choices staged asks to keep or discard them, and "Continue setup" picks up where it
 * was; Esc closes, Tab stays inside, focus goes back; no confetti for a person who asked for calm.
 * Labels come from the registry's generated catalogue.
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MotionConfig } from 'framer-motion'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CATALOGUE } from '@/components/settings'
import { useAuthStore } from '@/store/auth'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { usePersonaStore } from '@/store/persona'
import { AdminVersionedGraphs } from '..'
import { SETUP_STEPS } from '../setupSteps'
import { WorkspaceVersionedGraphs } from '../WorkspaceVersionedGraphs'
import { WS, platformValues } from '../__fixtures__/api'
import { allowMenus, calls, json, mockApi, renderWithApi, type Sent } from './helpers'

const S = Object.fromEntries(CATALOGUE.settings.map((s) => [s.key, s]))
const P = Object.fromEntries(CATALOGUE.profiles.map((p) => [p.id, p]))
const title = (key: string, id: string) => S[key].choices.find((c) => c.id === id)!.title
const label = (id: string) => CATALOGUE.categories.find((c) => c.id === id)!.label
const SETTINGS = '/admin/versioned-graphs?tab=settings'
const reason = 'Getting the platform ready for the sales team'
const saves = (sent: Sent[]) => calls(sent, 'PATCH', '/admin/versioning/settings')
const version = (key: string) => platformValues().values.find((r) => r.key === key)!.version

const wizard = () => within(screen.getByRole('dialog', { name: 'Guided setup' }))
const saveBar = () => screen.getByRole('region', { name: 'Unsaved changes' })
const question = (key: string) => within(wizard().getByRole('article', { name: S[key].question }))

async function openGuide(name = 'Set up with a guide') {
    await userEvent.click(await screen.findByRole('button', { name }))
    return within(await screen.findByRole('dialog', { name: 'Guided setup' }))
}

const LABELS = SETUP_STEPS.map((s) => s.label)
/** The chrome names the step at once ("Step 2 of 5: While data loads"). */
const onStep = (step: string) => Boolean(wizard().queryByText(`Step ${LABELS.indexOf(step) + 1} of ${LABELS.length}: ${step}`))
/** A step's own heading: its content follows the chrome once the last step's has left. */
const stepShown = (step: string) => wizard().findByRole('heading', {
    level: 3, name: step === LABELS[0] ? 'What matters most?' : step === 'Review' ? /^Review \d/ : step,
})
const next = () => userEvent.click(wizard().getByRole('button', { name: /^Next/ }))
/** Next, step by step, each step's content on screen before the next click. */
async function nextTo(step: string) {
    while (!onStep(step)) {
        await next()
        await stepShown(LABELS.find(onStep)!)
    }
    await stepShown(step)
}

beforeAll(allowMenus)
beforeEach(() => {
    usePersonaStore.setState({ mode: 'business' })
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, versioningEnabled: true, residencyEnabled: true, candidateKeysEnabled: false } } as never)
})
afterEach(() => {
    usePersonaStore.setState({ mode: 'technical' })
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } } as never)
})

describe('The guided setup: goals', () => {
    it('shows what a goal would stage when it is picked, sends nothing, and stages it through the page on Next', async () => {
        const sent = mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        const dialog = await openGuide()
        expect(dialog.getByRole('heading', { level: 3, name: 'What matters most?' })).toBeInTheDocument()
        // Every goal the platform can take, by its goal line.
        expect(dialog.getAllByRole('radio')).toHaveLength(CATALOGUE.profiles.length)

        await userEvent.click(dialog.getByRole('radio', { name: P['fastest-reads'].goal }))
        expect(dialog.getByRole('radio', { name: P['fastest-reads'].goal })).toHaveAttribute('aria-checked', 'true')
        // Its plan, value by value, and the compass's outline of what it trades.
        expect(dialog.getByText('Will be staged · 3')).toBeInTheDocument()
        expect(dialog.getByText(S['reads.mode'].label)).toBeInTheDocument()
        expect(dialog.getByRole('figure', { name: `What ${P['fastest-reads'].title} trades here` })).toBeInTheDocument()
        // Picking stages nothing and saves nothing.
        expect(saveBar()).toHaveClass('invisible')
        expect(saves(sent)).toHaveLength(0)

        await next()
        await stepShown('While data loads')
        // Staged on the page: its save bar and the Settings tab count it. Still nothing is sent.
        expect(saveBar()).toHaveTextContent('3 changes not saved yet')
        expect(screen.getByRole('tab', { name: /Settings/ })).toHaveTextContent('3 not saved')
        expect(question('reads.mode').getByRole('radio', { name: title('reads.mode', 'in_place') })).toHaveAttribute('aria-checked', 'true')
        expect(saves(sent)).toHaveLength(0)
    })

    it('unstages what the last goal staged when the goal changes', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        const dialog = await openGuide()
        await userEvent.click(dialog.getByRole('radio', { name: P['fastest-reads'].goal }))
        await next()
        expect(saveBar()).toHaveTextContent('3 changes not saved yet')

        await userEvent.click(wizard().getByRole('button', { name: 'Back' }))
        await userEvent.click(await wizard().findByRole('radio', { name: P.balanced.goal }))
        await next()
        await stepShown('While data loads')
        // The platform's own builds per worker and Standard unload time go back to the built-in
        // values; the read mode and the two write values the last goal staged are unstaged.
        expect(saveBar()).toHaveTextContent('2 changes not saved yet')
        expect(question('reads.mode').getByRole('radio', { name: /^Use the default/ })).toHaveAttribute('aria-checked', 'true')
        await nextTo('Review')
        const changes = wizard().getAllByRole('listitem').filter((li) => li.parentElement?.tagName === 'OL')
        expect(changes.map((li) => li.querySelector('p')?.textContent)).toEqual([S['builds.perWorker'].label, S['residency.standardIdleSecs'].label])
    })
})

describe('The guided setup: a workspace admin', () => {
    it('is offered only the goals it can stage, and sees memory read-only, with who can change it', async () => {
        useAuthStore.setState({ permissions: { sid: 't', global: [], ws: { [WS]: ['workspace:admin', 'workspace:datasource:read'] } }, permissionsStatus: 'ready' } as never)
        mockApi('workspace-admin')
        renderWithApi(<WorkspaceVersionedGraphs workspaceId={WS} workspaceName="Finance" />, { path: `/workspaces/${WS}?tab=versioned-graphs`, route: '/workspaces/:wsId' })
        const dialog = await openGuide()
        // Big import tonight is the platform's alone; Least memory sets nothing a workspace admin may.
        expect(dialog.getAllByRole('radio')).toHaveLength(4)
        expect(dialog.queryByRole('radio', { name: P['big-import-tonight'].goal })).not.toBeInTheDocument()
        const least = dialog.getByRole('radio', { name: P['least-memory'].goal })
        expect(least).toBeDisabled()
        expect(least).toHaveAccessibleDescription(/Only a system admin can set it here\.$/)

        await nextTo('Memory')
        const memory = question('residency.class')
        expect(memory.queryByRole('radio')).not.toBeInTheDocument()
        expect(memory.getByText('Only a system admin can change it here.')).toBeInTheDocument()
        // The category's switch is shown, never turned here.
        expect(wizard().getByText('Switch for this category')).toBeInTheDocument()
        expect(wizard().queryByRole('switch', { name: 'Graph residency' })).not.toBeInTheDocument()
    })
})

/** Shortens how long closed drafts keep their changes, which raises a warning to acknowledge. */
async function stageShorterRetention() {
    await nextTo('Drafts & imports')
    const days = question('drafts.keepClosedDays').getAllByRole('spinbutton')[0]
    await userEvent.clear(days)
    await userEvent.type(days, '7')
    await nextTo('Review')
}

describe('The guided setup: review and save', () => {
    it('holds Save until there is a reason and every warning is acknowledged, then saves once, with them', async () => {
        const sent = mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        await openGuide()
        await stageShorterRetention()
        const dialog = wizard()
        expect(dialog.getByRole('heading', { level: 3, name: 'Review 1 change to the platform' })).toBeInTheDocument()
        const save = dialog.getByRole('button', { name: 'Save change' })
        expect(save).toBeDisabled()
        const warning = await dialog.findByText(/^The next sweep removes the changes of 18 closed drafts/)
        await userEvent.type(dialog.getByLabelText(/Why are you making this change/), reason)
        expect(save).toBeDisabled()
        expect(dialog.getByText('Acknowledge the warning to save.')).toBeInTheDocument()
        await userEvent.click(within(warning.closest('label')!).getByRole('checkbox'))
        await waitFor(() => expect(save).toBeEnabled())
        await userEvent.click(save)

        await waitFor(() => expect(saves(sent)).toHaveLength(1))
        expect(saves(sent)[0].body).toEqual({
            changes: [{ key: 'drafts.keepClosedDays', value: 7, expectedVersion: version('drafts.keepClosedDays') }],
            reason, acknowledge: ['drafts_removed'],
        })
    })

    it('says it saved, itself rather than with the page’s toast, and its Undo puts it back', async () => {
        const sent = mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        await openGuide()
        await stageShorterRetention()
        const warning = await wizard().findByText(/^The next sweep removes the changes of 18 closed drafts/)
        await userEvent.click(within(warning.closest('label')!).getByRole('checkbox'))
        await userEvent.type(wizard().getByLabelText(/Why are you making this change/), reason)
        await userEvent.click(wizard().getByRole('button', { name: 'Save change' }))

        expect(await wizard().findByRole('heading', { name: 'Saved 1 change to the platform' })).toBeInTheDocument()
        expect(wizard().getByText('Changes saved').parentElement).toHaveTextContent('1')
        expect(wizard().getByText('Where').parentElement).toHaveTextContent('The platform')
        expect(screen.getByTestId('notification-stack')).not.toHaveTextContent('Saved 1 change')
        expect(wizard().getByRole('button', { name: 'Done' })).toHaveFocus()

        await userEvent.click(wizard().getByRole('button', { name: 'Undo' }))
        await waitFor(() => expect(saves(sent)).toHaveLength(2))
        expect(saves(sent)[1].body).toEqual({
            changes: [{ key: 'drafts.keepClosedDays', value: null, expectedVersion: version('drafts.keepClosedDays') + 1 }],
            reason: `Undo: ${reason}`,
        })
        expect(await wizard().findByRole('heading', { name: 'Put back as it was' })).toBeInTheDocument()
        await waitFor(() => expect(wizard().getByText('Undone: the earlier values are back.')).toBeInTheDocument())

        await userEvent.click(wizard().getByRole('button', { name: 'Done' }))
        expect(screen.queryByRole('dialog', { name: 'Guided setup' })).not.toBeInTheDocument()
    })

    it('after a version conflict, names the other person’s change, to acknowledge before saving over it (409)', async () => {
        let conflict = true
        const theirs = { id: 99, changeSetId: 'cs_9', at: new Date(Date.now() - 5 * 60_000).toISOString(), actor: { id: 'usr_grace', name: 'Grace Hopper' },
            reason: 'Reads must be fresh for the close', source: 'api', key: 'reads.mode', scope: 'platform', scopeId: '',
            from: { value: null, limits: null }, to: { value: 'latest', limits: null }, version: 4 }
        const sent = mockApi('ok', (req) => {
            if (req.method === 'PATCH' && conflict) {
                conflict = false
                return json({ detail: { type: 'settings_conflict', message: 'Changed since it was read',
                    conflicts: [{ key: 'reads.mode', scope: 'platform', scopeId: '', expected: 1, actual: 4 }] } }, 409)
            }
            if (req.method === 'GET' && req.path.endsWith('/admin/versioning/settings') && !conflict) {
                const now = platformValues()
                return json({ ...now, values: now.values.map((r) => (r.key === 'reads.mode' ? { ...r, version: 4 } : r)) })
            }
            if (req.path.endsWith('/settings/history') && !conflict) return json({ scope: 'platform', entries: [theirs], nextCursor: null })
            return undefined
        })
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        await openGuide()
        await nextTo('While data loads')
        await userEvent.click(question('reads.mode').getByRole('radio', { name: title('reads.mode', 'in_place') }))
        await nextTo('Review')
        await userEvent.type(wizard().getByLabelText(/Why are you making this change/), reason)
        const save = wizard().getByRole('button', { name: 'Save change' })
        await waitFor(() => expect(save).toBeEnabled())
        await userEvent.click(save)

        const warning = await wizard().findByText(`Grace Hopper changed ${S['reads.mode'].label} to ${title('reads.mode', 'latest')} (5 min ago), after you opened it. Saving puts yours in its place: ${title('reads.mode', 'in_place')}.`)
        expect(wizard().queryByRole('heading', { name: /^Saved/ })).not.toBeInTheDocument()
        await waitFor(() => expect(save).toBeDisabled())
        await userEvent.click(within(warning.closest('label')!).getByRole('checkbox'))
        await waitFor(() => expect(save).toBeEnabled())
        await userEvent.click(save)
        await waitFor(() => expect(saves(sent)).toHaveLength(2))
        expect((saves(sent)[1].body as { changes: unknown[] }).changes).toEqual([{ key: 'reads.mode', value: 'in_place', expectedVersion: 4 }])
        expect(await wizard().findByRole('heading', { name: 'Saved 1 change to the platform' })).toBeInTheDocument()
    })
})

describe('The guided setup: closing, keeping and coming back', () => {
    it('asks to keep or discard its choices, picks up where it was, and puts back what was staged before it', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        // Staged on the page before the guide opens.
        await userEvent.click(within(await screen.findByRole('article', { name: S['reads.mode'].question })).getByRole('radio', { name: title('reads.mode', 'beside') }))
        expect(saveBar()).toHaveTextContent('1 change not saved yet')

        const dialog = await openGuide()
        await userEvent.click(dialog.getByRole('radio', { name: P['fastest-reads'].goal }))
        await next()
        expect(saveBar()).toHaveTextContent('3 changes not saved yet')

        // Keep going: the guide stays where it was.
        await stepShown('While data loads')
        await userEvent.click(wizard().getByRole('button', { name: 'Cancel' }))
        let confirm = within(await screen.findByRole('dialog', { name: 'Keep your 3 choices staged?' }))
        await userEvent.click(confirm.getByRole('button', { name: 'Keep going' }))
        await waitFor(() => expect(screen.queryByRole('dialog', { name: /^Keep your/ })).not.toBeInTheDocument())
        expect(wizard().getByRole('heading', { level: 3, name: 'While data loads' })).toBeInTheDocument()

        // Keep them staged: the page keeps them, and the guide offers to continue where it was.
        await userEvent.click(wizard().getByRole('button', { name: 'Close' }))
        confirm = within(await screen.findByRole('dialog', { name: 'Keep your 3 choices staged?' }))
        await userEvent.click(confirm.getByRole('button', { name: 'Keep them staged' }))
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Guided setup' })).not.toBeInTheDocument())
        expect(saveBar()).toHaveTextContent('3 changes not saved yet')
        await openGuide('Continue setup')
        await stepShown('While data loads')

        // Discard them: each value goes back to what was staged for it before the guide.
        await userEvent.keyboard('{Escape}')
        confirm = within(await screen.findByRole('dialog', { name: 'Keep your 3 choices staged?' }))
        await userEvent.click(confirm.getByRole('button', { name: 'Discard them' }))
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Guided setup' })).not.toBeInTheDocument())
        expect(saveBar()).toHaveTextContent('1 change not saved yet')
        expect(within(screen.getByRole('article', { name: S['reads.mode'].question })).getByRole('radio', { name: title('reads.mode', 'beside') }))
            .toHaveAttribute('aria-checked', 'true')
        expect(screen.getByRole('button', { name: 'Set up with a guide' })).toBeInTheDocument()
    })

    it('leaves for the rest of a category with what it staged kept, to continue later', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        await openGuide()
        await nextTo('Drafts & imports')
        await userEvent.click(question('drafts.selfApproval').getByRole('switch'))
        const drafts = CATALOGUE.settings.filter((s) => s.category === 'drafts' && s.scopes.platform).length
        await userEvent.click(wizard().getByRole('button', { name: `${drafts - 3} more in ${label('drafts')}` }))
        expect(screen.queryByRole('dialog', { name: 'Guided setup' })).not.toBeInTheDocument()
        expect(screen.queryByRole('dialog', { name: /^Keep your/ })).not.toBeInTheDocument()
        expect(saveBar()).toHaveTextContent('1 change not saved yet')
        expect(screen.getByRole('button', { name: 'Continue setup' })).toBeInTheDocument()
    })

    it('closes on Esc with nothing staged, keeps Tab inside while open, and gives focus back', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        const start = await screen.findByRole('button', { name: 'Set up with a guide' })
        await userEvent.click(start)
        const dialog = await screen.findByRole('dialog', { name: 'Guided setup' })
        await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement))
        for (let i = 0; i < 24; i++) {
            await userEvent.tab()
            expect(dialog).toContainElement(document.activeElement as HTMLElement)
        }
        await userEvent.tab({ shift: true })
        expect(dialog).toContainElement(document.activeElement as HTMLElement)

        await userEvent.keyboard('{Escape}')
        expect(screen.queryByRole('dialog', { name: 'Guided setup' })).not.toBeInTheDocument()
        expect(screen.queryByRole('dialog', { name: /^Keep your/ })).not.toBeInTheDocument()
        expect(start).toHaveFocus()
    })
})

describe('The guided setup: motion', () => {
    async function saveFastestReads() {
        await openGuide()
        await userEvent.click(wizard().getByRole('radio', { name: P['fastest-reads'].goal }))
        await nextTo('Review')
        await userEvent.type(wizard().getByLabelText(/Why are you making this change/), reason)
        const save = wizard().getByRole('button', { name: 'Save 3 changes' })
        await waitFor(() => expect(save).toBeEnabled())
        await userEvent.click(save)
        return wizard().findByRole('heading', { name: 'Saved 3 changes to the platform' })
    }

    it('celebrates the save with confetti, and says how many graphs behave differently', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        await saveFastestReads()
        expect(document.querySelectorAll('.vw-confetti-piece').length).toBeGreaterThan(0)
        // From the full preview, as it was just before the save.
        expect(wizard().getByText('Graphs whose behaviour changes').parentElement).toHaveTextContent('7 of 42')
    })

    it('has no confetti for a person who asked for less motion', async () => {
        mockApi()
        renderWithApi(<MotionConfig reducedMotion="always"><AdminVersionedGraphs /></MotionConfig>, { path: SETTINGS })
        await saveFastestReads()
        expect(document.querySelectorAll('.vw-confetti-piece')).toHaveLength(0)
    })
})
