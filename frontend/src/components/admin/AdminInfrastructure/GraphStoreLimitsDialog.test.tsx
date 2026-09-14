/**
 * The graph store limits dialog: seeds from the node's own reading, explains
 * the container the sizing formula needs as the ceiling is edited, refuses
 * what the server would refuse before the round trip, confirms with the
 * exact change and the FALKORDB_ARGS fragment that keeps it, shows the
 * server's refusal verbatim, remembers the container figure per node, guards
 * a dirty close, and is read-only for non-admins.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getFleetCapacity, setGraphStoreLimits, permissionFn, notify } = vi.hoisted(() => ({
    getFleetCapacity: vi.fn(),
    setGraphStoreLimits: vi.fn(),
    permissionFn: vi.fn(),
    notify: vi.fn(),
}))

vi.mock('@/store/auth', () => ({
    usePermission: (perm: string) => permissionFn(perm),
}))
vi.mock('@/components/ui/notifications', () => ({
    useAppNotifications: () => ({ notify }),
}))
vi.mock('@/services/aggregationService', async () => {
    const actual = await vi.importActual<typeof import('@/services/aggregationService')>('@/services/aggregationService')
    return {
        ...actual,
        aggregationService: { ...actual.aggregationService, getFleetCapacity, setGraphStoreLimits },
    }
})

import { GraphStoreLimitsDialog } from './GraphStoreLimitsDialog'
import { planLimits, type LimitsDraft } from './graphStoreLimits'
import type { ShardCapacity } from '@/services/aggregationService'

const GB = 2 ** 30
const MB = 2 ** 20

const SHARD: ShardCapacity = {
    endpoint: 'falkor:6379', used: 2 * GB, maxmemory: 6 * GB, policy: 'noeviction', measurable: true,
    usedPct: 33.3, reservePct: 20, reserveBytes: 1.2 * GB, availableBytes: 2.8 * GB, allowedGrowthEdges: 5_000_000,
    governedBy: 'shard', staticCap: 25_000_000, queryMemCapacity: 512 * MB, timeoutMaxMs: 180_000,
    timeoutDefaultMs: 30_000, threadCount: 4, sources: [],
}

function capacity(over: Partial<ShardCapacity> = {}, containerMemoryBytes: number | null = null) {
    return {
        limits: {
            shardReservePct: { value: 20, source: 'default' }, bytesPerEdge: { value: 512, source: 'default' },
            maxMaterializedEdges: { value: null, source: 'default' }, rollupStorage: { value: 'true', source: 'default' },
            estimateMarginPct: 25, maxCubeEdges: 8_000_000, staticCap: 25_000_000, budgetRecheckEdges: 1_000_000,
            containerMemoryBytes,
        },
        shards: [{ ...SHARD, ...over }],
        unresolved: [], sourcesTotal: 1, truncated: false, measuredAt: '2026-09-09T10:00:00Z', cacheAgeMs: 0,
    }
}

function renderDialog(endpoint = 'falkor:6379', onClose = () => {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={qc}>
            <MemoryRouter>
                <GraphStoreLimitsDialog open endpoint={endpoint} onClose={onClose} />
            </MemoryRouter>
        </QueryClientProvider>,
    )
}

const draft = (over: Partial<LimitsDraft> = {}): LimitsDraft => ({
    timeoutS: '180', capMb: '512', containerGb: '', concurrent: '4', applyToAll: false, ...over,
})

beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    permissionFn.mockReturnValue(true)
    getFleetCapacity.mockResolvedValue(capacity())
})

describe('planLimits', () => {
    it('sends nothing while nothing changed, and only what changed', () => {
        expect(planLimits(SHARD, draft()).patch).toBeNull()
        const p = planLimits(SHARD, draft({ timeoutS: '300' }))
        expect(p.patch).toEqual({ timeoutMaxMs: 300_000 })
        expect(p.changes).toEqual([{ name: 'TIMEOUT_MAX', from: '180 s', to: '300 s' }])
        expect(p.fragment).toBe('TIMEOUT_MAX 300000')
    })

    it('refuses a time cap below the node’s default, and out of the store’s range', () => {
        expect(planLimits(SHARD, draft({ timeoutS: '20' })).problems[0]).toMatch(/TIMEOUT_DEFAULT of 30 s/)
        expect(planLimits(SHARD, draft({ timeoutS: '0.5' })).problems[0]).toMatch(/at least 1 s/)
        expect(planLimits(SHARD, draft({ timeoutS: '7200' })).problems[0]).toMatch(/at most one hour/)
    })

    it('needs the container to raise the ceiling, clamps concurrency at the thread count and assumes 4 when unreported', () => {
        const short = planLimits(SHARD, draft({ capMb: '1024', containerGb: '11' }))
        expect(short.patch).toBeNull()
        expect(short.problems[0]).toMatch(/Short by .* 4 concurrent queries/)
        const fits = planLimits(SHARD, draft({ capMb: '1024', containerGb: '11', concurrent: '2' }))
        expect(fits.patch).toEqual({ queryMemCapacity: GB, concurrentQueries: 2, containerMemoryBytes: 11 * GB })
        expect(fits.needed).toBe(Math.floor(1.25 * 6 * GB) + 2 * Math.floor(1.3 * GB) + 256 * MB)
        expect(planLimits(SHARD, draft({ capMb: '1024', containerGb: '64', concurrent: '16' })).concurrent).toBe(4)
        const assumed = planLimits({ ...SHARD, threadCount: null }, draft({ capMb: '1024', containerGb: '64', concurrent: '16' }))
        expect(assumed.threadsAssumed && assumed.concurrent === 4).toBe(true)
        // Lowering needs nothing; 0 is refused.
        expect(planLimits(SHARD, draft({ capMb: '256' })).patch).toEqual({ queryMemCapacity: 256 * MB, concurrentQueries: 4 })
        expect(planLimits(SHARD, draft({ capMb: '0' })).problems[0]).toMatch(/above 0/)
    })
})

describe('GraphStoreLimitsDialog', () => {
    it('seeds every field from the node’s reading and says what is set now', async () => {
        renderDialog()
        expect(await screen.findByLabelText(/query time cap/i)).toHaveValue(180)
        expect(screen.getByLabelText(/per-query memory ceiling/i)).toHaveValue(512)
        expect(screen.getByLabelText(/concurrent queries/i)).toHaveValue(4)
        expect(screen.getByTestId('limits-now')).toHaveTextContent(/TIMEOUT_MAX 180 s · TIMEOUT_DEFAULT 30 s · QUERY_MEM_CAPACITY 512 MB · THREAD_COUNT 4 · maxmemory 6\.0 GB \(33% used\)/)
        expect(screen.getByTestId('limits-readout')).toHaveTextContent(/Needs at least/)
        expect(screen.getByRole('button', { name: /review change/i })).toBeDisabled()
    })

    it('walks a ceiling raise from refusal to the applied fragment', async () => {
        const user = userEvent.setup()
        renderDialog()
        const cap = await screen.findByLabelText(/per-query memory ceiling/i)
        await user.clear(cap)
        await user.type(cap, '1024')
        expect(screen.getByTestId('limits-problems')).toHaveTextContent(/Enter the container memory limit/)
        expect(screen.getByRole('button', { name: /review change/i })).toBeDisabled()

        await user.type(screen.getByLabelText(/container memory limit/i), '11')
        expect(screen.getByTestId('limits-problems')).toHaveTextContent(/Short by/)

        const concurrent = screen.getByLabelText(/concurrent queries/i)
        await user.clear(concurrent)
        await user.type(concurrent, '2')
        expect(screen.queryByTestId('limits-problems')).not.toBeInTheDocument()
        expect(screen.getByTestId('limits-readout')).toHaveTextContent(/Needs at least 10\.3 GB .* the container has 11\.0 GB — fits/)

        await user.click(screen.getByRole('button', { name: /review change/i }))
        expect(screen.getByTestId('limits-changes')).toHaveTextContent(/QUERY_MEM_CAPACITY: 512 MB → 1\.0 GB/)
        expect(screen.getByTestId('limits-args-fragment')).toHaveTextContent('QUERY_MEM_CAPACITY 1073741824')

        setGraphStoreLimits.mockResolvedValue({
            shard: { ...SHARD, queryMemCapacity: GB }, previous: { QUERY_MEM_CAPACITY: 512 * MB },
            applied: { QUERY_MEM_CAPACITY: GB }, appliedTo: ['falkor:6379'], argsFragment: 'QUERY_MEM_CAPACITY 1073741824',
            containerNeededBytes: 11_113_227_878, concurrentQueries: 2, threadCountAssumed: false, measuredAt: 'x',
        })
        await user.click(screen.getByRole('button', { name: /apply now/i }))
        await waitFor(() => expect(setGraphStoreLimits).toHaveBeenCalledWith(
            'falkor:6379', { queryMemCapacity: GB, concurrentQueries: 2, containerMemoryBytes: 11 * GB },
        ))
        expect(await screen.findByTestId('limits-done')).toHaveTextContent(/Applied on falkor:6379: QUERY_MEM_CAPACITY 512 MB → 1\.0 GB/)
        expect(notify).toHaveBeenCalledWith('success', expect.stringMatching(/until the next restart/))
        expect(localStorage.getItem('graphStoreLimits.container.falkor:6379')).toBe('11')
    })

    it('lowers the time cap with nothing else, and shows the server’s refusal verbatim', async () => {
        const user = userEvent.setup()
        renderDialog()
        const timeout = await screen.findByLabelText(/query time cap/i)
        await user.clear(timeout)
        await user.type(timeout, '120')
        expect(screen.queryByTestId('limits-problems')).not.toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: /review change/i }))
        expect(screen.getByTestId('limits-changes')).toHaveTextContent(/TIMEOUT_MAX: 180 s → 120 s/)
        setGraphStoreLimits.mockRejectedValue(new Error('TIMEOUT_MAX 120 s would be below the node’s TIMEOUT_DEFAULT 150 s; the store refuses that.'))
        await user.click(screen.getByRole('button', { name: /apply now/i }))
        expect(await screen.findByTestId('limits-error')).toHaveTextContent(/would be below the node/)
        expect(setGraphStoreLimits).toHaveBeenCalledWith('falkor:6379', { timeoutMaxMs: 120_000 })
        expect(notify).toHaveBeenCalledWith('error', expect.stringMatching(/would be below/))
    })

    it('prefills the container from the deployment, else from what was remembered for this node', async () => {
        localStorage.setItem('graphStoreLimits.container.falkor:6379', '12')
        renderDialog()
        expect(await screen.findByLabelText(/container memory limit/i)).toHaveValue(12)
        expect(screen.getByText(/Remembered from your last change here/)).toBeInTheDocument()
    })

    it('prefers the deployment’s figure when it states one', async () => {
        getFleetCapacity.mockResolvedValue(capacity({}, 10 * GB))
        localStorage.setItem('graphStoreLimits.container.falkor:6379', '12')
        renderDialog()
        expect(await screen.findByLabelText(/container memory limit/i)).toHaveValue(10)
        expect(screen.getByText(/Prefilled from the deployment/)).toBeInTheDocument()
    })

    it('guards a dirty close', async () => {
        const user = userEvent.setup()
        const onClose = vi.fn()
        renderDialog('falkor:6379', onClose)
        const timeout = await screen.findByLabelText(/query time cap/i)
        await user.clear(timeout)
        await user.type(timeout, '300')
        await user.click(screen.getByRole('button', { name: /close graph store limits/i }))
        expect(onClose).not.toHaveBeenCalled()
        expect(screen.getByText(/Discard this limits change\?/)).toBeInTheDocument()
        await user.click(screen.getByRole('button', { name: /^discard$/i }))
        expect(onClose).toHaveBeenCalled()
    })

    it('is read-only for non-admins', async () => {
        permissionFn.mockReturnValue(false)
        renderDialog()
        expect(await screen.findByLabelText(/query time cap/i)).toBeDisabled()
        expect(screen.getByText(/Only platform admins can change/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /review change/i })).not.toBeInTheDocument()
    })

    it('says when the node is not in the sweep', async () => {
        renderDialog('10.9.9.9:6379')
        expect(await screen.findByText(/not in the capacity sweep/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /review change/i })).toBeDisabled()
    })
})
