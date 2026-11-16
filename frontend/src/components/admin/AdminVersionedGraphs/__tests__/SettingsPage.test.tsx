/**
 * Admin → Versioned graphs → Settings, against the settings API: every state a person can meet
 * (loading, an error with a retry, nothing to show, read-only), every category with the posture the
 * server writes, and the one save model — stage, the server's quick answer, Review with the full
 * preview and a reason, Save, Undo — with each refusal where it belongs (a 422 or 403 on its row and
 * in the review, a 409 with "Reload and re-apply my changes"). The platform's limits stage beside
 * the values; a category's switch asks first, as Admin → Features does. Labels come from the
 * registry's generated catalogue.
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it } from 'vitest'
import { CATALOGUE } from '@/components/settings'
import { REASON_HEADER } from '@/services/activityReason'
import { AdminVersionedGraphs } from '..'
import { platformValues } from '../__fixtures__/api'
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
            expect(within(rail).getByRole('button', { name: new RegExp(c.label.replace(/[&]/g, '\\$&')) })).toBeInTheDocument()
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

        expect(row('reads.mode').getByText(`Changing to ${title('reads.mode', 'beside')}`)).toBeInTheDocument()
        expect(screen.getByRole('region', { name: 'Unsaved changes' })).toHaveTextContent('1 change not saved yet')
        // The quick preview, once the edits pause: switch when ready is held to update in place while builds are off.
        expect(await row('reads.mode').findByText(`Once saved: ${title('reads.mode', 'in_place')}`)).toBeInTheDocument()
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

    it('stages what workspaces may choose beside the value, and asks to acknowledge the values left outside', async () => {
        const sent = mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        const limits = within((await screen.findAllByText('What workspaces and graphs may choose'))[0].closest('section')!)
        // Only the platform's own choice, "Always the latest", stays: the workspace and the graph that chose "switch when ready" are outside.
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
        mockApi('ok', (req) => (req.method === 'PATCH' ? json({ detail: {
            type: 'invalid_settings', message: 'Some values can’t be saved',
            errors: [{ key: 'reads.mode', code: 'not_allowed', message: 'Switch when ready isn’t offered on this platform.' }],
        } }, 422) : undefined))
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        await stageReadMode('beside')
        const dialog = await reviewAndSave()
        expect(await within(dialog).findByRole('alert')).toHaveTextContent(`Nothing was saved. ${S['reads.mode'].label}: Switch when ready isn’t offered on this platform.`)
        await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }))
        expect(row('reads.mode').getByText('Switch when ready isn’t offered on this platform.')).toBeInTheDocument()
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

    it('after a version conflict, reads the values again and saves the staged ones at the versions now in force (409)', async () => {
        let conflict = true
        const sent = mockApi('ok', (req) => {
            if (req.method === 'PATCH' && conflict) {
                conflict = false
                return json({ detail: { type: 'settings_conflict', message: 'Changed since it was read',
                    conflicts: [{ key: 'reads.mode', scope: 'platform', scopeId: '', expected: 1, actual: 4 }] } }, 409)
            }
            // Someone else saved meanwhile: read again, the read mode is at version 4.
            if (req.method === 'GET' && req.path.endsWith('/admin/versioning/settings') && !conflict) {
                const now = platformValues()
                return json({ ...now, values: now.values.map((r) => (r.key === 'reads.mode' ? { ...r, version: 4 } : r)) })
            }
            return undefined
        })
        renderWithApi(<AdminVersionedGraphs />, { path: SETTINGS })
        await stageReadMode()
        const dialog = await reviewAndSave()
        expect(await within(dialog).findByRole('alert')).toHaveTextContent(`Someone changed ${S['reads.mode'].label} since you opened it.`)
        const gets = () => calls(sent, 'GET', '/admin/versioning/settings').length
        const before = gets()
        await userEvent.click(within(dialog).getByRole('button', { name: 'Reload and re-apply my changes' }))
        await waitFor(() => expect(gets()).toBe(before + 1))
        await waitFor(() => expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument())
        await userEvent.click(within(dialog).getByRole('button', { name: 'Save change' }))
        await waitFor(() => expect(calls(sent, 'PATCH', '/admin/versioning/settings')).toHaveLength(2))
        expect((calls(sent, 'PATCH', '/admin/versioning/settings')[1].body as { changes: unknown[] }).changes)
            .toEqual([{ key: 'reads.mode', value: 'in_place', expectedVersion: 4 }])
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
