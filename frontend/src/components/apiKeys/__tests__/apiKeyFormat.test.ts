/**
 * How a key reads to a person, and the choices the form offers — pure, so
 * pinned here rather than through a rendered page.
 */
import { describe, expect, it } from 'vitest'

import {
    defaultExpiry,
    describePermissions,
    describeResources,
    expiryFields,
    expiryOptions,
    overreach,
    parseCidrs,
} from '../apiKeyFormat'
import type { PickerItem } from '@/services/apiKeyService'

const item = (id: string, level: 'read' | 'write'): PickerItem => ({
    id, name: id, workspaceId: 'ws', workspaceName: 'WS', level,
})

describe('describing a key', () => {
    it('names what it may do', () => {
        expect(describePermissions({ views: 'write', data: 'read', publish: true }))
            .toBe('Views: read & write · Publish · Data: read')
        expect(describePermissions({ views: 'none', data: 'none', publish: false })).toBe('Nothing')
    })

    it('names what it may reach', () => {
        expect(describeResources('all')).toBe('Everything you can access')
        expect(describeResources({ workspaces: ['a', 'b'], views: ['v'], dataSources: [] }))
            .toBe('2 workspaces, 1 view')
    })
})

describe('expiry', () => {
    it('offers nothing past the deployment maximum, and "never" only without one', () => {
        expect(expiryOptions(null).map((o) => o.value)).toEqual(['7', '30', '60', '90', '365', 'custom', 'never'])
        expect(expiryOptions(60).map((o) => o.value)).toEqual(['7', '30', '60', 'custom'])
    })

    it('starts at 30 days, or shorter when the maximum is shorter', () => {
        expect(defaultExpiry(null)).toBe('30')
        expect(defaultExpiry(14)).toBe('7')
    })

    it('turns a choice into the request fields', () => {
        const now = new Date('2026-10-01T12:00:00Z')
        expect(expiryFields('never', '', now)).toEqual({ expiresAt: null, neverExpires: true })
        expect(expiryFields('7', '', now).expiresAt).toBe('2026-10-08T12:00:00.000Z')
        expect(expiryFields('custom', '2026-12-31', now).expiresAt).toBe('2026-12-31T23:59:59.000Z')
    })
})

describe('networks', () => {
    it('accepts one per line or comma-separated', () => {
        expect(parseCidrs('10.0.0.0/8\n 192.168.1.1, 2001:db8::/32 ')).toEqual([
            '10.0.0.0/8', '192.168.1.1', '2001:db8::/32',
        ])
        expect(parseCidrs('  ')).toEqual([])
    })
})

describe('asking for more than you have', () => {
    it('names what the key will get less on than it asks for', () => {
        const views = [item('v_edit', 'write'), item('v_read', 'read')]
        const sources = [item('ds_read', 'read')]
        expect(overreach({ views: 'write', data: 'read', publish: false }, views, sources).map((i) => i.id))
            .toEqual(['v_read'])
        expect(overreach({ views: 'read', data: 'write', publish: false }, views, sources).map((i) => i.id))
            .toEqual(['ds_read'])
    })
})
