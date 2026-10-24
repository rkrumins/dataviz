/**
 * DataSourceActionMenu — the "⋯" lifecycle menu on a data source.
 *
 * Moving is offered on its own terms: a workspace's last source can't be
 * deleted, but it can still move, so the menu must open with Move alone.
 * When everything is offered, Move sits above the two removals, which keep
 * their order and their weight.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { DataSourceActionMenu } from '../DataSourceActionMenu'

describe('DataSourceActionMenu', () => {
    it('opens with Move alone when deleting isn’t offered', async () => {
        const user = userEvent.setup()
        const onMove = vi.fn()
        render(<DataSourceActionMenu onMove={onMove} />)
        await user.click(screen.getByRole('button', { name: 'Data source actions' }))

        expect(screen.getAllByRole('menuitem')).toHaveLength(1)
        await user.click(screen.getByRole('menuitem', { name: /Move to another workspace/ }))
        expect(onMove).toHaveBeenCalledTimes(1)
    })

    it('puts Move above Offboard and Delete permanently when all are offered', async () => {
        const user = userEvent.setup()
        render(<DataSourceActionMenu onMove={vi.fn()} onOffboard={vi.fn()} onDelete={vi.fn()} />)
        await user.click(screen.getByRole('button', { name: 'Data source actions' }))

        expect(screen.getAllByRole('menuitem').map(i => i.textContent)).toEqual([
            expect.stringMatching(/^Move to another workspace…/),
            expect.stringMatching(/^Offboard/),
            expect.stringMatching(/^Delete permanently/),
        ])
    })
})
