/**
 * BulkRetryBar — a bulk rebuild asks why before it queues anything, and the
 * one answer travels with every source it queues. The prompt replaced the
 * bar's old inline "Confirm retry" step, so it is also the confirmation.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FreshnessRow } from '@/services/freshnessService'

const { refreshSource } = vi.hoisted(() => ({ refreshSource: vi.fn() }))

vi.mock('@/services/freshnessService', async () => {
    const actual = await vi.importActual<typeof import('@/services/freshnessService')>('@/services/freshnessService')
    return { ...actual, freshnessService: { ...actual.freshnessService, refreshSource } }
})

import { BulkRetryBar } from './BulkRetryBar'

const failedRow = (id: string) => ({
    dataSourceId: id, workspaceId: 'ws-1', providerId: 'p1', name: id, providerName: 'Warehouse',
    aggregationStatus: 'failed', lastFailureCategory: 'timeout',
}) as FreshnessRow

function renderBar() {
    const onDone = vi.fn()
    render(
        <BulkRetryBar
            selectedIds={['f1', 'f2']}
            rows={[failedRow('f1'), failedRow('f2')]}
            onClear={vi.fn()}
            onDone={onDone}
        />,
    )
    return onDone
}

describe('BulkRetryBar', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        refreshSource.mockResolvedValue({ scope: 'rollups', gate: 'n/a', changed: true, actions: [], deferred: false })
    })

    it('asks why before a retry, then queues every failed source with the reason', async () => {
        const user = userEvent.setup()
        const onDone = renderBar()

        await user.click(screen.getByRole('button', { name: 'Retry rebuild' }))
        const prompt = await screen.findByRole('dialog')
        expect(refreshSource).not.toHaveBeenCalled()

        await user.click(within(prompt).getByRole('button', { name: 'Verifying a fix' }))
        await user.click(within(prompt).getByRole('button', { name: 'Retry rebuild' }))

        await waitFor(() => expect(onDone).toHaveBeenCalled())
        expect(refreshSource).toHaveBeenCalledTimes(2)
        expect(refreshSource).toHaveBeenCalledWith('f1', { scope: 'rollups' }, { reason: 'Verifying a fix' })
        expect(refreshSource).toHaveBeenCalledWith('f2', { scope: 'rollups' }, { reason: 'Verifying a fix' })
    })

    it('queues nothing when the prompt is dismissed', async () => {
        const user = userEvent.setup()
        const onDone = renderBar()

        await user.click(screen.getByRole('button', { name: 'Retry rebuild' }))
        const prompt = await screen.findByRole('dialog')
        await user.click(within(prompt).getByRole('button', { name: 'Cancel' }))

        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        expect(refreshSource).not.toHaveBeenCalled()
        expect(onDone).not.toHaveBeenCalled()
    })
})
