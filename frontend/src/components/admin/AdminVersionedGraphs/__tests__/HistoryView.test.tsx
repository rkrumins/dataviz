/**
 * Admin → Versioned graphs → History: each save as one change set — who, when, why, how it was
 * made, where (by name; the Technical view adds the key, the version and the id), and each value
 * and limit from → to — a day at a time, filtered on the server (folded on a phone), paged, and
 * put back through the same review a save goes through. Labels come from the registry's catalogue.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dayLabel } from '@/components/activity/groupEvents'
import { CATALOGUE } from '@/components/settings'
import { REASON_HEADER } from '@/services/activityReason'
import { usePersonaStore } from '@/store/persona'
import { AdminVersionedGraphs } from '..'
import { HISTORY as ENTRIES, WS } from '../__fixtures__/api'
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

    it('reads a day at a time, newest first, as the activity timeline does', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: HISTORY })
        await changeSet('Large imports were slowing canvases for the sales team')
        const now = new Date()
        const days = [...new Set(ENTRIES.map((e) => new Date(e.at).toDateString()))].map((d) => dayLabel(new Date(d), now))
        const headings = screen.getAllByRole('heading', { level: 3 })
        expect(headings.map((h) => h.textContent)).toEqual(days)
        // Each change under its own day.
        const day = headings[0].parentElement!
        expect(within(day).getByText('“Large imports were slowing canvases for the sales team”')).toBeInTheDocument()
        expect(within(day).queryByText('“Finance keeps closed drafts for its audits”')).not.toBeInTheDocument()
    })

    it('names where each change was made in both views; the Technical view adds the key, the version and the id', async () => {
        usePersonaStore.setState({ mode: 'business' })
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: HISTORY })
        const graph = await changeSet('Sales rows carry their SKU')
        const workspace = await changeSet('Finance keeps closed drafts for its audits')
        expect(graph.getByText('Sales lineage')).toBeInTheDocument()
        expect(workspace.getByText('Finance')).toBeInTheDocument()
        const sku = ENTRIES.find((e) => e.changeSetId === 'cs_g1')!
        for (const card of [graph, workspace]) expect(card.queryByText(/\b(ws|ds)_\w+/)).not.toBeInTheDocument()
        expect(graph.queryByText(sku.key)).not.toBeInTheDocument()

        act(() => usePersonaStore.getState().setMode('technical'))
        expect(await graph.findByText(sku.scopeId)).toBeInTheDocument()
        expect(graph.getByText('Sales lineage')).toBeInTheDocument()
        expect(graph.getByText(sku.key)).toBeInTheDocument()
        expect(graph.getByText(`version ${sku.version}`)).toBeInTheDocument()
        expect(workspace.getByText(WS)).toBeInTheDocument()
    })

    it('folds the filters behind "Filters" on a phone, counting those set', async () => {
        const user = userEvent.setup()
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: HISTORY })
        await changeSet('Large imports were slowing canvases for the sales team')
        const toggle = screen.getByRole('button', { name: /^Filters/ })
        const filters = document.getElementById(toggle.getAttribute('aria-controls')!)!
        expect(filters).toContainElement(screen.getByLabelText('Setting'))
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
        // Out of the way on a phone (`hidden`), always out from `sm` up.
        expect(filters).toHaveClass('hidden', 'sm:flex')
        await user.click(toggle)
        expect(toggle).toHaveAttribute('aria-expanded', 'true')
        expect(filters).not.toHaveClass('hidden')
        await user.selectOptions(screen.getByLabelText('Setting'), 'reads.mode')
        await user.selectOptions(screen.getByLabelText('Where'), 'platform')
        expect(toggle).toHaveAccessibleName('Filters, 2 set')
    })

    it('filters on the server by setting, place and person', async () => {
        const sent = mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: HISTORY })
        await changeSet('Large imports were slowing canvases for the sales team')
        await userEvent.selectOptions(screen.getByLabelText('Setting'), 'reads.mode')
        await userEvent.selectOptions(screen.getByLabelText('Where'), 'platform')
        await userEvent.click(screen.getByRole('combobox', { name: 'Who' }))
        await userEvent.click(await screen.findByRole('option', { name: /Ada Lovelace/ }))
        await waitFor(() => expect(Object.fromEntries(calls(sent, 'GET', '/settings/history').at(-1)!.query))
            .toEqual({ key: 'reads.mode', scope: 'platform', actor: 'usr_ada' }))
        expect(screen.getByRole('combobox', { name: 'Who' })).toHaveValue('Ada Lovelace')
    })

    it('finds anyone under Who, not only the people in the changes read so far', async () => {
        const sent = mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: HISTORY })
        await changeSet('Large imports were slowing canvases for the sales team')
        const who = screen.getByRole('combobox', { name: 'Who' })
        await userEvent.type(who, 'Katherine')
        // Nobody named Katherine made a change on the pages read: the directory finds her.
        await userEvent.click(await screen.findByRole('option', { name: /Katherine Johnson/ }))
        await waitFor(() => expect(calls(sent, 'GET', '/settings/history').at(-1)!.query.get('actor')).toBe('usr_katherine'))
        expect(await screen.findByText('No change matches these filters')).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: 'Anyone: clear who' }))
        await waitFor(() => expect(calls(sent, 'GET', '/settings/history').at(-1)!.query.get('actor')).toBeNull())
    })

    it('reads a change set the pages split to its end before putting it back, so the review lists all of it', async () => {
        // cs_3 is two values: the first page ends with one of them.
        const sent = mockApi('ok', (req) => (req.path.endsWith('/settings/history') ? json(req.query.get('cursor')
            ? { scope: 'platform', entries: ENTRIES.slice(2), nextCursor: null }
            : { scope: 'platform', entries: ENTRIES.slice(0, 2), nextCursor: 40 }) : undefined))
        renderWithApi(<AdminVersionedGraphs />, { path: HISTORY })
        const split = await changeSet('Large imports were slowing canvases for the sales team')
        expect(split.getAllByRole('listitem')).toHaveLength(1)
        await userEvent.click(split.getByRole('button', { name: /^Put back Ada Lovelace’s change to / }))
        const dialog = await screen.findByRole('dialog', { name: 'Review 2 changes to the platform' })
        expect(within(dialog).getByText(S['residency.unloadStartPct'].label)).toBeInTheDocument()
        expect(calls(sent, 'GET', '/settings/history').at(-1)!.query.get('cursor')).toBe('40')
    })

    it('names each "Put back" for its change', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: HISTORY })
        await changeSet('Large imports were slowing canvases for the sales team')
        const names = screen.getAllByRole('button', { name: /^Put back/ }).map((b) => b.getAttribute('aria-label'))
        expect(new Set(names).size).toBe(names.length)
        expect(names).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^Put back Ada Lovelace’s change to ${S['reads.mode'].label} and 1 more, `))]))
    })

    it('puts a change back through the same review: what it does, a reason, then the revert', async () => {
        const sent = mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: HISTORY })
        const save = await changeSet('Large imports were slowing canvases for the sales team')
        await userEvent.click(save.getByRole('button', { name: /^Put back Ada Lovelace’s change to / }))

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
        await userEvent.click(save.getByRole('button', { name: /^Put back Ada Lovelace’s change to / }))
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

/**
 * The days picked stay the days shown, wherever the reader is: the request asks from the start of
 * the first to the end of the last, in the reader's time zone (P1-7: Berlin and Los Angeles used to
 * drift a day on each pick).
 */
