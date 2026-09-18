/**
 * Findings — open now, and what was found before.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Finding } from '@/types/profiling'

vi.mock('@/hooks/useProfilingAccess', () => ({
    useCanReadProfiling: () => true,
    useCanEditProfilingPolicy: () => true,
    useIsPlatformOperator: () => true,
    INGESTION_READ_PERMS: [],
}))

const getFindings = vi.fn()
const acknowledgeMany = vi.fn()
vi.mock('@/services/profilingService', () => ({
    profilingService: {
        getFindings: (...a: unknown[]) => getFindings(...a),
        acknowledge: vi.fn().mockResolvedValue({}),
        acknowledgeMany: (...a: unknown[]) => acknowledgeMany(...a),
    },
}))

import { FindingsBand } from '../FindingsBand'

function finding(over: Partial<Finding> = {}): Finding {
    return {
        id: 'alr_1', data_source_id: 'ds_a',
        detected_at: '2026-08-21T09:20:00Z', observed_at: '2026-08-21T09:14:00Z',
        workspace_id: 'ws_1', workspace_name: 'Platform',
        provider_id: 'prov_1', provider_name: 'Falkor Docker',
        provider_type: 'falkordb',
        data_source_label: 'customers', graph_name: 'customers',
        catalog_item_id: 'cat_1', severity: 'severe', direction: 'drop',
        metric: 'nodes', finding: 'movement', subject_type: null,
        delta: -12400, count: 1191600, baseline: 40, evidence: null,
        acknowledged_at: null, acknowledged_by: null,
        ...over,
    }
}

function renderIt() {
    return renderBand('ds_a')
}

/** The board's mount: no source, so the band covers everything the caller
 *  can see. Its own helper because `renderUnscoped()` would fall through
 *  to the default and silently test the scoped case instead. */
function renderUnscoped() {
    return renderBand(undefined)
}

function renderBand(dataSourceId: string | undefined) {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })
    return render(
        <QueryClientProvider client={client}>
            <FindingsBand dataSourceId={dataSourceId} />
        </QueryClientProvider>,
    )
}

describe('FindingsBand', () => {
    beforeEach(() => {
        getFindings.mockReset()
        acknowledgeMany.mockReset()
        acknowledgeMany.mockResolvedValue({
            alerts: [], total: 1, openCount: 0, offset: 0, limit: 50,
            platform_wide: false, acknowledged: 1,
        })
    })

    it('leads with what is outstanding', async () => {
        getFindings.mockResolvedValue({
            alerts: [finding()], total: 1, openCount: 1, offset: 0, limit: 50,
            platform_wide: false,
        })
        renderIt()
        expect(await screen.findByText(/one finding needs a look/i)).toBeInTheDocument()
        expect(screen.getByText(/against a usual movement of/i)).toBeInTheDocument()
    })

    it('keeps the record after everything is acknowledged', async () => {
        // Showing only unacknowledged findings meant the record vanished the
        // moment someone cleared it — and "has this happened before?" is the
        // second question after every incident.
        getFindings.mockResolvedValue({
            alerts: [], total: 4, openCount: 0, offset: 0, limit: 50,
            platform_wide: false,
        })
        renderIt()
        expect(
            await screen.findByRole('button', { name: /what has been found before/i }),
        ).toBeInTheDocument()
        expect(screen.getByText(/nothing outstanding/i)).toBeInTheDocument()
    })

    it('switches to the history and asks the API for it', async () => {
        getFindings.mockResolvedValue({
            alerts: [finding({
                acknowledged_at: '2026-08-21T10:00:00Z', acknowledged_by: 'RK',
            })],
            total: 1, openCount: 0, offset: 0, limit: 50, platform_wide: false,
        })
        renderIt()

        await userEvent.click(await screen.findByRole('button', { name: 'All' }))
        expect(await screen.findByText(/findings history/i)).toBeInTheDocument()
        expect(getFindings).toHaveBeenCalledWith(
            expect.objectContaining({ openOnly: false }), expect.anything(),
        )
    })

    it('shows an acknowledged finding as a record, not an action', async () => {
        getFindings.mockResolvedValue({
            alerts: [finding({
                acknowledged_at: '2026-08-21T10:00:00Z', acknowledged_by: 'RK',
            })],
            total: 1, openCount: 0, offset: 0, limit: 50, platform_wide: false,
        })
        renderIt()

        await userEvent.click(await screen.findByRole('button', { name: 'All' }))
        expect(await screen.findByText('Seen')).toBeInTheDocument()
        expect(screen.getByText(/by RK/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /mark seen/i })).not.toBeInTheDocument()
    })

    it('stays out of the way when there is nothing to say', async () => {
        getFindings.mockResolvedValue({
            alerts: [], total: 0, openCount: 0, offset: 0, limit: 50,
            platform_wide: false,
        })
        const { container } = renderIt()
        await waitFor(() => expect(getFindings).toHaveBeenCalled())
        await waitFor(() => expect(container.textContent).toBe(''))
    })
})

