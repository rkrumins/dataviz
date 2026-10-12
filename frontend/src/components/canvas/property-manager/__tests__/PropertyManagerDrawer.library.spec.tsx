/**
 * PropertyManagerDrawer on the view's library: rules are changed through
 * it (a refused save stays in the editor with its reason), someone who
 * can't edit the view sees the rules but no way to change them, the
 * library exports to a file, and a library that couldn't load says so.
 */
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const notify = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/notifications', () => ({
    useAppNotifications: () => ({ notify }),
}))

const exportViewLibrary = vi.hoisted(() => vi.fn())
vi.mock('@/services/viewLibraryService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/services/viewLibraryService')>()),
    exportViewLibrary,
}))

const saveLibraryFile = vi.hoisted(() => vi.fn())
vi.mock('../libraryFile', () => ({ saveLibraryFile, readLibraryFile: vi.fn() }))

vi.mock('framer-motion', () => {
    const cache = new Map<string, React.ComponentType<unknown>>()
    const passthrough = (tag: string) => {
        let cmp = cache.get(tag)
        if (!cmp) {
            cmp = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
                function MotionStub({ layout: _layout, ...props }: React.HTMLAttributes<HTMLElement> & { layout?: unknown }, ref) {
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
        allKeys: [], keysByEntityType: {}, tagValues: ['PII'],
        getValueSamples: () => [], edgeTypes: [], keysByEdgeType: {},
        getEdgeValueSamples: () => [], isInitialLoading: false, error: null,
    }),
}))

vi.mock('@/services/ruleCounts', () => ({ countRules: vi.fn(async () => new Map()) }))

vi.mock('@/providers/GraphProviderContext', async () => {
    const { RemoteGraphProvider } = await import('@/providers/RemoteGraphProvider')
    const provider = Object.create(RemoteGraphProvider.prototype)
    return { useGraphProvider: () => provider }
})

vi.mock('@/components/ui/DynamicIcon', () => ({
    DynamicIcon: ({ name }: { name: string }) => <span data-icon={name} />,
}))

import { useReferenceModelStore } from '@/store/referenceModelStore'
import { useViewLibraryStore, type ViewLibraryState } from '@/store/viewLibraryStore'
import type { DisplayRuleConfig } from '@/types/schema'

import { PropertyManagerDrawer } from '../PropertyManagerDrawer'


const rule: DisplayRuleConfig = {
    id: 'pii', name: 'PII', color: '#6366f1', enabled: true, createdAt: '2026-01-01T00:00:00Z',
    predicate: { kind: 'tag', op: 'hasAny', values: ['PII'] },
}

function library(over: Partial<ViewLibraryState> = {}) {
    useViewLibraryStore.setState({
        viewId: 'view-1', branchId: null, status: 'ready', error: null, canEdit: true,
        savedQueries: [], saveRule: vi.fn(async () => {}), toggleRule: vi.fn(async () => {}),
        removeRule: vi.fn(async () => {}), reorderRules: vi.fn(async () => {}), reload: vi.fn(async () => {}),
        ...over,
    })
}

const renderDrawer = () => render(<PropertyManagerDrawer viewId="view-1" open onClose={vi.fn()} />)


beforeEach(() => {
    notify.mockReset()
    exportViewLibrary.mockReset()
    saveLibraryFile.mockReset()
    useReferenceModelStore.setState({ displayRules: [rule] })
})


describe('PropertyManagerDrawer — the view\'s library', () => {
    it('shows someone who can\'t edit the view its rules, but no way to change them', () => {
        library({ canEdit: false })
        renderDrawer()
        expect(screen.getByText('PII')).toBeInTheDocument()
        expect(screen.getByText(/Only people who can edit this view can change them/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /New rule/ })).toBeNull()
        expect(screen.queryByTitle('Edit rule')).toBeNull()
        expect(screen.queryByTitle('Delete rule')).toBeNull()
        expect(screen.getByRole('switch')).toBeDisabled()
        expect(screen.queryByRole('button', { name: /Import/ })).toBeNull()
        expect(screen.getByRole('button', { name: /Export/ })).toBeInTheDocument()
    })

    it('keeps a refused rule open in the editor with the reason, and closes it once saved', async () => {
        const saveRule = vi.fn()
            .mockRejectedValueOnce(new Error('A rule named “PII” already exists in this view.'))
            .mockResolvedValueOnce(undefined)
        library({ saveRule })
        renderDrawer()
        const user = userEvent.setup()
        await user.click(screen.getByTitle('Edit rule'))
        await user.click(screen.getByRole('button', { name: /Save rule/ }))

        expect(await screen.findByRole('alert')).toHaveTextContent(
            'Couldn\'t save the rule — A rule named “PII” already exists in this view.')
        expect(screen.getByRole('button', { name: /Save rule/ })).toBeInTheDocument()

        await user.click(screen.getByRole('button', { name: /Save rule/ }))
        expect(saveRule).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'pii', name: 'PII' }))
        expect(await screen.findByTitle('Edit rule')).toBeInTheDocument()   // back on the list
        expect(notify).toHaveBeenCalledWith('success', expect.stringContaining('“PII” updated'))
    })

    it('says so when a change to a rule is refused', async () => {
        library({ toggleRule: vi.fn().mockRejectedValue(new Error('Service Unavailable')) })
        renderDrawer()
        await userEvent.setup().click(screen.getByRole('switch'))
        await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(
            'error', "Couldn't change the rule — Service Unavailable"))
    })

    it('exports the rules and saved queries of the view (or its draft) as a file', async () => {
        library({ branchId: 'br1' })
        const pack = { format: 'synodic.view-library', version: 1, displayRules: [rule], savedQueries: [] }
        exportViewLibrary.mockResolvedValueOnce(pack)
        renderDrawer()
        await userEvent.setup().click(screen.getByRole('button', { name: /Export/ }))
        expect(exportViewLibrary).toHaveBeenCalledWith('view-1', 'br1')
        await vi.waitFor(() => expect(saveLibraryFile).toHaveBeenCalledWith(pack))
    })

    it('says why the rules could not be loaded, and tries again', async () => {
        const reload = vi.fn(async () => {})
        library({ status: 'error', error: 'Service Unavailable', reload })
        useReferenceModelStore.setState({ displayRules: [] })
        renderDrawer()
        expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load this view's rulesService Unavailable")
        await userEvent.setup().click(screen.getByRole('button', { name: /Try again/ }))
        expect(reload).toHaveBeenCalled()
    })
})
