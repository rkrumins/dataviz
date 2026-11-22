/**
 * Admin → Versioned graphs → Overview.
 *
 *   hero        the fleet in figures as the headline, the read mode the server describes, whether
 *               anything needs attention (a pill that leads there), the switches, and the ways in:
 *               the guide for an editor ("Continue setup" once it has staged something), "Review the
 *               settings" for everyone
 *   attention   each item with its one action: Show them (the list, filtered), See what to change
 *               (the finder, opened at that problem), Show the setting, the fix (a switch through its
 *               confirmation, a setting staged), Review; a viewer who may only read gets no fix; what
 *               couldn't be checked is said; when nothing needs attention, a calm line
 *   figures     each defined on a tap and dated, counting up to the server's value (at once for a
 *               person who asked for calm), "—" with why (never 0) when they couldn't be read, a way
 *               into the list; not read again over staged changes
 *   the rest    each category's posture, "Something's wrong?" and every graph
 *
 * The memory states, graphs with no copy yet among them, add up to the graphs; each button says which
 * figure, problem or setting it is for. Labels come from the catalogue.
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MotionConfig } from 'framer-motion'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CATALOGUE, describeFix, settingAnchor } from '@/components/settings'
import { platformFor } from '@/harness/versionedGraphsFixtures'
import { usePersonaStore } from '@/store/persona'
import { AdminVersionedGraphs } from '..'
import { SCHEMA, SUMMARY } from '../__fixtures__/api'
import { allowMenus, calls, json, mockApi, renderWithApi } from './helpers'

vi.mock('@tanstack/react-virtual', async () => (await import('./helpers')).virtualizerMock())

beforeAll(allowMenus)
afterEach(() => { vi.useRealTimers() })

const OVERVIEW = '/admin/versioned-graphs'
const SUMMARY_PATH = '/admin/versioning/graphs/summary'
const S = Object.fromEntries(CATALOGUE.settings.map((s) => [s.key, s]))
const P = Object.fromEntries(CATALOGUE.profiles.map((p) => [p.id, p]))
const label = (id: string) => CATALOGUE.categories.find((c) => c.id === id)!.label
const signal = (id: string) => CATALOGUE.signals.find((s) => s.id === id)!
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const startsWith = (text: string) => new RegExp(`^${escape(text)}`)

/** The page as a person who asked for calm sees it: every figure at its value from the first frame. */
const page = () => <MotionConfig reducedMotion="always"><AdminVersionedGraphs /></MotionConfig>
const tile = async (name: string) => within((await screen.findByText(name, { selector: 'p' })).closest('section')!)
/** What needs attention, once it has been checked. */
async function attention() {
    const section = (await screen.findByRole('heading', { level: 2, name: /^Needs attention/ })).closest('section')!
    await waitFor(() => expect(section).not.toHaveAttribute('aria-busy'))
    return within(section)
}
/** The items listed, by their first line. */
const titles = (list: ReturnType<typeof within>) => list.getAllByRole('listitem').map((li: HTMLElement) => li.querySelector('div > div')?.textContent?.trim())

