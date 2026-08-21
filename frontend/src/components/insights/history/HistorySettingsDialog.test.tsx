import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getRetention = vi.fn()
const setRetention = vi.fn()
const getAlertPolicy = vi.fn()
const setAlertPolicy = vi.fn()
const useAnyPermission = vi.fn()

vi.mock('@/services/insightsHistoryService', async () => {
    const actual = await vi.importActual<
        typeof import('@/services/insightsHistoryService')
    >('@/services/insightsHistoryService')
    return {
        ...actual,
        insightsHistoryService: {
            getRetention: () => getRetention(),
            setRetention: (body: unknown) => setRetention(body),
            getAlertPolicy: () => getAlertPolicy(),
            setAlertPolicy: (body: unknown) => setAlertPolicy(body),
        },
    }
})
vi.mock('@/store/auth', () => ({
    useAnyPermission: (perms: string[]) => useAnyPermission(perms),
}))

import { HistorySettingsDialog } from './HistorySettingsDialog'

const ALERT_POLICY = {
    enabled: null,
    minSeverity: null,
    cooldownSecs: null,
    envEnabled: true,
    envMinSeverity: 'severe' as const,
    envCooldownSecs: 21600,
    effectiveEnabled: true,
    effectiveMinSeverity: 'severe' as const,
    effectiveCooldownSecs: 21600,
}

const POLICY = {
    retentionDays: null,
    maxRowsPerSource: 5000,
    heartbeatSecs: null,
    envRetentionDays: 90,
    envMaxRowsPerSource: 5000,
    envHeartbeatSecs: 3600,
    effectiveRetentionDays: 90,
    effectiveMaxRowsPerSource: 5000,
    effectiveHeartbeatSecs: 3600,
    enabled: true,
}

function renderDialog(onClose = vi.fn()) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return {
        onClose,
        ...render(
            <QueryClientProvider client={qc}>
                <HistorySettingsDialog onClose={onClose} />
            </QueryClientProvider>,
        ),
    }
}

describe('HistorySettingsDialog — retention', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        getRetention.mockResolvedValue(POLICY)
        setRetention.mockResolvedValue(POLICY)
        getAlertPolicy.mockResolvedValue(ALERT_POLICY)
        setAlertPolicy.mockResolvedValue(ALERT_POLICY)
        useAnyPermission.mockReturnValue(true)
    })

    it('seeds each field from persisted ?? env, showing the default as a placeholder', async () => {
        renderDialog()
        await screen.findByText('Keep history for')

        const retention = screen.getByRole('spinbutton', { name: /keep history for/i })
        // Nothing persisted → blank, with the inherited default as the hint.
        expect(retention).toHaveValue(null)
        expect(retention).toHaveAttribute('placeholder', '90')

        const cap = screen.getByRole('spinbutton', { name: /keep at most/i })
        expect(cap).toHaveValue(5000)
    })

    it('says which fields are inheriting and which are overriding', async () => {
        renderDialog()
        await screen.findByText('Keep history for')
        expect(screen.getAllByText(/inheriting the deployment default/i).length).toBe(2)
        expect(screen.getByText(/overriding the deployment default of 5,000/i))
            .toBeInTheDocument()
    })

    it('sends the inherit sentinel for a blank field, not null', async () => {
        const { onClose } = renderDialog()
        await screen.findByText('Keep history for')

        await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
        await waitFor(() => expect(setRetention).toHaveBeenCalled())
        // -1 is "reset to the env default"; absent and null are the same thing
        // over JSON, so a blank field has to say so explicitly.
        expect(setRetention).toHaveBeenCalledWith({
            retentionDays: -1, maxRowsPerSource: 5000, heartbeatSecs: -1,
        })
        await waitFor(() => expect(onClose).toHaveBeenCalled())
    })

    it('sends an edited value as an override', async () => {
        renderDialog()
        await screen.findByText('Keep history for')

        const retention = screen.getByRole('spinbutton', { name: /keep history for/i })
        await userEvent.type(retention, '30')
        await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

        await waitFor(() => expect(setRetention).toHaveBeenCalled())
        expect(setRetention.mock.calls[0][0].retentionDays).toBe(30)
    })

    it('blocks a save below the floor rather than letting it become a purge', async () => {
        renderDialog()
        await screen.findByText('Keep history for')

        await userEvent.type(
            screen.getByRole('spinbutton', { name: /keep history for/i }), '0',
        )
        expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
    })

    it('reports what is actually in force', async () => {
        renderDialog()
        expect(await screen.findByText(/90 days/)).toBeInTheDocument()
        expect(screen.getByText(/whichever bites first/i)).toBeInTheDocument()
    })

    it('warns when capture is switched off entirely', async () => {
        getRetention.mockResolvedValue({ ...POLICY, enabled: false })
        renderDialog()
        expect(await screen.findByText(/nothing is being recorded/i)).toBeInTheDocument()
    })

    it('is read-only without system admin, but still explains itself', async () => {
        useAnyPermission.mockReturnValue(false)
        renderDialog()
        await screen.findByText('Keep history for')

        expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull()
        expect(screen.getByRole('spinbutton', { name: /keep history for/i })).toBeDisabled()
        // The explanation is the valuable half for everyone else.
        expect(screen.getByText(/what is kept, and what is worth interrupting/i))
            .toBeInTheDocument()
        expect(screen.getByText(/needs system admin/i)).toBeInTheDocument()
    })
})