describe.each([
    ['Europe/Berlin', '2026-11-15T23:00:00.000Z', '2026-11-16T22:59:59.999Z'],
    ['America/Los_Angeles', '2026-11-16T08:00:00.000Z', '2026-11-17T07:59:59.999Z'],
])('History’s days, in %s', (zone, since, until) => {
    const was = process.env.TZ
    beforeAll(() => { process.env.TZ = zone })
    afterAll(() => { process.env.TZ = was })

    it('keeps the days picked, and asks from the start of the first to the end of the last', async () => {
        const sent = mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: HISTORY })
        await changeSet('Large imports were slowing canvases for the sales team')
        const from = screen.getByLabelText('Changed on or after')
        const to = screen.getByLabelText('Changed on or before')
        fireEvent.change(from, { target: { value: '2026-11-16' } })
        fireEvent.change(to, { target: { value: '2026-11-16' } })
        await waitFor(() => expect(Object.fromEntries(calls(sent, 'GET', '/settings/history').at(-1)!.query)).toEqual({ since, until }))
        expect(from).toHaveValue('2026-11-16')
        expect(to).toHaveValue('2026-11-16')
        // Picking again doesn't drift.
        fireEvent.change(from, { target: { value: '2026-11-16' } })
        expect(from).toHaveValue('2026-11-16')
        // Only Ada's save of the 16th, 15:40 UTC, is in that day in both zones.
        expect(await screen.findByText('“Let teams choose switch when ready for big nightly imports”')).toBeInTheDocument()
    })
})
