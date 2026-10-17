/**
 * Presets: what each sets, and that one you cannot satisfy is closed with
 * the reason — judged from the levels you hold in your workspaces.
 */
import { describe, expect, it } from 'vitest'

import { PRESETS, presetAvailability, presetById, presetPatch } from '../presets'
import type { WorkspaceAccess } from '@/services/apiKeyService'

const ws = (over: Partial<WorkspaceAccess> = {}): WorkspaceAccess => ({
    id: 'ws', name: 'Finance', views: 'read', data: 'read', publish: false, ...over,
})
const preset = (id: Parameters<typeof presetById>[0]) => presetById(id)!

describe('what a preset sets', () => {
    it('sets access, reach and lifetime together', () => {
        expect(presetPatch(preset('reporting'), null)).toEqual({
            preset: 'reporting', permissions: { views: 'read', data: 'read', publish: false },
            resourceMode: 'items', expiry: '90',
        })
        expect(presetPatch(preset('publishing'), null)).toMatchObject({
            permissions: { views: 'write', data: 'read', publish: true }, resourceMode: 'workspaces',
        })
        expect(presetPatch(preset('loading'), null).permissions).toEqual({ views: 'none', data: 'write', publish: false })
    })

    it('keeps its lifetime inside the deployment maximum', () => {
        expect(presetPatch(preset('reporting'), 60).expiry).toBe('30')
    })

    it('offers the four jobs, custom last', () => {
        expect(PRESETS.map((p) => p.title)).toEqual([
            'Read data for reporting', 'Load data and signal refreshes', 'Publish views from CI', 'Custom',
        ])
    })
})

describe('which presets you can use', () => {
    it('opens a preset when one workspace gives everything it needs', () => {
        const workspaces = [ws({ views: 'write', data: 'write', publish: true })]
        for (const p of PRESETS) expect(presetAvailability(p, workspaces).available).toBe(true)
    })

    it('closes one you cannot satisfy, and says why', () => {
        const readOnly = [ws()]
        expect(presetAvailability(preset('reporting'), readOnly).available).toBe(true)
        expect(presetAvailability(preset('loading'), readOnly))
            .toEqual({ available: false, reason: 'You cannot change data in any workspace.' })
        expect(presetAvailability(preset('publishing'), readOnly))
            .toEqual({ available: false, reason: 'You cannot publish views in any workspace.' })
        expect(presetAvailability(preset('reporting'), [ws({ data: 'none' })]))
            .toEqual({ available: false, reason: 'You cannot read data in any workspace.' })
    })

    it('needs it all in one workspace, where the key would work', () => {
        const split = [ws({ views: 'write', publish: true, data: 'none' }), ws({ id: 'b', views: 'none', data: 'read' })]
        expect(presetAvailability(preset('publishing'), split))
            .toEqual({ available: false, reason: 'No one workspace gives you everything this needs.' })
    })

    it('always offers custom, even with no workspace', () => {
        expect(presetAvailability(preset('custom'), []).available).toBe(true)
        expect(presetAvailability(preset('reporting'), []))
            .toEqual({ available: false, reason: 'You are not a member of any workspace yet.' })
    })
})