describe('HistorySettingsDialog — alerting', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        getRetention.mockResolvedValue(POLICY)
        setRetention.mockResolvedValue(POLICY)
        getAlertPolicy.mockResolvedValue(ALERT_POLICY)
        setAlertPolicy.mockResolvedValue(ALERT_POLICY)
        useAnyPermission.mockReturnValue(true)
    })

    it('shows the severity choice and which one is in force', async () => {
        renderDialog()
        expect(await screen.findByText(/alert on unusual movement/i)).toBeInTheDocument()

        const severe = screen.getByRole('button', { name: /only extreme movements/i })
        expect(severe).toHaveAttribute('aria-pressed', 'true')
        expect(screen.getByRole('button', { name: /anything unusual/i }))
            .toHaveAttribute('aria-pressed', 'false')
    })

    it('states the cooldown in the terms the operator set it in', async () => {
        renderDialog()
        expect(await screen.findByText('6h')).toBeInTheDocument()
        expect(screen.getByText(/pager storm/i)).toBeInTheDocument()
    })

    it('widens the floor on request', async () => {
        renderDialog()
        await screen.findByText(/alert on unusual movement/i)

        await userEvent.click(screen.getByRole('button', { name: /anything unusual/i }))
        await waitFor(() => expect(setAlertPolicy).toHaveBeenCalledWith({
            minSeverity: 'notable',
        }))
    })

    it('turns alerting off without touching retention', async () => {
        renderDialog()
        await screen.findByText(/alert on unusual movement/i)

        await userEvent.click(screen.getByRole('switch', { name: /alert on unusual movement/i }))
        await waitFor(() => expect(setAlertPolicy).toHaveBeenCalledWith({ enabled: false }))
        // Coupling the two saves would let a failure in one silently discard
        // the other.
        expect(setRetention).not.toHaveBeenCalled()
    })

    it('hides the severity choice when alerting is off', async () => {
        getAlertPolicy.mockResolvedValue({ ...ALERT_POLICY, effectiveEnabled: false })
        renderDialog()
        await screen.findByText(/alert on unusual movement/i)
        expect(screen.queryByRole('button', { name: /only extreme movements/i })).toBeNull()
    })

    it('is read-only without system admin', async () => {
        useAnyPermission.mockReturnValue(false)
        renderDialog()
        await screen.findByText(/alert on unusual movement/i)
        expect(screen.getByRole('switch', { name: /alert on unusual movement/i }))
            .toBeDisabled()
    })
})
