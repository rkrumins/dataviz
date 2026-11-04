/**
 * MoreMenu — the Business view's door to the header tools it tucks away. What
 * it holds is reachable, not removed, and its last item puts every tool back.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useFeaturesStore } from '@/store/features'
import { usePersonaStore } from '@/store/persona'

import { MoreMenu } from '../MoreMenu'


describe('MoreMenu', () => {
    beforeEach(() => {
        usePersonaStore.setState({ mode: 'business' })
    })

    it('holds Select several and the Property Manager, and runs them', async () => {
        const user = userEvent.setup()
        const onToggleMultiSelect = vi.fn()
        const onTogglePropertyManager = vi.fn()
        render(<MoreMenu onToggleMultiSelect={onToggleMultiSelect} onTogglePropertyManager={onTogglePropertyManager} />)

        await user.click(screen.getByRole('button', { name: 'More tools' }))
        await user.click(await screen.findByRole('menuitem', { name: /Select several/ }))
        expect(onToggleMultiSelect).toHaveBeenCalledTimes(1)

        await user.click(screen.getByRole('button', { name: 'More tools' }))
        await user.click(await screen.findByRole('menuitem', { name: /Properties & display rules/ }))
        expect(onTogglePropertyManager).toHaveBeenCalledTimes(1)
    })

    it('offers an export only when the deployment allows it', async () => {
        const user = userEvent.setup()
        const onExport = vi.fn()
        useFeaturesStore.setState((s) => ({ values: { ...s.values, graphExportEnabled: false } }))
        const { unmount } = render(<MoreMenu onExport={onExport} />)
        await user.click(screen.getByRole('button', { name: 'More tools' }))
        expect(await screen.findByRole('menu')).toBeInTheDocument()
        expect(screen.queryByRole('menuitem', { name: /Export data/ })).not.toBeInTheDocument()
        unmount()

        useFeaturesStore.setState((s) => ({ values: { ...s.values, graphExportEnabled: true } }))
        render(<MoreMenu onExport={onExport} />)
        await user.click(screen.getByRole('button', { name: 'More tools' }))
        await user.click(await screen.findByRole('menuitem', { name: /Export data/ }))
        expect(onExport).toHaveBeenCalledTimes(1)
    })

    it('"Show every tool" switches to the Technical view', async () => {
        const user = userEvent.setup()
        render(<MoreMenu />)
        await user.click(screen.getByRole('button', { name: 'More tools' }))
        await user.click(await screen.findByRole('menuitem', { name: /Show every tool/ }))
        expect(usePersonaStore.getState().mode).toBe('technical')
    })
})
