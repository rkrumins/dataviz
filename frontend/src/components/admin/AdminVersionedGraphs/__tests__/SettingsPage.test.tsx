/**
 * Admin → Versioned graphs → Settings, against the settings API: every state a person can meet
 * (loading, an error with a retry, nothing to show, read-only), every category with the posture the
 * server writes, and the one save model — stage, the server's quick answer, Review with the full
 * preview and a reason, Save, Undo — with each refusal where it belongs (a 422 or 403 on its row and
 * in the review; a 409 conflict read again with who changed what, to acknowledge before saving over
 * it, and "Reload and re-apply my changes" when it can't be; a 409 for a warning not acknowledged put
 * in the review). One confirmation per save. The platform's limits stage beside the values; a
 * category's switch asks first, as Admin → Features does. Around the rows: "Changed only" counts
 * each setting once, the finder takes and gives back focus and is the only place on Settings that
 * asks for the signals, and leaving with changes staged asks first. The room for a copy is drawn
 * from the platform's real figures, node memory and the largest graph, named, and not at all
 * without them. Labels come from the registry's generated catalogue.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Link, RouterProvider, createMemoryRouter } from 'react-router-dom'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { NotificationStack, useNotificationStore } from '@/components/ui/notifications'
import { CATALOGUE } from '@/components/settings'
import { REASON_HEADER } from '@/services/activityReason'
import { usePersonaStore } from '@/store/persona'
import { AdminVersionedGraphs } from '..'
import { SUMMARY, platformValues } from '../__fixtures__/api'
import { allowMenus, calls, json, mockApi, renderWithApi } from './helpers'

const S = Object.fromEntries(CATALOGUE.settings.map((s) => [s.key, s]))
const title = (key: string, id: string) => S[key].choices.find((c) => c.id === id)!.title
const SETTINGS = '/admin/versioned-graphs?tab=settings'
const row = (key: string) => within(screen.getByRole('article', { name: S[key].label }))
const rowOnceDrawn = async (key: string) => within(await screen.findByRole('article', { name: S[key].label }))
const reason = 'Large imports were slowing canvases for the sales team'

beforeAll(allowMenus)

async function stageReadMode(to = 'in_place') {
    await userEvent.click((await rowOnceDrawn('reads.mode')).getByRole('radio', { name: title('reads.mode', to) }))
}

async function reviewAndSave(words = reason) {
    await userEvent.click(within(screen.getByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Review changes' }))
    const dialog = await screen.findByRole('dialog', { name: /^Review \d+ changes? to the platform$/ })
    // Each value from → to, and what saving would do, before anything is saved.
    expect(within(dialog).getAllByRole('listitem').length).toBeGreaterThan(0)
    await userEvent.type(within(dialog).getByLabelText(/Why are you making this change/), words)
    // Save waits for what the change does.
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /^Save/ })).toBeEnabled())
    await userEvent.click(within(dialog).getByRole('button', { name: /^Save/ }))
    return dialog
}

describe('Settings: what a person meets', () => {
    it('shows the settings’ shape while they load', async () => {
        mockApi('loading')
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        expect(await screen.findByLabelText('Loading the settings')).toBeInTheDocument()
    })

    it('says what failed and reads the settings again on "Try again"', async () => {
        let fail = true
        mockApi('ok', (req) => (fail && req.method === 'GET' && req.path.endsWith('/admin/versioning/settings')
            ? json({ detail: 'The settings store couldn’t be read' }, 500) : undefined))
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        expect(await screen.findByText(/Couldn’t read the platform’s settings: The settings store couldn’t be read/, {}, { timeout: 4000 })).toBeInTheDocument()
        fail = false
        await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
        expect(await screen.findByRole('article', { name: S['reads.mode'].label })).toBeInTheDocument()
    })

    it('says so when the server lists no settings', async () => {
        mockApi('empty')
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        expect(await screen.findByText('No settings to show')).toBeInTheDocument()
    })

    it('reads, but does not offer to change, for a viewer who may only read', async () => {
        mockApi('readonly')
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        expect(await screen.findByText(/Only a system admin can change them/)).toBeInTheDocument()
        expect(row('reads.mode').queryByRole('radio')).not.toBeInTheDocument()
        expect(row('reads.mode').getByText('Only a system admin can change it here.')).toBeInTheDocument()
        expect(screen.queryByText('What workspaces and graphs may choose')).not.toBeInTheDocument()
        expect(await screen.findByRole('switch', { name: 'Graph residency' })).toBeDisabled()
    })

    it('opens every category with the posture the server writes, and counts what differs from the default', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        const rail = await screen.findByRole('navigation', { name: 'Setting categories' })
        for (const c of CATALOGUE.categories) {
            expect(within(rail).getByRole('button', { name: (name) => name.includes(c.label) })).toBeInTheDocument()
            expect(screen.getByRole('heading', { level: 2, name: c.label })).toBeInTheDocument()
        }
        // The fixture's platform chose five values of its own: two of them New-version builds'.
        expect(within(rail).getByRole('button', { name: /New-version builds/ })).toHaveTextContent('2 changed')
        expect(screen.getAllByText('Set by your deployment').length).toBeGreaterThan(0)
    })

    it('opens at a setting a link points to, and focuses it', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: '/admin/versioned-graphs#residency-unloadstartpct' })
        const target = await screen.findByRole('article', { name: S['residency.unloadStartPct'].label })
        await waitFor(() => expect(document.activeElement).toBe(target))
    })

    it('opens at a category a link points to, as Admin → Infrastructure links', async () => {
        mockApi()
        const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
        renderWithApi(<AdminVersionedGraphs />, { path: `${SETTINGS}#category-builds` })
        const builds = CATALOGUE.categories.find((c) => c.id === 'builds')!
        const section = (await screen.findByRole('heading', { level: 2, name: builds.label })).closest('section')
        await waitFor(() => expect(scroll.mock.contexts).toContain(section))
        scroll.mockRestore()
    })

    it('shows only the changed settings when asked', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        await screen.findByRole('article', { name: S['reads.mode'].label })
        await userEvent.click(screen.getByRole('switch', { name: 'Show changed settings only' }))
        expect(screen.queryByRole('article', { name: S['reads.mode'].label })).not.toBeInTheDocument()
        expect(screen.getByRole('article', { name: S['imports.guardMinLive'].label })).toBeInTheDocument()
    })
})

describe('Settings: stage, review, save, undo', () => {
    it('stages a value, says what the server makes of it, saves it with a reason after Review, and undoes it', async () => {
        const sent = mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        await stageReadMode('beside')

        expect(screen.getByRole('region', { name: 'Unsaved changes' })).toHaveTextContent('1 change not saved yet')
        // The row's head is the server's answer, once the edits pause: switch when ready is held to update in place
        // while builds are off, and the row says what was chosen and offers the fix.
        expect(await row('reads.mode').findByText(`Once saved: ${title('reads.mode', 'in_place')}`)).toBeInTheDocument()
        expect(row('reads.mode').getByText(`Chosen: ${title('reads.mode', 'beside')}`)).toBeInTheDocument()
        expect(row('reads.mode').queryByText(/^Changing to/)).not.toBeInTheDocument()
        expect(row('reads.mode').getByText('Adjusted once saved:')).toBeInTheDocument()
        expect(row('reads.mode').getAllByRole('button', { name: 'Turn on New-version builds' }).length).toBeGreaterThan(0)
        expect(calls(sent, 'POST', '/settings/preview').at(-1)?.query.get('mode')).toBe('quick')
        expect(calls(sent, 'PATCH', '/admin/versioning/settings')).toHaveLength(0)

        await reviewAndSave()
        await waitFor(() => expect(calls(sent, 'PATCH', '/admin/versioning/settings')).toHaveLength(1))
        const save = calls(sent, 'PATCH', '/admin/versioning/settings')[0]
        expect(save.body).toEqual({ changes: [{ key: 'reads.mode', value: 'beside', expectedVersion: 1 }], reason })
        expect(decodeURIComponent(save.headers.get(REASON_HEADER) ?? '')).toBe(reason)
        expect(calls(sent, 'POST', '/settings/preview').some((r) => r.query.get('mode') === 'full')).toBe(true)

        expect((await screen.findAllByText('Saved 1 change to the platform.')).length).toBeGreaterThan(0)
        expect(screen.queryByRole('dialog', { name: /^Review/ })).not.toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
        await waitFor(() => expect(calls(sent, 'PATCH', '/admin/versioning/settings')).toHaveLength(2))
        expect(calls(sent, 'PATCH', '/admin/versioning/settings')[1].body).toEqual({
            changes: [{ key: 'reads.mode', value: null, expectedVersion: 2 }], reason: `Undo: ${reason}`,
        })
    })

    it('holds Save until what the change does is worked out, and when it can’t be, offers to try again or to save without it', async () => {
        let full: 'never' | 'fail' | 'answer' = 'never'
        const sent = mockApi('ok', (req) => {
            if (req.query.get('mode') !== 'full') return undefined
            if (full === 'never') return new Promise<Response>(() => {})
            return full === 'fail' ? json({ detail: 'The graph store didn’t answer in time' }, 503) : undefined
        })
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        await stageReadMode('beside')
        await userEvent.click(within(screen.getByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Review changes' }))
        let dialog = await screen.findByRole('dialog', { name: 'Review 1 change to the platform' })
        await userEvent.type(within(dialog).getByLabelText(/Why are you making this change/), reason)
        expect(within(dialog).getByRole('button', { name: 'Save change' })).toBeDisabled()
        expect(dialog).toHaveTextContent('Save waits for what this changes.')
        await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }))

        // Another value: the answer still on its way above belongs to the last one.
        full = 'fail'
        await stageReadMode('in_place')
        await userEvent.click(within(screen.getByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Review changes' }))
        dialog = await screen.findByRole('dialog', { name: 'Review 1 change to the platform' })
        await userEvent.type(within(dialog).getByLabelText(/Why are you making this change/), reason)
        expect(await within(dialog).findByText(/Couldn’t work out what this changes: The graph store didn’t answer in time/)).toBeInTheDocument()
        const save = within(dialog).getByRole('button', { name: 'Save change' })
        expect(save).toBeDisabled()
        await userEvent.click(within(dialog).getByRole('checkbox', { name: /Save without seeing what this changes/ }))
        expect(save).toBeEnabled()

        // Trying again: answered this time, so nothing is saved blind.
        full = 'answer'
        await userEvent.click(within(dialog).getByRole('button', { name: 'Try again' }))
        await waitFor(() => expect(within(dialog).queryByRole('checkbox', { name: /Save without seeing/ })).not.toBeInTheDocument())
        await waitFor(() => expect(save).toBeEnabled())
        await userEvent.click(save)
        await waitFor(() => expect(calls(sent, 'PATCH', '/admin/versioning/settings')).toHaveLength(1))
    })

    it('stages what workspaces may choose beside the value, and asks to acknowledge the values left outside', async () => {
        const sent = mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        const limits = within((await screen.findAllByText('What workspaces and graphs may choose'))[0].closest('section')!)
        // Only the platform's own choice, `latest`, stays: the workspace and the graph that chose `beside` are outside.
        await userEvent.click(limits.getByRole('checkbox', { name: new RegExp(title('reads.mode', 'in_place')) }))

        await userEvent.click(within(screen.getByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Review changes' }))
        const dialog = await screen.findByRole('dialog', { name: 'Review 1 change to the platform' })
        expect(within(dialog).getByText(`${S['reads.mode'].label}: what workspaces and graphs may choose`)).toBeInTheDocument()
        const warning = await within(dialog).findByText('1 workspace and 1 graph are outside these limits. They keep their values, marked as exceptions.')
        await userEvent.type(within(dialog).getByLabelText(/Why are you making this change/), reason)
        const saveButton = within(dialog).getByRole('button', { name: 'Save change' })
        expect(saveButton).toBeDisabled()
        await userEvent.click(within(warning.closest('label')!).getByRole('checkbox'))
        await userEvent.click(saveButton)

        await waitFor(() => expect(calls(sent, 'PATCH', '/admin/versioning/settings')).toHaveLength(1))
        expect(calls(sent, 'PATCH', '/admin/versioning/settings')[0].body).toEqual({
            changes: [{ key: 'reads.mode', limits: { allowed: ['latest'] }, expectedVersion: 1 }], reason,
        })
    })

    it('puts a refused value’s reason on its row and in the review (422)', async () => {
        const refused = `${title('reads.mode', 'beside')} isn’t offered on this platform.`
        mockApi('ok', (req) => (req.method === 'PATCH' ? json({ detail: {
            type: 'invalid_settings', message: 'Some values can’t be saved',
            errors: [{ key: 'reads.mode', code: 'not_allowed', message: refused }],
        } }, 422) : undefined))
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        await stageReadMode('beside')
        const dialog = await reviewAndSave()
        expect(await within(dialog).findByRole('alert')).toHaveTextContent(`Nothing was saved. ${S['reads.mode'].label}: ${refused}`)
        await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }))
        expect(row('reads.mode').getByText(refused)).toBeInTheDocument()
        expect(screen.getByRole('region', { name: 'Unsaved changes' })).toHaveTextContent('1 to fix')
    })

    it('says who may change a value the server won’t take from this viewer (403)', async () => {
        mockApi('ok', (req) => (req.method === 'PATCH' ? json({ detail: {
            type: 'setting_not_permitted', message: 'Not yours to set',
            denied: [{ key: 'reads.mode', code: 'editor', message: '', editor: 'system_admin' }],
        } }, 403) : undefined))
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        await stageReadMode()
        const dialog = await reviewAndSave()
        expect(await within(dialog).findByRole('alert')).toHaveTextContent(`You can’t change ${S['reads.mode'].label} here: only a system admin can.`)
    })

    it('after a version conflict, says who changed what and when, and saves over it only once that is acknowledged (409)', async () => {
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
            // Someone else saved meanwhile: read again, the read mode is at version 4, and the history says who.
            if (req.method === 'GET' && req.path.endsWith('/admin/versioning/settings') && !conflict) {
                const now = platformValues()
                return json({ ...now, values: now.values.map((r) => (r.key === 'reads.mode' ? { ...r, version: 4 } : r)) })
            }
            if (req.path.endsWith('/settings/history') && !conflict) return json({ scope: 'platform', entries: [theirs], nextCursor: null })
            return undefined
        })
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        await stageReadMode()
        const dialog = await reviewAndSave()
        // Read again at once, with who changed it: their change is named, to acknowledge before saving over it.
        const warning = await within(dialog).findByText(`Grace Hopper changed ${S['reads.mode'].label} to ${title('reads.mode', 'latest')} (5 min ago), after you opened it. Saving puts yours in its place: ${title('reads.mode', 'in_place')}.`)
        expect(calls(sent, 'GET', '/settings/history').at(-1)!.query.get('key')).toBe('reads.mode')
        expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument()
        const save = within(dialog).getByRole('button', { name: 'Save change' })
        await waitFor(() => expect(save).toBeDisabled())
        await userEvent.click(within(warning.closest('label')!).getByRole('checkbox'))
        await waitFor(() => expect(save).toBeEnabled())
        await userEvent.click(save)
        await waitFor(() => expect(calls(sent, 'PATCH', '/admin/versioning/settings')).toHaveLength(2))
        expect((calls(sent, 'PATCH', '/admin/versioning/settings')[1].body as { changes: unknown[] }).changes)
            .toEqual([{ key: 'reads.mode', value: 'in_place', expectedVersion: 4 }])
    })

    it('offers "Reload and re-apply my changes" when the values couldn’t be read again after a conflict', async () => {
        let reads = 0
        mockApi('ok', (req) => {
            if (req.method === 'PATCH') return json({ detail: { type: 'settings_conflict', message: 'Changed since it was read',
                conflicts: [{ key: 'reads.mode', scope: 'platform', scopeId: '', expected: 1, actual: 4 }] } }, 409)
            if (req.method === 'GET' && req.path.endsWith('/admin/versioning/settings') && ++reads > 1) return json({ detail: 'The settings store couldn’t be read' }, 500)
            return undefined
        })
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        await stageReadMode()
        const dialog = await reviewAndSave()
        expect(await within(dialog).findByRole('alert')).toHaveTextContent(`Someone changed ${S['reads.mode'].label} since you opened it.`)
        expect(within(dialog).getByRole('button', { name: 'Reload and re-apply my changes' })).toBeInTheDocument()
        // The page behind keeps the values it read, and the change stays staged.
        expect(screen.getByText('1 change not saved yet')).toBeInTheDocument()
    })

    it('sends the warnings acknowledged in the review with the save', async () => {
        const sent = mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        const keep = await rowOnceDrawn('drafts.keepClosedDays')
        const days = keep.getAllByRole('spinbutton')[0]
        await userEvent.clear(days)
        await userEvent.type(days, '7')
        await userEvent.click(within(await screen.findByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Review changes' }))
        const dialog = await screen.findByRole('dialog', { name: 'Review 1 change to the platform' })
        const warning = await within(dialog).findByText(/^The next sweep removes the changes of 18 closed drafts/)
        await userEvent.type(within(dialog).getByLabelText(/Why are you making this change/), reason)
        await userEvent.click(within(warning.closest('label')!).getByRole('checkbox'))
        await userEvent.click(within(dialog).getByRole('button', { name: 'Save change' }))
        await waitFor(() => expect(calls(sent, 'PATCH', '/admin/versioning/settings')).toHaveLength(1))
        expect(calls(sent, 'PATCH', '/admin/versioning/settings')[0].body).toEqual({
            changes: [{ key: 'drafts.keepClosedDays', value: 7, expectedVersion: platformValues().values.find((r) => r.key === 'drafts.keepClosedDays')!.version }],
            reason, acknowledge: ['drafts_removed'],
        })
    })

    it('puts a warning the server refused the save for in the review, to acknowledge and save again', async () => {
        const risk = { code: 'risky_change', key: 'reads.mode', text: 'Readers may see a version that is still being written.' }
        let refuse = true
        const sent = mockApi('ok', (req) => {
            if (req.method !== 'PATCH' || !refuse) return undefined
            refuse = false
            return json({ detail: { type: 'acknowledgement_required', message: `Acknowledge what this change does before saving it: ${risk.text}`, warnings: [risk] } }, 409)
        })
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        await stageReadMode()
        const dialog = await reviewAndSave()
        expect(await within(dialog).findByRole('alert')).toHaveTextContent('Nothing was saved: this change does something you need to acknowledge first.')
        const warning = await within(dialog).findByText(risk.text)
        const save = within(dialog).getByRole('button', { name: 'Save change' })
        expect(save).toBeDisabled()
        await userEvent.click(within(warning.closest('label')!).getByRole('checkbox'))
        await userEvent.click(save)
        await waitFor(() => expect(calls(sent, 'PATCH', '/admin/versioning/settings')).toHaveLength(2))
        expect(calls(sent, 'PATCH', '/admin/versioning/settings')[1].body).toMatchObject({ acknowledge: ['risky_change'] })
    })

    it('confirms a save once, with one Undo: the toast', async () => {
        useNotificationStore.setState({ notifications: [] })
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        await stageReadMode()
        await reviewAndSave()
        // The words are read out once (a live region) and shown once: the toast, with the one Undo.
        const shown = (await screen.findAllByText('Saved 1 change to the platform.')).filter((el) => !el.classList.contains('sr-only'))
        expect(shown).toHaveLength(1)
        expect(screen.getByTestId('notification-stack')).toContainElement(shown[0])
        expect(screen.getAllByRole('button', { name: /^Undo/ })).toHaveLength(1)
    })
})

describe('Settings: around the rows', () => {
    it('counts each setting once under "Changed only", changed and staged alike', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        await rowOnceDrawn('reads.mode')
        const count = () => Number(/\((\d+)\)/.exec(screen.getByText('Changed only').closest('label')!.textContent ?? '')![1])
        const before = count()
        // Already changed on the platform: staging it again changes nothing in the count.
        fireEvent.keyDown(row('updates.readPressureRatio').getByRole('slider', { name: S['updates.readPressureRatio'].label }), { key: 'ArrowRight' })
        expect(screen.getByRole('region', { name: 'Unsaved changes' })).toHaveTextContent('1 change not saved yet')
        expect(count()).toBe(before)
        await stageReadMode()
        expect(count()).toBe(before + 1)
        await userEvent.click(screen.getByRole('switch', { name: 'Show changed settings only' }))
        expect(screen.getAllByRole('article')).toHaveLength(before + 1)
    })

    it('moves focus into "Something’s wrong?" when it opens, and back to its button when it closes', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        await rowOnceDrawn('reads.mode')
        await userEvent.click(screen.getByRole('button', { name: /Something’s wrong\?/ }))
        await waitFor(() => expect(screen.getByRole('textbox', { name: 'Describe the problem' })).toHaveFocus())
        await userEvent.click(screen.getByRole('button', { name: 'Close the finder' }))
        await waitFor(() => expect(screen.getByRole('button', { name: /Something’s wrong\?/ })).toHaveFocus())
    })

    it('asks for the signals only where a finder shows them', async () => {
        const sent = mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: '/admin/versioned-graphs?tab=history' })
        await screen.findByText('Every change, with why')
        await userEvent.click(screen.getByRole('tab', { name: /Settings/ }))
        await rowOnceDrawn('reads.mode')
        expect(calls(sent, 'GET', '/admin/versioning/signals')).toHaveLength(0)
        await userEvent.click(screen.getByRole('button', { name: /Something’s wrong\?/ }))
        await waitFor(() => expect(calls(sent, 'GET', '/admin/versioning/signals')).toHaveLength(1))
    })

    it('asks before another page drops what is staged on the platform, and stays when asked to', async () => {
        mockApi()
        const router = createMemoryRouter([
            { path: '/admin/versioned-graphs', element: <><AdminVersionedGraphs /><Link to="/elsewhere">Elsewhere</Link></> },
            { path: '/elsewhere', element: <p>Somewhere else</p> },
        ], { initialEntries: [SETTINGS] })
        render(
            <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
                <RouterProvider router={router} />
                <NotificationStack />
            </QueryClientProvider>,
        )
        await stageReadMode()
        // Another tab of the same page isn't leaving.
        await userEvent.click(screen.getByRole('tab', { name: /History/ }))
        expect(screen.queryByRole('dialog', { name: /^Leave without saving/ })).not.toBeInTheDocument()
        await userEvent.click(screen.getByRole('link', { name: 'Elsewhere' }))
        const dialog = await screen.findByRole('dialog', { name: 'Leave without saving 1 change?' })
        expect(dialog).toHaveTextContent('Your changes to the platform’s settings are staged, not saved.')
        await userEvent.click(within(dialog).getByRole('button', { name: 'Stay' }))
        expect(screen.queryByText('Somewhere else')).not.toBeInTheDocument()

        await userEvent.click(screen.getByRole('link', { name: 'Elsewhere' }))
        await userEvent.click(within(await screen.findByRole('dialog', { name: 'Leave without saving 1 change?' })).getByRole('button', { name: 'Discard and leave' }))
        expect(await screen.findByText('Somewhere else')).toBeInTheDocument()
    })
})

describe('Settings: a category’s switch', () => {
    it('asks before turning New-version builds on, as Admin → Features does, then saves it through the Features API', async () => {
        const sent = mockApi('ok', (req) => (req.method === 'PATCH' && req.path.endsWith('/admin/features')
            ? json({ ...(req.body as object), values: { versioningEnabled: true, candidateKeysEnabled: true, residencyEnabled: true }, version: 8 }) : undefined))
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        const card = within((await screen.findByRole('heading', { level: 3, name: 'New-version builds' })).closest('section')!)
        await userEvent.click(card.getByRole('switch'))
        const confirm = await screen.findByRole('dialog', { name: 'Turn on New-version builds?' })
        await userEvent.click(within(confirm).getByRole('button', { name: 'Turn on for everyone' }))
        await waitFor(() => expect(calls(sent, 'PATCH', '/admin/features')).toHaveLength(1))
        expect(calls(sent, 'PATCH', '/admin/features')[0].body).toMatchObject({ candidateKeysEnabled: true, version: 7 })
    })

    it('offers a dormant setting’s fix in one click, which opens the same confirmation', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        await userEvent.click((await rowOnceDrawn('builds.aboveRows')).getAllByRole('button', { name: 'Turn on New-version builds' })[0])
        expect(await screen.findByRole('dialog', { name: 'Turn on New-version builds?' })).toBeInTheDocument()
    })
})

describe('Settings: explainers drawn from real facts', () => {
    const SUMMARY_PATH = '/admin/versioning/graphs/summary'
    const howItWorks = async (name: string) => {
        const article = within(await screen.findByRole('article', { name }))
        await userEvent.click(article.getByRole('button', { name: 'How it works' }))
        return article
    }

    it('draws the room for a copy from each node’s memory and the largest graph, named, once its guidance opens', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        const copy = await howItWorks(S['builds.copyRoomPct'].label)
        // The figures' largest graph (Sales lineage, 9.4 GB) at the platform's 250%, over the three nodes the topology reads.
        expect(await copy.findByRole('figure', { name: 'Room for a copy' }))
            .toHaveAccessibleDescription(/^Sales lineage is 9\.4 GB\. At 250%, a copy needs 23\.5 GB free under a node’s start mark \(80%\): it fits on 0 of 3 nodes\./)
    })

    it('names the largest graph plainly when its data source can’t be named', async () => {
        mockApi('ok', (req) => (req.path.endsWith(SUMMARY_PATH) ? json({ ...SUMMARY, largestGraph: { ...SUMMARY.largestGraph, label: null } }) : undefined))
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        const copy = await howItWorks(S['builds.copyRoomPct'].label)
        expect(await copy.findByRole('figure', { name: 'Room for a copy' })).toHaveAccessibleDescription(/^Your largest graph is 9\.4 GB\./)
    })

    it.each([
        ['while no graph is measured', 'ok' as const, () => json({ ...SUMMARY, largestGraph: null })],
        ['for a viewer the figures are refused to', 'readonly' as const, () => json({ detail: 'Not allowed' }, 403)],
    ])('draws no room for a copy %s', async (_, scenario, answer) => {
        const sent = mockApi(scenario, (req) => (req.path.endsWith(SUMMARY_PATH) ? answer() : undefined))
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        const copy = await howItWorks(S['builds.copyRoomPct'].label)
        expect(copy.getByRole('heading', { name: 'What it means' })).toBeInTheDocument()
        // The node memory and the figures are read, and the guidance is open: there is no graph to draw.
        await waitFor(() => {
            expect(calls(sent, 'GET', SUMMARY_PATH).length).toBeGreaterThan(0)
            expect(calls(sent, 'GET', '/admin/graph-store/topology').length).toBeGreaterThan(0)
        })
        await expect(copy.findByRole('figure', { name: 'Room for a copy' }, { timeout: 500 })).rejects.toThrow()
    })

    it('reads its figures every 30 s while nothing is staged, and not over a staged change', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        try {
            const sent = mockApi()
            renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
            await rowOnceDrawn('reads.mode')
            await waitFor(() => expect(calls(sent, 'GET', SUMMARY_PATH)).toHaveLength(1))
            await vi.advanceTimersByTimeAsync(31_000)
            await waitFor(() => expect(calls(sent, 'GET', SUMMARY_PATH)).toHaveLength(2))
            await stageReadMode()
            await vi.advanceTimersByTimeAsync(61_000)
            expect(calls(sent, 'GET', SUMMARY_PATH)).toHaveLength(2)
        } finally {
            vi.useRealTimers()
        }
    })

    it('in the Business view too, once its guidance opens under its question', async () => {
        usePersonaStore.setState({ mode: 'business' })
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        const copy = await howItWorks(S['builds.copyRoomPct'].question || S['builds.copyRoomPct'].label)
        expect(await copy.findByRole('figure', { name: 'Room for a copy' })).toHaveAccessibleDescription(/^Sales lineage is 9\.4 GB\./)
    })
})
