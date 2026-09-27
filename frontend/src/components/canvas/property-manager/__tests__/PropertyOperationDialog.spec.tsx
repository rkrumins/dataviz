/**
 * PropertyOperationDialog — applies one bulk property operation to the open draft: it asks the
 * server to start the job with the criteria as counted, the operation as typed (a 64-bit integer
 * exact) and the count it showed. Apply is held while the count is unknown, while another
 * operation is being written into the draft, when the criteria match more than a draft may hold,
 * and outside a draft; a refusal from the server is shown in the dialog, which stays open.
 *
 * Data deps mocked: discovery, the graph provider, the match-count service, and the versioning
 * hooks. framer-motion is stubbed (cached per tag) so the embedded VisualQueryBuilder + portal
 * render and inputs keep keystrokes.
 */
import React from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { countMatches } from '@/services/propertyInsights'
import type { PropertyOpList } from '@/services/versioningApiService'
import type { Predicate } from '@/types/search'

import { PropertyOperationDialog, type PropertyOpDraft } from '../PropertyOperationDialog'


vi.mock('framer-motion', () => {
    const cache = new Map<string, React.ComponentType<unknown>>()
    const passthrough = (tag: string) => {
        let cmp = cache.get(tag)
        if (!cmp) {
            cmp = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
                function MotionStub(props, ref) {
                    return React.createElement(tag, { ...props, ref })
                },
            ) as unknown as React.ComponentType<unknown>
            cache.set(tag, cmp)
        }
        return cmp
    }
    return {
        AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
        motion: new Proxy({}, { get: (_t, tag: string) => passthrough(tag) }),
    }
})

vi.mock('@/components/canvas/search/builder/useDiscovery', () => ({
    useDiscovery: () => ({
        allKeys: ['owner'], keysByEntityType: {}, tagValues: [],
        getValueSamples: () => [], edgeTypes: [], keysByEdgeType: {},
        getEdgeValueSamples: () => [], isInitialLoading: false, error: null,
    }),
}))

vi.mock('@/providers/GraphProviderContext', () => {
    // Stable reference — a fresh object each call would make the dialog's
    // count effect re-run every render (a render loop that drops keystrokes).
    const provider = {}
    return { useGraphProvider: () => provider }
})

const counts = { all: 5, narrowed: 2 }
// The narrowed criteria (a fill's "key is empty") count fewer.
const countAsSearchWould = async (_p: unknown, _v: string, predicate: Predicate) =>
    ((predicate as { children?: Array<{ op?: string }> }).children?.some((c) => c.op === 'isEmpty')
        ? counts.narrowed : counts.all)
vi.mock('@/services/propertyInsights', () => ({
    countMatches: vi.fn(),
    countPropertyUsageWithinTarget: vi.fn(async () => 0),
    getValueDistribution: vi.fn(async () => ({ values: [], truncated: false })),
    getAffectedSample: vi.fn(async () => ({ entities: [], truncated: false })),
}))

const watermark = { fresh: true }
const recheck = vi.fn()
vi.mock('@/features/versioning/hooks/useEntityEditing', () => ({
    useEntityEditing: () => ({ offered: true, blocked: null }),
    usePublishedGraphCatchingUp: () => ({ catchingUp: !watermark.fresh, recheck }),
}))

const startMutate = vi.fn()
vi.mock('@/features/versioning/hooks/useVersioning', () => ({
    useStartPropertyOp: () => ({ mutate: startMutate, isPending: false }),
}))

const DRAFT: PropertyOpDraft = { wsId: 'ws1', graphId: 'g1', branchId: 'br1' }
const opsList = (extra: Partial<PropertyOpList> = {}): PropertyOpList =>
    ({ ops: [], draftChanges: 0, maxDraftChanges: 100_000, ...extra })

function renderDialog(props: Partial<React.ComponentProps<typeof PropertyOperationDialog>> = {}) {
    const onClose = vi.fn()
    const dialog = () => (
        <PropertyOperationDialog
            viewId="v1"
            mode="update"
            initialKey="owner"
            knownEntityTypes={['dataset']}
            knownLayers={[]}
            draft={DRAFT}
            ops={opsList()}
            onClose={onClose}
            {...props}
        />
    )
    const { rerender } = render(dialog())
    return { onClose, rerender: () => rerender(dialog()) }
}

const applyButton = () => screen.getByRole('button', { name: /apply to draft/i })

beforeEach(() => {
    startMutate.mockReset()
    counts.all = 5
    counts.narrowed = 2
    watermark.fresh = true
    recheck.mockReset()
    vi.mocked(countMatches).mockReset().mockImplementation(countAsSearchWould)
})


