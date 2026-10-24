/**
 * The Live updates switch reaches tabs that are already open.
 *
 * The browser used to decide whether to stream once, when the tab started.
 * Turning push off left every open tab's stream reconnecting for as long as
 * the tab lived, and turning it on opened nothing until a reload. The flag
 * itself already reaches open tabs through the feed, so following it only
 * takes reading it reactively.
 */
import type { ReactNode } from 'react'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { authState, startChangeFeed } = vi.hoisted(() => ({
    authState: { status: 'authenticated', bootstrap: async () => {}, handleSessionLost: () => {} },
    startChangeFeed: vi.fn(),
}))

vi.mock('./routes', () => ({ router: {} }))
vi.mock('@/providers/GraphProviderContext', () => ({
    GraphProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/components/layout/BackendHealthBanner', () => ({ BackendHealthBanner: () => null }))
vi.mock('@/store/auth', () => ({
    useAuthStore: Object.assign(
        (select: (s: typeof authState) => unknown) => select(authState),
        { getState: () => authState },
    ),
    usePermission: () => false,
    useAnyWorkspacePermission: () => false,
}))
vi.mock('@/store/providerStatus', () => ({
    enableProviderStatusPolling: vi.fn(), disableProviderStatusPolling: vi.fn(),
}))
vi.mock('@/store/providerHealth', () => ({
    enableProviderHealthPolling: vi.fn(), disableProviderHealthPolling: vi.fn(),
}))
vi.mock('@/store/permissionPoller', () => ({
    enablePermissionPolling: vi.fn(), disablePermissionPolling: vi.fn(),
}))
vi.mock('@/store/sessionKeepalive', () => ({
    enableSessionKeepalive: vi.fn(), disableSessionKeepalive: vi.fn(),
}))
vi.mock('@/store/changeFeed', () => ({ startChangeFeed }))

import { AuthBootstrap } from './App'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'

function setFlags(values: Record<string, unknown>) {
    act(() => useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, ...values } }))
}

beforeEach(() => {
    startChangeFeed.mockReset()
    startChangeFeed.mockImplementation(() => vi.fn())
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, realtimeChangeFeedEnabled: false } })
})

describe('AuthBootstrap — the Live updates switch', () => {
    it('reopens the feed with push when the switch turns on, and without it when it turns off', () => {
        render(<AuthBootstrap><div /></AuthBootstrap>)
        expect(startChangeFeed).toHaveBeenCalledTimes(1)
        expect(startChangeFeed).toHaveBeenLastCalledWith({ stream: false })
        const withoutPush = startChangeFeed.mock.results[0].value

        setFlags({ realtimeChangeFeedEnabled: true })
        expect(withoutPush).toHaveBeenCalledTimes(1)
        expect(startChangeFeed).toHaveBeenLastCalledWith({ stream: true })
        const withPush = startChangeFeed.mock.results[1].value

        setFlags({ realtimeChangeFeedEnabled: false })
        expect(withPush).toHaveBeenCalledTimes(1)
        expect(startChangeFeed).toHaveBeenLastCalledWith({ stream: false })
    })

    it('leaves the feed alone when a different switch changes', () => {
        render(<AuthBootstrap><div /></AuthBootstrap>)

        setFlags({ realtimeChangeFeedEnabled: false, traceEnabled: false })

        expect(startChangeFeed).toHaveBeenCalledTimes(1)
    })
})
