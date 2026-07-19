/**
 * F9 cadence controls — the per-source override row in the drawer and the
 * platform-admin global cadence popover. The drawer shows the RESOLVED value +
 * its source and its editor fires the freshness-settings PATCH; the popover
 * loads the persisted cadence and its Save fires the settings PUT (cadence
 * only).
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSourceDoc, patchFreshnessSettings, getAggregationSettings, putAggregationCadence, permissionFn } = vi.hoisted(() => ({
    getSourceDoc: vi.fn(),
    patchFreshnessSettings: vi.fn(),
    getAggregationSettings: vi.fn(),
    putAggregationCadence: vi.fn(),
    permissionFn: vi.fn(),
}))

vi.mock('@/store/auth', () => ({
    usePermission: (perm: string, workspaceId?: string | null) => permissionFn(perm, workspaceId),
}))

vi.mock('@/services/freshnessService', async () => {
    const actual = await vi.importActual<typeof import('@/services/freshnessService')>('@/services/freshnessService')
    return {
        ...actual,
        freshnessService: { ...actual.freshnessService, getSourceDoc, patchFreshnessSettings },
    }
})

vi.mock('@/services/aggregationService', async () => {
    const actual = await vi.importActual<typeof import('@/services/aggregationService')>('@/services/aggregationService')
    return {
        ...actual,
        aggregationService: { ...actual.aggregationService, getAggregationSettings, putAggregationCadence },
    }
})

import { FreshnessDrawer } from './FreshnessDrawer'
import { CadenceSettingsDialog } from './CadenceSettingsDialog'

function wrap(node: React.ReactNode) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

function makeDoc(over: Record<string, unknown> = {}) {
    return {
        dataSourceId: 'ds-1', workspaceId: 'ws-1', name: 'Orders', providerName: 'Warehouse',
        aggregationStatus: 'ready', events: [],
        rebuildOverrideSecs: null, resolvedRebuildIntervalSecs: 900, rebuildIntervalSource: 'default',
        ...over,
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    permissionFn.mockReturnValue(true)
})

describe('drawer rebuild-cadence row', () => {
    it('shows the resolved value and its source', async () => {
        getSourceDoc.mockResolvedValue(makeDoc({
            rebuildOverrideSecs: 3600, resolvedRebuildIntervalSecs: 3600, rebuildIntervalSource: 'custom',
        }))
        wrap(<FreshnessDrawer dsId="ds-1" isOpen onClose={() => {}} />)

        expect(await screen.findByText('Rebuild cadence')).toBeInTheDocument()
        expect(screen.getByText('Custom')).toBeInTheDocument()
        // 3600s → "1h" in the resolved-value copy.
        expect(screen.getByText('1h')).toBeInTheDocument()
    })

    it('edit fires the PATCH with the interval in seconds', async () => {
        getSourceDoc.mockResolvedValue(makeDoc())
        patchFreshnessSettings.mockResolvedValue({ dataSourceId: 'ds-1', rebuildMinIntervalSecs: 300 })
        wrap(<FreshnessDrawer dsId="ds-1" isOpen onClose={() => {}} />)

        const input = await screen.findByLabelText('Rebuild cadence override (minutes)')
        await userEvent.clear(input)
        await userEvent.type(input, '5')
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))

        await waitFor(() => expect(patchFreshnessSettings).toHaveBeenCalledWith(
            'ds-1', { rebuildMinIntervalSecs: 300 },
        ))
    })

    it('hides the editor without ds:manage', async () => {
        permissionFn.mockReturnValue(false)
        getSourceDoc.mockResolvedValue(makeDoc())
        wrap(<FreshnessDrawer dsId="ds-1" isOpen onClose={() => {}} />)

        expect(await screen.findByText('Rebuild cadence')).toBeInTheDocument()
        expect(screen.queryByLabelText('Rebuild cadence override (minutes)')).not.toBeInTheDocument()
    })

    it('hides the editor for a never-built source (no state row → would 404)', async () => {
        getSourceDoc.mockResolvedValue(makeDoc({
            lastAggregatedAt: null, aggregationStatus: 'none',
        }))
        wrap(<FreshnessDrawer dsId="ds-1" isOpen onClose={() => {}} />)

        expect(await screen.findByText('Rebuild cadence')).toBeInTheDocument()
        expect(screen.queryByLabelText('Rebuild cadence override (minutes)')).not.toBeInTheDocument()
        expect(screen.getByText(/once this source has been built/i)).toBeInTheDocument()
    })
})

describe('admin cadence popover', () => {
    it('seeds from the persisted cadence and Save fires the cadence PUT', async () => {
        getAggregationSettings.mockResolvedValue({
            tuning: null, cadence: { rebuildMinIntervalSecs: 600, driftAutoRebuild: false },
            envRebuildMinIntervalSecs: 900, envDriftAutoRebuild: true,
        })
        putAggregationCadence.mockResolvedValue({ tuning: null, cadence: { rebuildMinIntervalSecs: 120, driftAutoRebuild: false } })
        wrap(<CadenceSettingsDialog isOpen onClose={() => {}} />)

        const input = await screen.findByLabelText('Minimum minutes between automatic rebuilds')
        // Seeded to 600s → 10 minutes.
        await waitFor(() => expect(input).toHaveValue(10))

        await userEvent.clear(input)
        await userEvent.type(input, '2')
        await userEvent.click(screen.getByRole('button', { name: 'Save' }))

        await waitFor(() => expect(putAggregationCadence).toHaveBeenCalledWith(
            { rebuildMinIntervalSecs: 120, driftAutoRebuild: false },
        ))
    })

    it('no persisted cadence: a plain Save round-trips the env defaults (no drift clobber)', async () => {
        // Deploy env has drift-auto OFF and no persisted cadence. The toggle
        // must seed from the env default (false), so an interval-only Save does
        // NOT flip drift-auto on fleet-wide.
        getAggregationSettings.mockResolvedValue({
            tuning: null, cadence: null,
            envRebuildMinIntervalSecs: 900, envDriftAutoRebuild: false,
        })
        putAggregationCadence.mockResolvedValue({ tuning: null, cadence: null })
        wrap(<CadenceSettingsDialog isOpen onClose={() => {}} />)

        const toggle = await screen.findByLabelText(/Automatically rebuild a source when drift is detected/i)
        await waitFor(() => expect(toggle).not.toBeChecked())

        await userEvent.click(screen.getByRole('button', { name: 'Save' }))

        await waitFor(() => expect(putAggregationCadence).toHaveBeenCalledWith(
            { rebuildMinIntervalSecs: null, driftAutoRebuild: false },
        ))
    })
})