describe('Overview: the hero', () => {
    it('heads with the fleet in figures and what readers get, says what needs attention, and shows the switches', async () => {
        mockApi()
        renderWithApi(page(), { path: OVERVIEW })
        const reads = SCHEMA.categories.find((c) => c.id === 'reads')!
        expect(await screen.findByRole('heading', {
            level: 2, name: '42 versioned graphs: 34 in memory, 4 unloaded, 1 loading, 2 waiting for room, 1 with no copy yet.',
        })).toBeInTheDocument()
        expect(screen.getByText(reads.posture)).toBeInTheDocument()
        // A graph failing, two waiting for room, and the deployment's read timeout ignored.
        expect(await screen.findByRole('button', { name: '3 things need attention' })).toBeInTheDocument()
        const switches = within(screen.getByRole('list', { name: 'Feature switches' })).getAllByRole('listitem')
        expect(switches.map((li) => li.textContent)).toEqual(['New-version builds: Off', 'Graph residency: On'])
    })

    it('leads from its pill to what needs attention', async () => {
        mockApi()
        renderWithApi(page(), { path: OVERVIEW })
        await userEvent.click(await screen.findByRole('button', { name: '3 things need attention' }))
        expect(screen.getByRole('heading', { level: 2, name: /^Needs attention/ })).toHaveFocus()
    })

    it('offers the guide to an editor and the settings to everyone; a viewer who may only read reviews the settings', async () => {
        mockApi()
        const { unmount } = renderWithApi(page(), { path: OVERVIEW })
        expect(await screen.findByRole('button', { name: 'Set up with a guide' })).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', { name: 'Review the settings' }))
        expect(screen.getByTestId('where')).toHaveTextContent('?tab=settings')
        unmount()

        mockApi('readonly')
        renderWithApi(page(), { path: OVERVIEW })
        expect(await screen.findByRole('button', { name: 'Review the settings' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Set up with a guide' })).not.toBeInTheDocument()
    })

    it('in the Business view, offers to continue the guided setup and to review what it staged', async () => {
        usePersonaStore.setState({ mode: 'business' })
        mockApi()
        renderWithApi(page(), { path: OVERVIEW })
        await userEvent.click(await screen.findByRole('button', { name: 'Set up with a guide' }))
        const wizard = within(await screen.findByRole('dialog', { name: 'Guided setup' }))
        await userEvent.click(wizard.getByRole('radio', { name: P['fastest-reads'].goal }))
        await userEvent.click(wizard.getByRole('button', { name: /^Next/ }))
        await wizard.findByRole('heading', { level: 3, name: 'While data loads' })
        await userEvent.click(wizard.getByRole('button', { name: 'Close' }))
        await userEvent.click(within(await screen.findByRole('dialog', { name: 'Keep your 3 choices staged?' })).getByRole('button', { name: 'Keep them staged' }))

        expect(await screen.findByRole('button', { name: 'Continue setup' })).toBeInTheDocument()
        const list = await attention()
        expect(list.getByText('3 changes not saved')).toBeInTheDocument()
        await userEvent.click(list.getByRole('button', { name: 'Review: 3 changes not saved' }))
        expect(await screen.findByRole('dialog', { name: 'Review 3 changes to the platform' })).toBeInTheDocument()
        expect(screen.getByTestId('where')).toHaveTextContent('?tab=settings')
    })
})

describe('Overview: what needs attention', () => {
    it('puts the most important first, six at a time', async () => {
        mockApi('attention')
        renderWithApi(page(), { path: OVERVIEW })
        const list = await attention()
        // A graph failing, two waiting, two problems past their marks, two values held from what was chosen, and the
        // deployment's read timeout ignored: seven, the last behind "Show all".
        expect(await screen.findByRole('button', { name: '7 things need attention' })).toBeInTheDocument()
        expect(titles(list)).toEqual([
            '1 graph is failing', '2 graphs are waiting for room',
            signal('residency.load_waited_for_room').symptom, signal('imports.replace_refused_by_guard').symptom,
            `${S['reads.mode'].label} Adjusted`, `${S['drafts.defaultVisibility'].label} Adjusted`,
        ])
        await userEvent.click(list.getByRole('button', { name: 'Show all 7' }))
        expect(titles(list).at(-1)).toBe(`${S['database.readTimeoutMs'].label} Deployment value ignored`)
        expect(list.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true')
    })

    it('shows the failing graphs, and those waiting for room, in the list; and leads to the memory settings', async () => {
        const sent = mockApi()
        renderWithApi(page(), { path: OVERVIEW })
        const list = await attention()
        await userEvent.click(list.getByRole('button', { name: 'Show them: the failing graphs' }))
        await waitFor(() => expect(calls(sent, 'GET', '/admin/versioning/graphs').at(-1)?.query.get('status')).toBe('failed'))
        await userEvent.click(list.getByRole('button', { name: 'Show them: the graphs waiting for room' }))
        await waitFor(() => expect(calls(sent, 'GET', '/admin/versioning/graphs').at(-1)?.query.get('status')).toBe('waiting_capacity'))
        await userEvent.click(list.getByRole('button', { name: `${label('residency')} settings` }))
        expect(screen.getByTestId('where')).toHaveTextContent('?tab=settings')
    })

    it('opens the finder at a problem past its mark, with what happened', async () => {
        mockApi('attention')
        renderWithApi(page(), { path: OVERVIEW })
        const loads = signal('residency.load_waited_for_room')
        await userEvent.click((await attention()).getByRole('button', { name: `See what to change: ${loads.symptom}` }))
        const finder = within(screen.getByRole('heading', { name: 'Something’s wrong?' }).closest('section')!)
        const picked = finder.getByRole('button', { name: startsWith(loads.symptom) })
        expect(picked).toHaveAttribute('aria-pressed', 'true')
        await waitFor(() => expect(picked).toHaveFocus())
        expect(within(finder.getByRole('list', { name: 'What happened' })).getByText(`${loads.label}:`)).toBeInTheDocument()
        expect(finder.getByText(loads.settings.length === 1 ? 'One setting drives this' : /settings drive this$/)).toBeInTheDocument()
    })

    it('shows a setting whose deployment value was ignored', async () => {
        mockApi()
        renderWithApi(page(), { path: OVERVIEW })
        const timeout = S['database.readTimeoutMs']
        await userEvent.click((await attention()).getByRole('button', { name: `Show the setting: ${timeout.label}` }))
        expect(screen.getByTestId('where')).toHaveTextContent(`?tab=settings#${settingAnchor(timeout.key)}`)
    })

    it('applies a fix that turns a switch on through the switch’s own confirmation, here on the Overview', async () => {
        const sent = mockApi('attention', (req) => (req.method === 'PATCH' && req.path.endsWith('/admin/features')
            ? json({ ...(req.body as object), values: { versioningEnabled: true, candidateKeysEnabled: true, residencyEnabled: true }, version: 8 }) : undefined))
        renderWithApi(page(), { path: OVERVIEW })
        const fix = describeFix(CATALOGUE.why.builds_off.fix!)
        await userEvent.click((await attention()).getByRole('button', { name: `${fix}: ${S['reads.mode'].label}` }))
        const confirm = await screen.findByRole('dialog', { name: `${fix}?` })
        expect(calls(sent, 'PATCH', '/admin/features')).toHaveLength(0)
        await userEvent.click(within(confirm).getByRole('button', { name: 'Turn on for everyone' }))
        await waitFor(() => expect(calls(sent, 'PATCH', '/admin/features')).toHaveLength(1))
        expect(calls(sent, 'PATCH', '/admin/features')[0].body).toMatchObject({ candidateKeysEnabled: true })
    })

    it('stages a fix that sets a value, never saves it, and shows it in Settings', async () => {
        const sent = mockApi('attention')
        renderWithApi(page(), { path: OVERVIEW })
        const fix = CATALOGUE.why.derived_from_levels.fix!
        const words = describeFix(fix, { settings: S })
        await userEvent.click((await attention()).getByRole('button', { name: `${words}: ${S['drafts.defaultVisibility'].label}` }))
        await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`?tab=settings#${settingAnchor(fix.setting!)}`))
        expect(await screen.findByRole('region', { name: 'Unsaved changes' })).toHaveTextContent('1 change not saved yet')
        expect(calls(sent, 'PATCH', '/admin/versioning/settings')).toHaveLength(0)
    })

    it('gives a viewer who may only read no fix: the setting instead', async () => {
        mockApi('readonly', (req) => (req.method === 'GET' && req.path.endsWith('/admin/versioning/settings') ? json(platformFor('attention', null)) : undefined))
        renderWithApi(page(), { path: OVERVIEW })
        const list = await attention()
        expect(await list.findByRole('button', { name: `Show the setting: ${S['reads.mode'].label}` })).toBeInTheDocument()
        expect(list.getByRole('button', { name: `Show the setting: ${S['drafts.defaultVisibility'].label}` })).toBeInTheDocument()
        expect(list.queryByRole('button', { name: startsWith(describeFix(CATALOGUE.why.builds_off.fix!)) })).not.toBeInTheDocument()
        expect(list.queryByRole('button', { name: startsWith(describeFix(CATALOGUE.why.derived_from_levels.fix!, { settings: S })) })).not.toBeInTheDocument()
    })

    it('says so when what happened can’t be counted, rather than list nothing', async () => {
        mockApi('attention', (req) => (req.path.endsWith('/admin/versioning/signals')
            ? json({ asOf: '2026-11-16T16:24:00Z', window: '24h', unavailable: true, signals: [] }) : undefined))
        renderWithApi(page(), { path: OVERVIEW })
        const list = await attention()
        expect(await list.findByText('How often problems happened can’t be counted right now, so none of them is listed.')).toBeInTheDocument()
        expect(list.queryByText(signal('residency.load_waited_for_room').symptom)).not.toBeInTheDocument()
    })

    it('says, calmly, when nothing needs attention, and what was checked', async () => {
        mockApi('calm')
        renderWithApi(page(), { path: OVERVIEW })
        const calm = within((await screen.findByRole('heading', { level: 2, name: 'Nothing needs attention' })).closest('section')!)
        expect(calm.getByText('No graph is failing or waiting for room, nothing counted in the last 24 hours reached its mark, and no setting needs a fix.'))
            .toBeInTheDocument()
        expect(calm.queryByRole('listitem')).not.toBeInTheDocument()
        // The hero says it too, and has nowhere to send you.
        expect(screen.getAllByText('Nothing needs attention')).toHaveLength(2)
        expect(screen.queryByRole('button', { name: /needs? attention$/ })).not.toBeInTheDocument()
    })
})

describe('Overview: the figures', () => {
    it('shows each figure with what it counts and when it was read, the memory states adding up to the graphs', async () => {
        mockApi()
        renderWithApi(page(), { path: OVERVIEW })
        await screen.findByText('The fleet now')
        // At its value at once: the page is seen as by a person who asked for calm.
        expect((await tile('Versioned graphs')).getByText(String(SUMMARY.graphs))).toBeInTheDocument()
        expect((await tile('In memory')).getByRole('img'))
            .toHaveAccessibleName('In memory: 34, Unloaded: 4, Loading: 1, Waiting for room: 2, No copy yet: 1')
        expect(SUMMARY.inMemory + SUMMARY.unloaded + SUMMARY.loading + SUMMARY.waitingForRoom + SUMMARY.noCopy).toBe(SUMMARY.graphs)
        expect((await tile('Failing')).getByText('1')).toBeInTheDocument()
        // Each definition is named for its figure.
        const definitions = screen.getAllByRole('button', { name: /^What does ".+" mean\?$/ }).map((b) => b.getAttribute('aria-label'))
        expect(definitions).toHaveLength(5)
        expect(new Set(definitions).size).toBe(5)
        // Read when it was read, and not announced again each time the clock moves.
        expect(screen.getByText(/^As of /).closest('[aria-live]')).toBeNull()
    })

    it('counts each figure up to the server’s value', async () => {
        mockApi()
        renderWithApi(<AdminVersionedGraphs />, { path: OVERVIEW })
        const graphs = await tile('Versioned graphs')
        await waitFor(() => expect(graphs.getByText(String(SUMMARY.graphs))).toBeInTheDocument())
        await waitFor(() => expect((within(screen.getByText('In memory', { selector: 'p' }).closest('section')!)).getByText(String(SUMMARY.inMemory))).toBeInTheDocument())
    })

    it('opens a figure’s definition on a tap: what it counts, how, and why it matters', async () => {
        const user = userEvent.setup()
        mockApi()
        renderWithApi(page(), { path: OVERVIEW })
        await screen.findByText('The fleet now')
        const trigger = (await tile('Failing')).getByRole('button', { name: 'What does "Failing" mean?' })
        await user.click(trigger)
        const definition = screen.getByRole('dialog', { name: 'Failing' })
        expect(within(definition).getByText("How it's calculated")).toBeInTheDocument()
        expect(within(definition).getByText('Why it matters')).toBeInTheDocument()
        expect(trigger).toHaveAttribute('aria-expanded', 'true')

        await user.keyboard('{Escape}')
        expect(screen.queryByRole('dialog', { name: 'Failing' })).not.toBeInTheDocument()
        expect(trigger).toHaveFocus()
    })

    it('shows "—" and why when the figures couldn’t be read, never 0', async () => {
        mockApi('ok', (req) => (req.path.endsWith(SUMMARY_PATH) ? json({ detail: 'The graph store didn’t answer in time' }, 503) : undefined))
        renderWithApi(page(), { path: OVERVIEW })
        expect(await screen.findByText(/Couldn’t read the figures: The graph store didn’t answer in time/, {}, { timeout: 4000 })).toBeInTheDocument()
        // Said once, as an alert, not in every tile.
        expect(screen.getAllByText(/Couldn’t read the figures/)).toHaveLength(1)
        expect(screen.getByText(/Couldn’t read the figures/).closest('[role="alert"]')).not.toBeNull()
        expect(screen.getAllByLabelText('Not known')).toHaveLength(5)
        expect(screen.queryByText(/^0$/)).not.toBeInTheDocument()
        // The hero says so in place of the fleet, and what needs attention says what it couldn't check.
        expect(screen.getByRole('heading', { level: 2, name: 'The fleet’s figures couldn’t be read' })).toBeInTheDocument()
        expect((await attention()).getByText(/^The fleet’s figures couldn’t be read, so failing graphs/)).toBeInTheDocument()
    })

    it('asks for the figures and the list beside the registry, not after it', async () => {
        // The registry never answers: the figures and the list are asked for all the same.
        const sent = mockApi('ok', (req) => (req.path.endsWith('/settings/versioned-graphs/schema') ? new Promise<Response>(() => {}) : undefined))
        renderWithApi(page(), { path: OVERVIEW })
        await waitFor(() => expect(calls(sent, 'GET', SUMMARY_PATH)).toHaveLength(1))
        await waitFor(() => expect(calls(sent, 'GET', '/admin/versioning/graphs')).toHaveLength(1))
    })

    it('reads its figures every 30 s while nothing is staged, and not over a staged change', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
        const sent = mockApi('attention')
        renderWithApi(page(), { path: OVERVIEW })
        await waitFor(() => expect(calls(sent, 'GET', SUMMARY_PATH)).toHaveLength(1))
        await vi.advanceTimersByTimeAsync(31_000)
        await waitFor(() => expect(calls(sent, 'GET', SUMMARY_PATH)).toHaveLength(2))
        // A fix stages a value and shows it on Settings; back on the Overview, the figures wait for the save or the discard.
        const fix = describeFix(CATALOGUE.why.derived_from_levels.fix!, { settings: S })
        await userEvent.click((await attention()).getByRole('button', { name: `${fix}: ${S['drafts.defaultVisibility'].label}` }))
        await userEvent.click(await screen.findByRole('tab', { name: /Overview/ }))
        expect(await (await attention()).findByText('1 change not saved')).toBeInTheDocument()
        await vi.advanceTimersByTimeAsync(61_000)
        expect(calls(sent, 'GET', SUMMARY_PATH)).toHaveLength(2)
    })

    it('opens the list on the graphs a figure counts', async () => {
        // A fleet building new versions (the harness has New-version builds off, so it counts none).
        const sent = mockApi('ok', (req) => (req.path.endsWith(SUMMARY_PATH) ? json(SUMMARY) : undefined))
        renderWithApi(page(), { path: OVERVIEW })
        await screen.findByText('The fleet now')
        await userEvent.click((await tile('Failing')).getByRole('button', { name: 'Show them: Failing' }))
        await waitFor(() => expect(calls(sent, 'GET', '/admin/versioning/graphs').at(-1)?.query.get('status')).toBe('failed'))
        await userEvent.click((await tile('Building a new version')).getByRole('button', { name: 'Show them: Building a new version' }))
        await waitFor(() => expect(calls(sent, 'GET', '/admin/versioning/graphs').at(-1)?.query.get('status')).toBe('building'))
        await userEvent.click((await tile('In memory')).getByRole('button', { name: /2 waiting for room/ }))
        await waitFor(() => expect(calls(sent, 'GET', '/admin/versioning/graphs').at(-1)?.query.get('status')).toBe('waiting_capacity'))
    })
})

describe('Overview: the categories, the finder and the list', () => {
    it('opens a category’s settings from its posture, and a graph’s settings from the list', async () => {
        mockApi()
        renderWithApi(page(), { path: OVERVIEW })
        const imports = SCHEMA.categories.find((c) => c.id === 'imports')!
        // Every category but reads, whose posture the hero says.
        for (const c of SCHEMA.categories.filter((x) => x.id !== 'reads')) expect(await screen.findByText(c.posture)).toBeInTheDocument()
        // A phone folds them under a button of its own; wider, they are open.
        expect(screen.getByRole('button', { name: 'Show how each category is set' })).toHaveAttribute('aria-expanded', 'false')
        await userEvent.click((await screen.findByText(imports.posture)).closest('button')!)
        expect(screen.getByTestId('where')).toHaveTextContent('?tab=settings')

        await userEvent.click(screen.getByRole('tab', { name: /Overview/ }))
        const sales = (await screen.findByText('Sales lineage')).closest('[role="row"]') as HTMLElement
        await userEvent.click(within(sales).getByRole('button', { name: 'Settings… for Sales lineage' }))
        expect(await screen.findByRole('dialog', { name: 'Sales lineage' })).toBeInTheDocument()
    })

    it('stages a symptom’s recommended value on the platform and shows it in Settings', async () => {
        mockApi()
        renderWithApi(page(), { path: OVERVIEW })
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