describe('FindingsBand — marking a whole set seen', () => {
    beforeEach(() => {
        getFindings.mockReset()
        acknowledgeMany.mockReset()
        acknowledgeMany.mockResolvedValue({
            alerts: [], total: 3, openCount: 0, offset: 0, limit: 50,
            platform_wide: true, acknowledged: 47,
        })
    })

    const open = (over = {}) => ({
        alerts: [finding()], total: 3, openCount: 47, offset: 0, limit: 50,
        platform_wide: true, ...over,
    })

    it('clears one source immediately — its blast radius is on screen', async () => {
        getFindings.mockResolvedValue(open())
        renderIt()
        await userEvent.click(
            await screen.findByRole('button', { name: /mark all seen/i }),
        )
        await waitFor(() => expect(acknowledgeMany).toHaveBeenCalledTimes(1))
        // React Query hands the mutationFn a second context argument.
        expect(acknowledgeMany).toHaveBeenCalledWith(
            expect.objectContaining({ dataSourceId: 'ds_a', openOnly: true }),
            expect.anything(),
        )
        expect(screen.queryByText(/clears them for everyone/i)).not.toBeInTheDocument()
    })

    it('asks first when the press covers every source it can see', async () => {
        getFindings.mockResolvedValue(open())
        renderUnscoped()
        await userEvent.click(
            await screen.findByRole('button', { name: /mark all seen/i }),
        )
        // Nothing has happened yet.
        expect(acknowledgeMany).not.toHaveBeenCalled()
        // ...and the two non-obvious consequences are both stated.
        const dialog = await screen.findByRole('dialog')
        expect(dialog).toHaveTextContent(/clears them for everyone/i)
        expect(dialog).toHaveTextContent(/lets retention delete them/i)
    })

    it('counts what it will actually clear, not what is on the page', async () => {
        // The band fetches 50 and the verb clears ALL of them. Quoting
        // findings.length would understate what the button does — here, "1"
        // against the 47 it is about to acknowledge.
        getFindings.mockResolvedValue(open())
        renderUnscoped()
        await userEvent.click(
            await screen.findByRole('button', { name: /mark all seen/i }),
        )
        expect(await screen.findByRole('dialog')).toHaveTextContent(
            /mark 47 findings seen/i,
        )
    })

    it('offers nothing to clear when nothing is open', async () => {
        getFindings.mockResolvedValue(open({ alerts: [], openCount: 0 }))
        renderIt()
        await screen.findByText(/nothing outstanding/i)
        expect(
            screen.queryByRole('button', { name: /mark all seen/i }),
        ).not.toBeInTheDocument()
    })

    it('stays off the history tab, where it would be ambiguous', async () => {
        getFindings.mockResolvedValue(open())
        renderIt()
        await userEvent.click(await screen.findByRole('button', { name: 'All' }))
        await waitFor(() => expect(
            screen.queryByRole('button', { name: /mark all seen/i }),
        ).not.toBeInTheDocument())
    })
})
