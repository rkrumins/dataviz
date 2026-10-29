/**
 * DeletedDataSources — the trash says why a purge is stuck.
 *
 * A purge that failed, or that live forks hold back, used to read "Being deleted" for ever. These
 * pin that each row says where its purge stands, and that "Delete permanently" is not offered
 * where the server would refuse it.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/services/workspaceService', () => ({
    workspaceService: { listDeletedDataSources: vi.fn() },
}))

import { DeletedDataSources } from '../DeletedDataSources'
import { workspaceService, type DeletedDataSource } from '@/services/workspaceService'

function row(id: string, over: Partial<DeletedDataSource>): DeletedDataSource {
    return {
        id, label: id, deletedAt: null, deletedBy: 'Priya Raman', daysLeft: 20,
        restoreWindowDays: 30, purging: false, restorable: true,
        purgeState: 'none', purgeReason: null, liveForks: 0, ...over,
    }
}

async function renderRows(rows: DeletedDataSource[]) {
    vi.mocked(workspaceService.listDeletedDataSources).mockResolvedValue(rows)
    render(<DeletedDataSources wsId="ws_1" canManage onRestore={vi.fn()}
                               onDeletePermanently={vi.fn()} />)
    await screen.findByText('Recently deleted')
}

describe('DeletedDataSources', () => {
    it('shows a purge blocked by live forks, and offers no permanent delete', async () => {
        await renderRows([row('Ledger', {
            purgeState: 'blocked', liveForks: 2,
            purgeReason: "2 fork(s) still read this graph's history",
        })])
        expect(screen.getByText('Blocked: 2 live forks')).toBeTruthy()
        expect(screen.queryByText(/days left/)).toBeNull()
        expect(screen.getByRole('button', { name: /Restore/ })).toBeTruthy()
        expect(screen.queryByTitle('Delete permanently')).toBeNull()
    })

    it('shows the reason a purge failed, not "Being deleted"', async () => {
        await renderRows([row('Ledger', {
            purgeState: 'failed', restorable: false, purgeReason: 'connection reset by peer',
        })])
        expect(screen.getByText('Failed: connection reset by peer')).toBeTruthy()
        expect(screen.queryByText('Being deleted')).toBeNull()
        expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull()
        expect(screen.queryByTitle('Delete permanently')).toBeNull()
    })

    it('still shows a queued purge as being deleted', async () => {
        await renderRows([row('Ledger', { purgeState: 'queued', purging: true, restorable: false })])
        expect(screen.getByText('Being deleted')).toBeTruthy()
    })
})
