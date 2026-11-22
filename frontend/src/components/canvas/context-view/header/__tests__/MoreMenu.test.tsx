/**
 * MoreMenu — the Business view's door to the header tools it tucks away. What
 * it holds is reachable, not removed, and its last item puts every tool back.
 * What the row already has (Properties, the Import / Export menu) and what the
 * page header's Reviews opens are not repeated here, and with nothing left to
 * hold the menu is not drawn.
 */
import type { ReactElement } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { usePersonaStore } from '@/store/persona'

import { MoreMenu } from '../MoreMenu'

/** Render the menu and open it. */
async function open(ui: ReactElement) {
    const user = userEvent.setup()
    const { unmount } = render(ui)
    await user.click(screen.getByRole('button', { name: 'More tools' }))
    await screen.findByRole('menu')
    return { user, unmount }
}


describe('MoreMenu', () => {
    beforeEach(() => {
        usePersonaStore.setState({ mode: 'business' })
    })

    it('holds Select several, and runs it', async () => {
        const onToggleMultiSelect = vi.fn()
        const menu = await open(<MoreMenu onToggleMultiSelect={onToggleMultiSelect} />)
        await menu.user.click(screen.getByRole('menuitem', { name: /Select several/ }))
        expect(onToggleMultiSelect).toHaveBeenCalledTimes(1)
    })

    it('repeats nothing the row or the page header already offers', async () => {
        await open(<MoreMenu onToggleMultiSelect={vi.fn()} onOpenOrphans={vi.fn()} onOpenDrafts={vi.fn()} />)
        expect(screen.queryByRole('menuitem', { name: /Properties & display rules/ })).not.toBeInTheDocument()
        expect(screen.queryByRole('menuitem', { name: /Changes & history/ })).not.toBeInTheDocument()
        expect(screen.queryByRole('menuitem', { name: /^Import…|^Export/ })).not.toBeInTheDocument()
        expect(screen.queryByRole('group', { name: 'File' })).not.toBeInTheDocument()
    })

    it.each([
        ['Entities with no parent', 'onOpenOrphans'],
        ['Your drafts', 'onOpenDrafts'],
    ] as const)('offers "%s…" only with its handler, and runs it', async (label, handler) => {
        const name = new RegExp(`^${label}…`)
        let menu = await open(<MoreMenu onToggleMultiSelect={vi.fn()} />)
        expect(screen.queryByRole('menuitem', { name })).not.toBeInTheDocument()
        menu.unmount()

        const run = vi.fn()
        menu = await open(<MoreMenu {...{ [handler]: run }} />)
        await menu.user.click(screen.getByRole('menuitem', { name }))
        expect(run).toHaveBeenCalledTimes(1)
    })

    it('is not drawn when it has nothing to hold', () => {
        render(<MoreMenu />)
        expect(screen.queryByRole('button', { name: 'More tools' })).not.toBeInTheDocument()
    })

    it('"Show every tool" switches to the Technical view', async () => {
        const menu = await open(<MoreMenu onOpenDrafts={vi.fn()} />)
        await menu.user.click(screen.getByRole('menuitem', { name: /Show every tool/ }))
        expect(usePersonaStore.getState().mode).toBe('technical')
    })
})
