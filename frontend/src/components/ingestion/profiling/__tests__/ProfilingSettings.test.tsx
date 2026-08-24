/**
 * The policy editor — and the two ways a settings page loses trust.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProfilingPolicy } from '@/types/profiling'

const canRead = vi.fn(() => true)
vi.mock('@/hooks/useProfilingAccess', () => ({
    useCanReadProfiling: () => canRead(),
    useCanEditProfilingPolicy: () => true,
    useIsPlatformOperator: () => true,
    INGESTION_READ_PERMS: [],
}))

const getPolicy = vi.fn()
const setPolicy = vi.fn()
vi.mock('@/services/profilingService', () => ({
    profilingService: {
        getPolicy: (...a: unknown[]) => getPolicy(...a),
        setPolicy: (...a: unknown[]) => setPolicy(...a),
    },
}))

import { ProfilingSettings } from '../ProfilingSettings'

function policy(over: Partial<ProfilingPolicy> = {}): ProfilingPolicy {
    return {
        rawRetentionDays: 7, hourlyRetentionDays: 45, dailyRetentionDays: 400,
        maxRowsPerSource: 10000, heartbeatSecs: 900, silentAfterSecs: 21600,
        alertsEnabled: true, alertMinSeverity: 'severe', alertCooldownSecs: 21600,
        defaults: {
            rawRetentionDays: 7, hourlyRetentionDays: 45, dailyRetentionDays: 400,
            maxRowsPerSource: 10000, heartbeatSecs: 900, silentAfterSecs: 21600,
            alertMinSeverity: 'severe', alertCooldownSecs: 21600,
        },
        overridden: [], editable: true,
        cadences: {
            captureHeartbeatSecs: 900, compactIntervalSecs: 300,
            retentionIntervalSecs: 3600, alertIntervalSecs: 900, readOnly: true,
        },
        ...over,
    }
}

function renderIt() {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })
    return render(
        <QueryClientProvider client={client}>
            <ProfilingSettings onClose={vi.fn()} />
        </QueryClientProvider>,
    )
}

describe('ProfilingSettings', () => {
    beforeEach(() => {
        getPolicy.mockReset()
        setPolicy.mockReset().mockResolvedValue(policy())
        canRead.mockReturnValue(true)
    })

    it('shows every retention tier', async () => {
        getPolicy.mockResolvedValue(policy())
        renderIt()
        expect(await screen.findByRole('spinbutton', { name: /raw observations/i })).toBeInTheDocument()
        expect(screen.getByRole('spinbutton', { name: /hourly buckets/i })).toBeInTheDocument()
        expect(screen.getByRole('spinbutton', { name: /daily buckets/i })).toBeInTheDocument()
        expect(screen.getByRole('spinbutton', { name: /raw rows per source/i })).toBeInTheDocument()
    })

    it('shows a non-admin the VALUES, not a dead form', async () => {
        // Two bugs in one. The READ used to be gated at system:admin while the
        // control was shown to everyone, which gave non-admins a permanent
        // spinner. Then the read-only view rendered disabled inputs seeded
        // with nothing — every box empty, because an unset field has no value
        // to seed. That is a broken form, not an answer to "how long is my
        // history kept".
        getPolicy.mockResolvedValue(policy({ editable: false }))
        renderIt()

        expect(await screen.findByText(/needs a system administrator/i)).toBeInTheDocument()
        expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
        // The value appears in the summary sentence too, which is correct —
        // the assertion is that the ROW carries a reading rather than an
        // empty box.
        expect(screen.getAllByText('45 days').length).toBeGreaterThan(0)
        expect(screen.getByText('15 min')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /save policy/i })).not.toBeInTheDocument()
    })

    it('states what the policy buys, not just what it is set to', async () => {
        getPolicy.mockResolvedValue(policy())
        renderIt()
        expect(await screen.findByText(/observation by observation/i)).toBeInTheDocument()
        expect(screen.getByText(/hour by hour/i)).toBeInTheDocument()
    })

    it('previews the storage cost, and warns when the cap bites first', async () => {
        // A source capturing every 60s for 7 days is 10,080 rows against a
        // 5,000 cap — it keeps ~3.5 days of raw, not 7, and the panel should
        // say so before someone relies on the number they typed.
        getPolicy.mockResolvedValue(policy({
            heartbeatSecs: 60, maxRowsPerSource: 5000,
            overridden: ['heartbeatSecs', 'maxRowsPerSource'],
        }))
        renderIt()
        expect(await screen.findByText(/estimated storage/i)).toBeInTheDocument()
        expect(screen.getByText(/row cap bites before the age cutoff/i)).toBeInTheDocument()
    })

    it('moves the preview as the draft changes, before anything is saved', async () => {
        // A picture that only moves after you commit cannot help you decide
        // whether to commit.
        getPolicy.mockResolvedValue(policy())
        renderIt()

        // The summary sentence is the live read-out of the draft.
        await screen.findByText(/observation by observation/i)
        const summary = () => screen.getByText(/observation by observation/i)
        expect(summary()).toHaveTextContent('45 days')

        await userEvent.type(screen.getByRole('spinbutton', { name: /hourly buckets/i }), '120')
        await waitFor(() => expect(summary()).toHaveTextContent('120 days'))
    })

    it('shows the deployment default as a placeholder, not as a value', async () => {
        // A no-op save must round-trip the real default rather than pinning
        // whatever it happened to be that day.
        getPolicy.mockResolvedValue(policy())
        renderIt()
        const field = await screen.findByRole('spinbutton', { name: /raw observations/i })
        expect(field).toHaveValue(null)
        expect(field).toHaveAttribute('placeholder', '7')
    })

    it('marks the fields an operator has actually set', async () => {
        getPolicy.mockResolvedValue(policy({
            rawRetentionDays: 14, overridden: ['rawRetentionDays'],
        }))
        renderIt()
        expect(await screen.findByText('set')).toBeInTheDocument()
        expect(screen.getByRole('spinbutton', { name: /raw observations/i })).toHaveValue(14)
    })

    it('sends only what changed', async () => {
        getPolicy.mockResolvedValue(policy())
        renderIt()

        const field = await screen.findByRole('spinbutton', { name: /hourly buckets/i })
        await userEvent.type(field, '60')
        await userEvent.click(screen.getByRole('button', { name: /save policy/i }))

        await waitFor(() => expect(setPolicy).toHaveBeenCalled())
        expect(setPolicy).toHaveBeenCalledWith({ hourlyRetentionDays: 60 })
    })

    it('clearing a set field sends the inherit sentinel, not nothing', async () => {
        // Omitting it would leave the old override in place — the opposite of
        // what clearing a box means.
        getPolicy.mockResolvedValue(policy({
            rawRetentionDays: 14, overridden: ['rawRetentionDays'],
        }))
        renderIt()

        await userEvent.clear(await screen.findByRole('spinbutton', { name: /raw observations/i }))
        await userEvent.click(screen.getByRole('button', { name: /save policy/i }))

        await waitFor(() => expect(setPolicy).toHaveBeenCalled())
        expect(setPolicy).toHaveBeenCalledWith({ rawRetentionDays: -1 })
    })

    it('surfaces the backend refusal verbatim', async () => {
        // The backend REFUSES a policy whose tiers do not nest rather than
        // clamping it, and its message names which pair is wrong.
        getPolicy.mockResolvedValue(policy())
        setPolicy.mockRejectedValue(
            new Error('Hourly retention (7d) must reach at least as far back as raw (30d)'),
        )
        renderIt()

        await userEvent.type(await screen.findByRole('spinbutton', { name: /raw observations/i }), '30')
        await userEvent.click(screen.getByRole('button', { name: /save policy/i }))

        expect(await screen.findByText(/must reach at least as far back/i)).toBeInTheDocument()
    })

    it('holds the save when the tiers stop nesting, and says which pair', async () => {
        // The backend refuses this, correctly — but the drawer already has
        // both numbers on screen, so spending a round trip to be told is a
        // round trip wasted. Name the pair as it is typed.
        getPolicy.mockResolvedValue(policy())
        renderIt()

        await userEvent.type(await screen.findByRole('spinbutton', { name: /raw observations/i }), '90')

        expect(
            await screen.findByText(/hourly buckets must reach back at least as far as raw/i),
        ).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /save policy/i })).toBeDisabled()
        expect(setPolicy).not.toHaveBeenCalled()
    })

    it('offers the common answers as one click', async () => {
        getPolicy.mockResolvedValue(policy())
        renderIt()

        await userEvent.click(
            await screen.findByRole('button', { name: /set raw observations to 30 days/i }),
        )
        await userEvent.click(screen.getByRole('button', { name: /save policy/i }))

        await waitFor(() => expect(setPolicy).toHaveBeenCalledWith({ rawRetentionDays: 30 }))
    })

    it('shows the cadences but does not let them be edited', async () => {
        getPolicy.mockResolvedValue(policy())
        renderIt()
        expect(await screen.findByText(/service cadences/i)).toBeInTheDocument()
        expect(screen.getByText('5m')).toBeInTheDocument()
        expect(screen.queryByLabelText(/compaction/i)).not.toBeInTheDocument()
    })

    it('renders nothing without permission', () => {
        canRead.mockReturnValue(false)
        getPolicy.mockResolvedValue(policy())
        const { container } = renderIt()
        expect(container).toBeEmptyDOMElement()
    })
})

describe('ProfilingSettings — alerting', () => {
    beforeEach(() => {
        getPolicy.mockReset()
        setPolicy.mockReset().mockResolvedValue(policy())
        canRead.mockReturnValue(true)
    })

    it('offers the alert policy beside retention, not on another page', async () => {
        // They are one decision in practice: how much evidence to keep and how
        // loudly to react to it.
        getPolicy.mockResolvedValue(policy())
        renderIt()
        expect(await screen.findByRole('switch', { name: /anomaly findings/i })).toBeInTheDocument()
        expect(screen.getByRole('spinbutton', { name: /quiet period/i })).toBeInTheDocument()
    })

    it('sends the switch and the floor when they change', async () => {
        getPolicy.mockResolvedValue(policy())
        renderIt()

        await userEvent.click(await screen.findByRole('button', { name: '3× usual' }))
        await userEvent.click(screen.getByRole('button', { name: /save policy/i }))

        await waitFor(() => expect(setPolicy).toHaveBeenCalled())
        expect(setPolicy).toHaveBeenCalledWith({ alertMinSeverity: 'notable' })
    })

    it('hides the floor when findings are off, because it decides nothing', async () => {
        getPolicy.mockResolvedValue(policy())
        renderIt()

        await userEvent.click(await screen.findByRole('switch', { name: /anomaly findings/i }))
        expect(screen.queryByRole('button', { name: '8× usual' })).not.toBeInTheDocument()
    })

    it('reads the alert policy without a switch for a non-admin', async () => {
        getPolicy.mockResolvedValue(policy({ editable: false, alertMinSeverity: 'notable' }))
        renderIt()
        expect(await screen.findByText('On')).toBeInTheDocument()
        expect(screen.getByText('3× usual')).toBeInTheDocument()
        expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    })
})
