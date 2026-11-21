/**
 * The assistant's settings: redaction patterns are checked as they are
 * typed (Python spellings included), numbers stay in the server's ranges,
 * and Save first says what changes — louder when more would leave the
 * platform — before anything is saved.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AiSettings, Connection } from '@/services/aiAdminService'
import { AssistantTab } from '../assistant/AssistantTab'
import {
    draftFromSettings, patternError, settingsChanges, settingsErrors, whatLeaves,
} from '../assistant/assistantSettings'

const { svc, notify } = vi.hoisted(() => ({
    svc: { getSettings: vi.fn(), listConnections: vi.fn(), saveSettings: vi.fn() },
    notify: vi.fn(),
}))
vi.mock('@/services/aiAdminService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/services/aiAdminService')>()
    return { ...actual, aiAdminService: svc }
})
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))

const SETTINGS: AiSettings = {
    chatConnectionId: 'llm_1', fastConnectionId: null, embeddingConnectionId: null,
    personas: { data: true, help: true },
    dataPolicy: { sendDescriptions: true, sendPropertyValues: true, sendSampleValues: false, maxResultRows: 25, redactPatterns: ['\\b\\d{16}\\b'] },
    limits: { maxStepsPerTurn: 8, dailyTokensPerUser: 400000, maxConcurrentTurnsPerUser: 2 },
    retentionDays: 30, updatedBy: 'ada@example.com', updatedAt: '2026-11-20T10:00:00Z',
}
const CONNECTIONS = [{ id: 'llm_1', name: 'Corp gateway', enabled: true, models: { chat: 'gpt-4o' } }] as Connection[]

describe('redaction patterns', () => {
    it('accepts ordinary and Python-only spellings', () => {
        expect(patternError('\\b\\d{3}-\\d{2}-\\d{4}\\b')).toBeNull()
        expect(patternError('(?i)secret[-_ ]?key')).toBeNull()
        expect(patternError('(?P<card>\\d{4})-(?P=card)')).toBeNull()
    })

    it('names what is wrong with a broken one, or an empty row', () => {
        expect(patternError('([a-z]+')).toMatch(/^Not a valid pattern/)
        expect(patternError('*abc')).toMatch(/^Not a valid pattern/)
        expect(patternError('  ')).toBe('Enter a pattern, or remove this row.')
    })

    it('flags each broken pattern by its row, and too many of them', () => {
        const d = { ...draftFromSettings(SETTINGS), redactPatterns: ['ok', '(', 'fine'] }
        expect(settingsErrors(d).patterns).toEqual({ 1: expect.stringMatching(/^Not a valid pattern/) })
        expect(settingsErrors({ ...d, redactPatterns: Array.from({ length: 33 }, () => 'x') }).redactPatterns).toBe('At most 32 patterns.')
    })
})

describe('settings validation and the summary', () => {
    it('holds every number to the server’s range', () => {
        const d = draftFromSettings(SETTINGS)
        expect(settingsErrors(d)).toEqual({})
        const e = settingsErrors({ ...d, maxResultRows: '0', maxStepsPerTurn: '17', dailyTokensPerUser: '1.5', retentionDays: '' })
        expect(Object.keys(e).sort()).toEqual(['dailyTokensPerUser', 'maxResultRows', 'maxStepsPerTurn', 'retentionDays'])
    })

    it('marks the changes that let more leave the platform', () => {
        const saved = draftFromSettings(SETTINGS)
        const changes = settingsChanges(saved, { ...saved, sendSampleValues: true, redactPatterns: [], maxStepsPerTurn: '4' }, CONNECTIONS)
        expect(changes.filter(c => c.widens).map(c => c.label)).toEqual(['Sample values', 'Redaction patterns'])
        expect(changes.find(c => c.label === 'Steps per answer')).toMatchObject({ from: '8', to: '4' })
    })

    it('says what leaves the platform and what stays', () => {
        const { sent, withheld } = whatLeaves(draftFromSettings(SETTINGS))
        expect(sent.join(' ')).toMatch(/Descriptions/)
        expect(sent.join(' ')).toMatch(/At most 25 rows/)
        expect(sent.join(' ')).toMatch(/redaction pattern is replaced/)
        expect(withheld.join(' ')).toMatch(/Sample values/)
        expect(withheld.join(' ')).toMatch(/cannot open/)
    })
})

describe('the Assistant tab', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        svc.getSettings.mockResolvedValue(SETTINGS)
        svc.listConnections.mockResolvedValue(CONNECTIONS)
        svc.saveSettings.mockImplementation(async (patch: object) => ({ ...SETTINGS, ...patch, updatedAt: '2026-11-21T10:00:00Z' }))
    })

    const renderTab = () => render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <AssistantTab />
        </QueryClientProvider>,
    )

    it('shows a broken pattern’s problem as it is typed, and will not save it', async () => {
        renderTab()
        await userEvent.click(await screen.findByRole('button', { name: /add a pattern/i }))
        await userEvent.type(screen.getByLabelText('Redaction pattern 2'), '[[')
        expect(screen.getByRole('alert')).toHaveTextContent(/Not a valid pattern/)
        expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    })

    it('previews the change, warns that more leaves the platform, and saves only on confirm', async () => {
        renderTab()
        await userEvent.click(await screen.findByRole('checkbox', { name: /send sample values/i }))
        expect(screen.getByRole('complementary', { name: 'What leaves the platform' })).toHaveTextContent('Sample values from columns.')
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))

        const dialog = await screen.findByRole('dialog', { name: 'Save the assistant settings' })
        expect(dialog).toHaveTextContent('Sample values: not sent → sent')
        expect(dialog).toHaveTextContent(/More leaves the platform.*sample values/)
        expect(svc.saveSettings).not.toHaveBeenCalled()

        await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
        await waitFor(() => expect(svc.saveSettings).toHaveBeenCalledTimes(1))
        expect(svc.saveSettings.mock.calls[0][0]).toMatchObject({
            chatConnectionId: 'llm_1',
            dataPolicy: { sendSampleValues: true, maxResultRows: 25, redactPatterns: ['\\b\\d{16}\\b'] },
            limits: { maxStepsPerTurn: 8 },
            retentionDays: 30,
        })
        expect(notify).toHaveBeenCalledWith('success', 'Saved the assistant settings')
    })
})
