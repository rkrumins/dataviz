import { beforeEach, describe, expect, it, vi } from 'vitest'

const authFetch = vi.fn(() => Promise.resolve(undefined))
vi.mock('@/services/apiClient', () => ({ authFetch: (...a: unknown[]) => authFetch(...(a as [])) }))

import { sectionVisit } from '../useSectionTelemetry'
import { recordEvent } from '@/services/telemetryService'
import { useWorkspacesStore } from '@/store/workspaces'

describe('sectionVisit', () => {
    it('records a move to another section, once', () => {
        expect(sectionVisit('/explorer/abc', null)).toEqual({ section: 'explore' })
        expect(sectionVisit('/views/v1', 'explore')).toBeNull()
        expect(sectionVisit('/analytics', 'explore')).toEqual({ section: 'analytics' })
    })

    it('names the workspace a workspace page is about', () => {
        expect(sectionVisit('/workspaces/ws_1/settings', null)).toEqual({ section: 'workspaces', workspaceId: 'ws_1' })
    })

    it('leaves the last section standing on a page that is none', () => {
        expect(sectionVisit('/me/profile', 'explore')).toBeNull()
    })
})

describe('recordEvent', () => {
    beforeEach(() => authFetch.mockClear())

    function body(): Record<string, unknown> {
        const call = authFetch.mock.calls[0] as unknown as [string, { body: string }]
        return JSON.parse(call[1].body)
    }

    it('says which workspace a signal happened in — the active one by default', () => {
        useWorkspacesStore.setState({ activeWorkspaceId: 'ws_active' })
        recordEvent('lineage.trace', { nodes: 3 })
        expect(body()).toEqual({ type: 'lineage.trace', payload: { nodes: 3 }, workspaceId: 'ws_active' })
    })

    it('takes an explicit workspace over the active one, and none when there is none', () => {
        useWorkspacesStore.setState({ activeWorkspaceId: 'ws_active' })
        recordEvent('graph.search', undefined, { workspaceId: 'ws_view' })
        expect(body().workspaceId).toBe('ws_view')
        authFetch.mockClear()
        useWorkspacesStore.setState({ activeWorkspaceId: null })
        recordEvent('graph.search')
        expect(body()).not.toHaveProperty('workspaceId')
    })
})
