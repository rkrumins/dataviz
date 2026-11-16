/**
 * Admin → Versioned graphs → History: each save as one change set — who, when, why, how it was
 * made, where, and each value and limit from → to — filtered on the server, paged, and put back
 * through the same review a save goes through. Labels come from the registry's catalogue.
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { CATALOGUE } from '@/components/settings'
import { REASON_HEADER } from '@/services/activityReason'
import { AdminVersionedGraphs } from '..'
import { SOURCE_LABEL } from '../meta'
import { calls, json, mockApi, renderWithApi } from './helpers'

const S = Object.fromEntries(CATALOGUE.settings.map((s) => [s.key, s]))
const title = (key: string, id: string) => S[key].choices.find((c) => c.id === id)!.title
const HISTORY = '/admin/versioned-graphs?tab=history'
const changeSet = async (reason: string) => within((await screen.findByText(`“${reason}”`)).closest('article')!)

describe('History', () => {
    it('shows each save once, with who, when, why, how and where, and every value and limit from → to', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: HISTORY })
        const save = await changeSet('Large imports were slowing canvases for the sales team')
        expect(save.getByText('Ada Lovelace')).toBeInTheDocument()
        expect(save.getByText(SOURCE_LABEL.api)).toBeInTheDocument()
        expect(save.getByText(S['reads.mode'].label)).toBeInTheDocument()
        expect(save.getAllByText('Not set (inherits)')).toHaveLength(2)   // both values were the default before
        expect(save.getByText(title('reads.mode', 'in_place'))).toBeInTheDocument()
        expect(save.getByText('85%')).toBeInTheDocument()

        const limits = await changeSet('Let teams choose switch when ready for big nightly imports')
        expect(limits.getByText(/What workspaces and graphs may choose/)).toHaveTextContent(
            `${title('reads.mode', 'latest')}, ${title('reads.mode', 'in_place')} → ${title('reads.mode', 'latest')}, ${title('reads.mode', 'in_place')}, ${title('reads.mode', 'beside')}`)

        const workspace = await changeSet('Finance keeps closed drafts for its audits')
        expect(workspace.getByText('Grace Hopper')).toBeInTheDocument()
        expect(workspace.getByText('Workspace')).toBeInTheDocument()
        expect(workspace.getByText('Forever')).toBeInTheDocument()

        const carried = await changeSet('Carried over from the import settings')
        expect(carried.getByText('The system')).toBeInTheDocument()
        expect(carried.getByText(SOURCE_LABEL.migration)).toBeInTheDocument()
    })

    it('filters on the server by setting, place and person', async () => {
        const sent = mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: HISTORY })
        await changeSet('Large imports were slowing canvases for the sales team')
        await userEvent.selectOptions(screen.getByLabelText('Setting'), 'reads.mode')
        await userEvent.selectOptions(screen.getByLabelText('Where'), 'platform')
        await userEvent.selectOptions(screen.getByLabelText('Who'), 'usr_ada')
        await waitFor(() => expect(Object.fromEntries(calls(sent, 'GET', '/settings/history').at(-1)!.query))
            .toEqual({ key: 'reads.mode', scope: 'platform', actor: 'usr_ada' }))
    })

    it('puts a change back through the same review: what it does, a reason, then the revert', async () => {
        const sent = mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: HISTORY })
        const save = await changeSet('Large imports were slowing canvases for the sales team')
        await userEvent.click(save.getByRole('button', { name: 'Put back…' }))

        const dialog = await screen.findByRole('dialog', { name: 'Review 2 changes to the platform' })
        expect(within(dialog).getByText(S['reads.mode'].label)).toBeInTheDocument()
        await waitFor(() => expect(calls(sent, 'POST', '/settings/preview').at(-1)?.body).toMatchObject({
            changes: [{ key: 'reads.mode', value: null }, { key: 'residency.unloadStartPct', value: null }],
        }))
        const saveButton = within(dialog).getByRole('button', { name: 'Save 2 changes' })
        expect(saveButton).toBeDisabled()
        await userEvent.type(within(dialog).getByLabelText(/Why are you making this change/), 'Canvases are fine again')
        await userEvent.click(saveButton)

        await waitFor(() => expect(calls(sent, 'POST', '/history/cs_3/revert')).toHaveLength(1))
        const revert = calls(sent, 'POST', '/history/cs_3/revert')[0]
        expect(revert.body).toEqual({ reason: 'Canvases are fine again' })
        expect(decodeURIComponent(revert.headers.get(REASON_HEADER) ?? '')).toBe('Canvases are fine again')
        expect((await screen.findAllByText('Put back 2 values.')).length).toBeGreaterThan(0)
    })

    it('says a revert the server refused, and nothing changed', async () => {
        mockApi('ok', (req) => (req.path.endsWith('/revert')
            ? json({ detail: { type: 'settings_conflict', message: 'Changed since', conflicts: [{ key: 'reads.mode', scope: 'platform', scopeId: '', expected: 2, actual: 3 }] } }, 409)
            : undefined))
        renderWithApi(<AdminVersionedGraphs />, { path: HISTORY })
        const save = await changeSet('Large imports were slowing canvases for the sales team')
        await userEvent.click(save.getByRole('button', { name: 'Put back…' }))
        const dialog = await screen.findByRole('dialog')
        await userEvent.type(within(dialog).getByLabelText(/Why are you making this change/), 'Undo the read mode')
        await userEvent.click(within(dialog).getByRole('button', { name: 'Save 2 changes' }))
        expect(await within(dialog).findByRole('alert')).toHaveTextContent(`Someone changed ${S['reads.mode'].label} since you opened it. Nothing was saved.`)
    })

    it('teaches when there is no history yet, and says what failed otherwise', async () => {
        mockApi('empty')
        const { unmount } = renderWithApi(<AdminVersionedGraphs />, { path: HISTORY })
        expect(await screen.findByText('No changes yet')).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: 'Go to settings' }))
        expect(screen.getByTestId('where')).toHaveTextContent('?tab=settings')
        unmount()

        mockApi('error')
        renderWithApi(<AdminVersionedGraphs />, { path: HISTORY })
        expect(await screen.findByText(/Couldn’t read the history: /, {}, { timeout: 4000 })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    })
})
