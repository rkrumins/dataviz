/**
 * A source's card carries its open questions; the chip opens them, not the source's panel on
 * its default tab.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DataSourceGridCard } from '../DataSourceGridCard'
import type { DataSourceResponse } from '@/services/workspaceService'

const DS = {
    id: 'ds_gl', workspaceId: 'ws1', label: 'General Ledger', accessLevel: 'read', isPrimary: false, isActive: true,
    aggregationStatus: 'ready', aggregationEdgeCount: 0, createdAt: '', updatedAt: '2026-11-01T00:00:00Z',
} as DataSourceResponse

describe('DataSourceGridCard questions', () => {
    it('shows the open count and opens the questions, not the card', async () => {
        const onSelect = vi.fn()
        const onOpenQuestions = vi.fn()
        render(<DataSourceGridCard ds={DS} viewCount={0} isSelected={false} onSelect={onSelect}
            questions={{ open: 4, answered: 2, total: 6, unread: 0 }} onOpenQuestions={onOpenQuestions} />)
        await userEvent.click(screen.getByRole('button', { name: '4 open questions' }))
        expect(onOpenQuestions).toHaveBeenCalledTimes(1)
        expect(onSelect).not.toHaveBeenCalled()
    })

    it('shows nothing without questions', () => {
        render(<DataSourceGridCard ds={DS} viewCount={0} isSelected={false} onSelect={vi.fn()} onOpenQuestions={vi.fn()} />)
        expect(screen.queryByRole('button', { name: /question/ })).toBeNull()
    })
})
