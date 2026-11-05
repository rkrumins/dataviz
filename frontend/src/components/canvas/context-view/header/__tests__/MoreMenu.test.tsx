/**
 * MoreMenu — the Business view's door to the header tools it tucks away. What
 * it holds is reachable, not removed, and its last item puts every tool back.
 */
import type { ReactElement } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
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

const setFeatures = (values: Record<string, unknown>) =>
    useFeaturesStore.setState((s) => ({ values: { ...s.values, ...values } }))


describe('MoreMenu', () => {
    beforeEach(() => {
        usePersonaStore.setState({ mode: 'business' })
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } })
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

    it('files Import with the exports: hidden with versioning off, disabled on Published, run in a draft', async () => {
        const onImport = vi.fn()
        setFeatures({ versioningEnabled: false })
        let menu = await open(<MoreMenu onImport={onImport} isDraft />)
        expect(screen.queryByRole('menuitem', { name: /^Import…/ })).not.toBeInTheDocument()
        menu.unmount()

        setFeatures({ versioningEnabled: true })
        menu = await open(<MoreMenu onImport={onImport} />)
        const waiting = within(screen.getByRole('group', { name: 'File' })).getByRole('menuitem', { name: /^Import…/ })
        expect(waiting).toHaveAttribute('aria-disabled', 'true')
        expect(waiting).toHaveTextContent('start a draft to import')
        await menu.user.click(waiting)
        expect(onImport).not.toHaveBeenCalled()
        menu.unmount()

        menu = await open(<MoreMenu onImport={onImport} isDraft />)
        await menu.user.click(screen.getByRole('menuitem', { name: /^Import…/ }))
        expect(onImport).toHaveBeenCalledTimes(1)
    })

    it('offers "Update this view from a file" only where view import is on, with a handler', async () => {
        const onUpdateFromFile = vi.fn()
        const name = /^Update this view from a file…/
        // The preview ships off.
        let menu = await open(<MoreMenu thisView={{ onUpdateFromFile }} />)
        expect(screen.queryByRole('menuitem', { name })).not.toBeInTheDocument()
        menu.unmount()

        setFeatures({ viewPortabilityEnabled: true, viewImportEnabled: false })
        menu = await open(<MoreMenu thisView={{ onUpdateFromFile }} />)
        expect(screen.queryByRole('menuitem', { name })).not.toBeInTheDocument()
        menu.unmount()

        setFeatures({ viewImportEnabled: true })
        menu = await open(<MoreMenu thisView={{}} />)
        expect(screen.queryByRole('menuitem', { name })).not.toBeInTheDocument()
        menu.unmount()

        menu = await open(<MoreMenu thisView={{ onUpdateFromFile }} />)
        await menu.user.click(within(screen.getByRole('group', { name: 'File' })).getByRole('menuitem', { name }))
        expect(onUpdateFromFile).toHaveBeenCalledTimes(1)
    })

    it('offers "Save layers as a template" only with its handler', async () => {
        const onSaveAsTemplate = vi.fn()
        const name = /^Save layers as a template…/
        let menu = await open(<MoreMenu thisView={{}} />)
        expect(screen.queryByRole('menuitem', { name })).not.toBeInTheDocument()
        expect(screen.queryByRole('group', { name: 'File' })).not.toBeInTheDocument()
        menu.unmount()

        menu = await open(<MoreMenu thisView={{ onSaveAsTemplate }} />)
        await menu.user.click(within(screen.getByRole('group', { name: 'File' })).getByRole('menuitem', { name }))
        expect(onSaveAsTemplate).toHaveBeenCalledTimes(1)
    })

    it.each([
        ['Entities with no parent', 'onOpenOrphans'],
        ['Changes & history', 'onOpenHistory'],
        ['Your drafts', 'onOpenDrafts'],
    ] as const)('offers "%s…" only with its handler, and runs it', async (label, handler) => {
        const name = new RegExp(`^${label}…`)
        let menu = await open(<MoreMenu />)
        expect(screen.queryByRole('menuitem', { name })).not.toBeInTheDocument()
        menu.unmount()

        const run = vi.fn()
        menu = await open(<MoreMenu {...{ [handler]: run }} />)
        await menu.user.click(screen.getByRole('menuitem', { name }))
        expect(run).toHaveBeenCalledTimes(1)
    })

    it('"Show every tool" switches to the Technical view', async () => {
        const user = userEvent.setup()
        render(<MoreMenu />)
        await user.click(screen.getByRole('button', { name: 'More tools' }))
        await user.click(await screen.findByRole('menuitem', { name: /Show every tool/ }))
        expect(usePersonaStore.getState().mode).toBe('technical')
    })
})
