/**
 * The "New-version builds" card on Admin → Infrastructure → Versioned graphs (doc 14 §6): every
 * setting the server describes (``fields``) under its section, with the value in force, its default,
 * whether it is set here, and Reset to default (which saves ``-1``); sizes and durations entered in a
 * unit; a value out of its range refused before it is sent; Save behind a confirmation that lists each
 * change from → to, sending only the values that change; a value the server refuses (422) shown next
 * to the field it names; and whether the New-version builds switch is on.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { buildPolicy, saveBuildPolicy } = vi.hoisted(() => ({
    buildPolicy: vi.fn(),
    saveBuildPolicy: vi.fn(),
}))

vi.mock('@/services/systemStatusService', async () => {
    const actual = await vi.importActual<typeof import('@/services/systemStatusService')>('@/services/systemStatusService')
    return {
        ...actual,
        systemStatusService: { ...actual.systemStatusService, buildPolicy, saveBuildPolicy },
    }
})

import { BuildPolicyCard } from './BuildPolicyCard'
import type { BuildPolicy, BuildPolicyField } from '@/services/systemStatusService'

const GB = 1024 ** 3

function setting(wire: string, kind: BuildPolicyField['kind'], section: BuildPolicyField['section'], label: string,
                 over: Partial<BuildPolicyField> = {}): BuildPolicyField {
    return { wire, kind, section, label, help: `${label}: what it does.`, unit: null, min: null, max: null,
             choices: null, applies: 'next', ...over }
}

const FIELDS: BuildPolicyField[] = [
    setting('buildAboveRows', 'int', 'when', 'Build beside above', { unit: 'rows', min: 1_000, max: 100_000_000,
        help: 'A publish that changes more rows than this is built in a second key.' }),
    setting('buildForRebuilds', 'bool', 'when', 'Rebuilds and moves too'),
    setting('buildMode', 'choice', 'room', 'How a build makes its key', { choices: ['auto', 'copy', 'reseed'] }),
    setting('copyMarginPct', 'int', 'room', 'Room a copy needs', { unit: 'pct', min: 100, max: 400 }),
    setting('copyMaxBytes', 'int', 'room', 'Largest graph copied', { unit: 'bytes', min: 0, max: 16 * 1024 ** 4 }),
    setting('noRoomPolicy', 'choice', 'room', 'With no room', { choices: ['wait', 'in_place'] }),
    setting('noRoomAlertSecs', 'int', 'room', 'Alert after waiting', { unit: 'secs', min: 300, max: 86_400 }),
    setting('buildConcurrency', 'int', 'lifecycle', 'Builds at once per worker', { unit: 'count', min: 1, max: 8 }),
    setting('retireGraceSecs', 'int', 'lifecycle', 'Keep the previous key for',
        { unit: 'secs', min: 60, max: 86_400, applies: 'switch' }),
    setting('statementTargetMs', 'int', 'pacing', 'Write statement target',
        { unit: 'ms', min: 100, max: 10_000, applies: 'live' }),
    setting('pacingRatio', 'ratio', 'pacing', 'Pause after each write', { unit: 'ratio', min: 0, max: 5, applies: 'live' }),
    setting('pgReadsPerGraph', 'int', 'postgres', 'Reads at once per graph',
        { unit: 'count', min: 1, max: 64, applies: 'live' }),
    setting('pgReadsPerProcess', 'int', 'postgres', 'Reads at once per process',
        { unit: 'count', min: 1, max: 64, applies: 'live' }),
]

function value(def: number | boolean | string, saved: number | boolean | string | null = null) {
    return { saved, default: def, effective: saved ?? def }
}

function policy(rest: Partial<BuildPolicy> = {}): BuildPolicy {
    return {
        values: {
            buildAboveRows: value(200_000),
            buildForRebuilds: value(true),
            buildMode: value('auto'),
            copyMarginPct: value(130, 150),
            copyMaxBytes: value(0),
            noRoomPolicy: value('wait'),
            noRoomAlertSecs: value(1800),
            buildConcurrency: value(2),
            retireGraceSecs: value(900),
            statementTargetMs: value(500),
            pacingRatio: value(0.25),
            pgReadsPerGraph: value(4),
            pgReadsPerProcess: value(8),
        },
        fields: FIELDS,
        updatedBy: 'usr_ops', updatedAt: '2026-11-13T10:00:00Z',
        enabled: true,
        ...rest,
    }
}

function renderCard() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter><BuildPolicyCard /></MemoryRouter>
        </QueryClientProvider>,
    )
}

const field = (name: string) => screen.getByRole('group', { name })
const number = (name: string) => within(field(name)).getByRole('spinbutton')
const fieldsIn = (section: string) =>
    within(screen.getByRole('group', { name: section })).getAllByRole('group').map(g => g.getAttribute('aria-label'))

async function edit(name: string, text: string) {
    await userEvent.clear(number(name))
    await userEvent.type(number(name), text)
}

beforeEach(() => {
    buildPolicy.mockReset().mockResolvedValue(policy())
    saveBuildPolicy.mockReset().mockResolvedValue(policy())
})

describe('BuildPolicyCard', () => {
    it("renders the server's settings under their sections, each with its value in force, default and mark", async () => {
        const unseen = setting('futureKnob', 'int', 'lifecycle', 'A setting the card has never seen',
            { unit: 'count', min: 0, max: 9 })
        buildPolicy.mockResolvedValue(policy({
            fields: [...FIELDS, unseen],
            values: { ...policy().values, futureKnob: value(3) },
        }))
        renderCard()
        await screen.findByRole('group', { name: 'When to build beside' })

        expect(screen.getAllByRole('heading', { level: 4 }).map(h => h.textContent)).toEqual([
            'When to build beside', 'Room and copies', 'Lifecycle', 'Pacing projector writes', 'Reads from Postgres',
        ])
        expect(fieldsIn('When to build beside')).toEqual(['Build beside above', 'Rebuilds and moves too'])
        expect(fieldsIn('Room and copies')).toEqual([
            'How a build makes its key', 'Room a copy needs', 'Largest graph copied', 'With no room', 'Alert after waiting',
        ])
        expect(fieldsIn('Lifecycle')).toEqual([
            'Builds at once per worker', 'Keep the previous key for', 'A setting the card has never seen',
        ])
        expect(fieldsIn('Pacing projector writes')).toEqual(['Write statement target', 'Pause after each write'])
        expect(fieldsIn('Reads from Postgres')).toEqual(['Reads at once per graph', 'Reads at once per process'])

        const above = field('Build beside above')
        expect(above).toHaveTextContent('A publish that changes more rows than this is built in a second key.')
        expect(number('Build beside above')).toHaveValue(200_000)
        expect(above).toHaveTextContent('rows')
        expect(above).toHaveTextContent('Default: 200,000 rows')
        expect(within(above).getByText('Default')).toBeInTheDocument()
        expect(within(above).getByRole('button', { name: 'Reset to default' })).toBeDisabled()

        const margin = field('Room a copy needs')
        expect(number('Room a copy needs')).toHaveValue(150)
        expect(margin).toHaveTextContent('Default: 130 %')
        expect(within(margin).getByText('Set here')).toBeInTheDocument()
        expect(within(margin).getByRole('button', { name: 'Reset to default' })).toBeEnabled()

        expect(within(field('Rebuilds and moves too')).getByRole('switch')).toHaveAttribute('aria-checked', 'true')
        expect(field('Rebuilds and moves too')).toHaveTextContent('Default: On')
        const mode = within(field('How a build makes its key')).getByRole('combobox')
        expect(within(mode).getAllByRole('option').map(o => o.textContent)).toEqual([
            'Copy if room, else seed from Postgres', 'Copy only', 'Seed from Postgres',
        ])
        expect(mode).toHaveDisplayValue('Copy if room, else seed from Postgres')
        expect(within(within(field('With no room')).getByRole('combobox')).getAllByRole('option').map(o => o.textContent))
            .toEqual(['Wait, keep serving the current version', 'Write in place, paced'])

        expect(number('Largest graph copied')).toHaveValue(0)
        expect(within(field('Largest graph copied')).getByRole('combobox', { name: 'Largest graph copied (unit)' })).toHaveDisplayValue('MB')
        expect(field('Largest graph copied')).toHaveTextContent('Default: 0 bytes')
        expect(number('Alert after waiting')).toHaveValue(30)
        expect(within(field('Alert after waiting')).getByRole('combobox')).toHaveDisplayValue('min')
        expect(field('Alert after waiting')).toHaveTextContent('Default: 30 minutes')
        expect(number('Write statement target')).toHaveValue(500)
        expect(field('Write statement target')).toHaveTextContent('Default: 500 ms')
        expect(number('Pause after each write')).toHaveValue(0.25)
        expect(field('Pause after each write')).toHaveTextContent('Default: 0.25')
        expect(number('A setting the card has never seen')).toHaveValue(3)

        expect(screen.getByText(/Last changed by usr_ops/)).toBeInTheDocument()
    })

    it('saves only the values that change, behind a confirmation that lists each from → to', async () => {
        renderCard()
        await screen.findByRole('group', { name: 'Build beside above' })
        await edit('Build beside above', '500000')
        await edit('Builds at once per worker', '2')   // the value in force: not a change
        await userEvent.click(within(field('Rebuilds and moves too')).getByRole('switch'))
        await userEvent.selectOptions(within(field('With no room')).getByRole('combobox'), 'in_place')
        await edit('Write statement target', '250')
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))

        const dialog = await screen.findByRole('dialog')
        const items = within(dialog).getAllByRole('listitem')
        expect(items).toHaveLength(4)
        expect(items[0]).toHaveTextContent('Build beside above: 200,000 rows → 500,000 rows')
        expect(items[0]).toHaveTextContent('Builds already under way keep their settings.')
        expect(items[1]).toHaveTextContent('Rebuilds and moves too: On → Off')
        expect(items[2]).toHaveTextContent('With no room: Wait, keep serving the current version → Write in place, paced')
        expect(items[3]).toHaveTextContent('Write statement target: 500 ms → 250 ms')
        expect(items[3]).not.toHaveTextContent('under way')   // read at every statement, not per build
        expect(saveBuildPolicy).not.toHaveBeenCalled()

        await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
        expect(saveBuildPolicy).toHaveBeenCalledWith({
            buildAboveRows: 500_000, buildForRebuilds: false, noRoomPolicy: 'in_place', statementTargetMs: 250,
        })
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        await waitFor(() => expect(buildPolicy).toHaveBeenCalledTimes(2))   // read again once saved
    })

    it('resets a value to its default by saving -1', async () => {
        renderCard()
        const margin = await screen.findByRole('group', { name: 'Room a copy needs' })
        await userEvent.click(within(margin).getByRole('button', { name: 'Reset to default' }))
        expect(number('Room a copy needs')).toHaveValue(130)
        expect(within(margin).getByRole('button', { name: 'Reset to default' })).toBeDisabled()
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))

        const dialog = await screen.findByRole('dialog')
        expect(dialog).toHaveTextContent('Room a copy needs: 150 % → 130 % (default)')
        await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
        expect(saveBuildPolicy).toHaveBeenCalledWith({ copyMarginPct: -1 })
    })

    it('shows a value the server refuses next to the field it names', async () => {
        renderCard()
        await screen.findByRole('group', { name: 'Reads at once per graph' })
        await edit('Reads at once per graph', '16')
        saveBuildPolicy.mockRejectedValueOnce(Object.assign(new Error('422'), {
            status: 422,
            detail: { type: 'invalid_build_policy', field: 'pgReadsPerGraph',
                message: 'reads at once per graph (16) may not be more than per process (8)' },
        }))
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))
        await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save' }))

        expect(await within(field('Reads at once per graph')).findByText(
            'reads at once per graph (16) may not be more than per process (8)')).toBeInTheDocument()
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(number('Reads at once per graph')).toHaveValue(16)   // kept, to be fixed
    })

    it('refuses a value out of its range, or not whole, before sending it', async () => {
        renderCard()
        await screen.findByRole('group', { name: 'Build beside above' })
        await edit('Build beside above', '10')
        await edit('Alert after waiting', '2')   // 2 minutes, under the 5 the server allows
        await edit('Builds at once per worker', '1.5')
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))

        expect(within(field('Build beside above')).getByText('Enter a value from 1,000 rows to 100,000,000 rows')).toBeInTheDocument()
        expect(within(field('Alert after waiting')).getByText('Enter a value from 5 minutes to 24 hours')).toBeInTheDocument()
        expect(within(field('Builds at once per worker')).getByText('Enter a whole number')).toBeInTheDocument()
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(saveBuildPolicy).not.toHaveBeenCalled()
    })

    it('enters a size in MB, GB or TB and a duration in s, min or h, and saves bytes and seconds', async () => {
        renderCard()
        const grace = await screen.findByRole('group', { name: 'Keep the previous key for' })
        // An untouched value only shows in the new unit: 15 minutes is 900 seconds, and nothing to save.
        await userEvent.selectOptions(within(grace).getByRole('combobox'), 's')
        expect(number('Keep the previous key for')).toHaveValue(900)
        expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

        const copied = within(field('Largest graph copied')).getByRole('combobox', { name: 'Largest graph copied (unit)' })
        await userEvent.selectOptions(copied, 'GB')
        await edit('Largest graph copied', '2')
        // An edit is converted with its unit: 2 GB is 2,048 MB.
        await userEvent.selectOptions(copied, 'MB')
        expect(number('Largest graph copied')).toHaveValue(2048)
        await userEvent.selectOptions(copied, 'GB')
        expect(number('Largest graph copied')).toHaveValue(2)
        await edit('Alert after waiting', '15')   // in minutes, its unit for 1,800 seconds
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))

        const dialog = await screen.findByRole('dialog')
        expect(dialog).toHaveTextContent('Largest graph copied: 0 bytes → 2 GB')
        expect(dialog).toHaveTextContent('Alert after waiting: 30 minutes → 15 minutes')
        await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
        expect(saveBuildPolicy).toHaveBeenCalledWith({ copyMaxBytes: 2 * GB, noRoomAlertSecs: 900 })
    })

    it('says when New-version builds is off, and links to where it is turned on', async () => {
        buildPolicy.mockResolvedValue(policy({ enabled: false }))
        renderCard()
        const link = await screen.findByRole('link', { name: 'Admin → Features' })
        expect(link).toHaveAttribute('href', '/admin/features')
        expect(link.closest('p')).toHaveTextContent('New-version builds is off — turn it on under Admin → Features')
        expect(screen.queryByText('On')).not.toBeInTheDocument()
    })

    it('says when New-version builds is on', async () => {
        renderCard()
        expect(await screen.findByText('On')).toBeInTheDocument()
        expect(screen.queryByText(/New-version builds is off/)).not.toBeInTheDocument()
        expect(screen.queryByRole('link', { name: 'Admin → Features' })).not.toBeInTheDocument()
    })
})