describe('PropertyOperationDialog', () => {
    it('applies a set to the draft: the criteria as counted, the value as typed, the count shown', async () => {
        const user = userEvent.setup()
        startMutate.mockImplementation((body, opts) => opts.onSuccess({ jobId: 'j1', op: body.op }))
        const { onClose } = renderDialog()

        // Key is preset and locked in update mode.
        expect(screen.getByDisplayValue('owner')).toBeInTheDocument()
        await user.type(screen.getByPlaceholderText(/value/i), 'alice')
        await waitFor(() => expect(applyButton()).toBeEnabled())
        await user.click(applyButton())

        expect(startMutate).toHaveBeenCalledTimes(1)
        const [body] = startMutate.mock.calls[0]
        expect(body).toEqual({
            viewId: 'v1',
            predicate: { kind: 'group', op: 'and', children: [{ kind: 'hasProperty', key: 'owner', negate: false }] },
            op: { kind: 'set', key: 'owner', value: 'alice', valueType: 'string' },
            expectedCount: 5,
        })
        expect(onClose).toHaveBeenCalled()
    })

    it('sends a 64-bit integer as its digits, so it arrives exact', async () => {
        const user = userEvent.setup()
        renderDialog()
        await user.selectOptions(screen.getByRole('combobox'), 'number')
        await user.type(screen.getByPlaceholderText('0'), '9223372036854775807')
        await waitFor(() => expect(applyButton()).toBeEnabled())
        await user.click(applyButton())
        expect(startMutate.mock.calls[0][0].op).toEqual(
            { kind: 'set', key: 'owner', value: '9223372036854775807', valueType: 'number' })
    })

    it('shows how many of the matches a fill can change', async () => {
        const user = userEvent.setup()
        renderDialog()
        await user.click(screen.getByRole('button', { name: /fill if empty/i }))
        expect(await screen.findByText(/can change/)).toBeInTheDocument()
        expect(screen.getByText('2')).toBeInTheDocument()
    })

    it('is held while another operation is being written into the draft', async () => {
        const user = userEvent.setup()
        renderDialog({ ops: opsList({ ops: [{ jobId: 'j0', status: 'running' } as never] }) })
        await user.type(screen.getByPlaceholderText(/value/i), 'alice')
        expect(await screen.findByText(/being written into this draft/)).toBeInTheDocument()
        expect(applyButton()).toBeDisabled()
    })

    it('is held when the criteria match more than a draft may hold', async () => {
        const user = userEvent.setup()
        counts.all = 150_000
        renderDialog()
        await user.type(screen.getByPlaceholderText(/value/i), 'alice')
        expect(await screen.findByText(/more than a draft may hold/)).toBeInTheDocument()
        expect(applyButton()).toBeDisabled()
    })

    it('is held outside a draft', async () => {
        const user = userEvent.setup()
        renderDialog({ draft: null })
        await user.type(screen.getByPlaceholderText(/value/i), 'alice')
        await screen.findByText(/entities match/)
        expect(applyButton()).toBeDisabled()
    })

    it('says the published graph is catching up, and counts once it has', async () => {
        const user = userEvent.setup()
        watermark.fresh = false
        vi.mocked(countMatches).mockRejectedValue(new Error(
            'API Error 501: {"detail":"Search isn\'t available while the published graph is catching up — try again in a moment."}'))
        const { rerender } = renderDialog()
        await user.type(screen.getByPlaceholderText(/value/i), 'alice')
        expect(await screen.findByText(/published graph is catching up/)).toBeInTheDocument()
        await waitFor(() => expect(countMatches).toHaveBeenCalledTimes(1))
        await act(async () => {})                     // the count's refusal lands
        expect(applyButton()).toBeDisabled()

        watermark.fresh = true
        vi.mocked(countMatches).mockImplementation(countAsSearchWould)
        rerender()
        await waitFor(() => expect(applyButton()).toBeEnabled())
        expect(countMatches).toHaveBeenCalledTimes(2)
        expect(screen.getByText(/^\s*entities match$/)).toHaveTextContent('5 entities match')
        expect(screen.queryByText(/published graph is catching up/)).not.toBeInTheDocument()
    })

    it('asks again how far the published graph has got when a count is refused', async () => {
        const user = userEvent.setup()
        vi.mocked(countMatches).mockRejectedValue(new Error(
            'API Error 501: {"detail":"Search isn\'t available while the published graph is catching up — try again in a moment."}'))
        renderDialog()
        await user.type(screen.getByPlaceholderText(/value/i), 'alice')
        await waitFor(() => expect(recheck).toHaveBeenCalled())
    })

    it('says why the matches couldn\'t be counted', async () => {
        const user = userEvent.setup()
        vi.mocked(countMatches).mockRejectedValue(new Error(
            'API Error 422: {"detail":"A search can hold at most 64 conditions."}'))
        renderDialog()
        await user.type(screen.getByPlaceholderText(/value/i), 'alice')
        expect(await screen.findByText(/at most 64 conditions/)).toBeInTheDocument()
        expect(applyButton()).toBeDisabled()
    })

    it('shows the server\'s refusal and stays open', async () => {
        const user = userEvent.setup()
        startMutate.mockImplementation((_body, opts) => opts.onError(new Error('“urn” is kept by the platform')))
        const { onClose } = renderDialog()
        await user.type(screen.getByPlaceholderText(/value/i), 'alice')
        await waitFor(() => expect(applyButton()).toBeEnabled())
        await user.click(applyButton())
        expect(await screen.findByRole('alert')).toHaveTextContent('kept by the platform')
        expect(onClose).not.toHaveBeenCalled()
    })
})
