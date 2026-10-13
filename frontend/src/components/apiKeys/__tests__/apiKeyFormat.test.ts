/**
 * How a key reads to a person, and the choices the form offers — pure, so
 * pinned here rather than through a rendered page.
 */
import { describe, expect, it } from 'vitest'

import {
    clientName,
    cidrProblem,
    customDateProblem,
    defaultExpiry,
    describeLastUsed,
    describePermissions,
    describeResources,
    describeRevocation,
    expiryCountdown,
    expiryDays,
    expiryFields,
    expiryOptions,
    fitExpiry,
    isRenewable,
    overreach,
    parseCidrs,
    sitePath,
    statusLabel,
    stillCalled,
} from '../apiKeyFormat'
import type { ApiKeyUsage, PickerItem } from '@/services/apiKeyService'

const item = (id: string, level: 'read' | 'write'): PickerItem => ({
    id, name: id, workspaceId: 'ws', workspaceName: 'WS', level,
})

const NOW = new Date('2026-10-13T12:00:00Z')
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000).toISOString()

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

    it('calls a key ended by its own rotation replaced, not revoked', () => {
        expect(statusLabel({ status: 'revoked', revokedReason: 'rotated' })).toBe('Replaced')
        expect(statusLabel({ status: 'revoked', revokedReason: 'admin' })).toBe('Revoked')
        expect(statusLabel({ status: 'active', revokedReason: null })).toBe('Active')
    })

    it('renews only an expired key — a paused one resumes when its owner signs in', () => {
        expect(isRenewable({ status: 'expired' })).toBe(true)
        expect(isRenewable({ status: 'paused' })).toBe(false)
        expect(isRenewable({ status: 'active' })).toBe(false)
        expect(isRenewable({ status: 'revoked' })).toBe(false)
    })

    it('says who ended it, with "you" only for its owner', () => {
        expect(describeRevocation({ revokedReason: 'owner' }, 'owner')).toBe('You revoked it')
        expect(describeRevocation({ revokedReason: 'owner' }, 'admin')).toBe('Revoked by its owner')
        expect(describeRevocation({ revokedReason: 'admin' }, 'owner')).toBe('Revoked by an administrator')
        expect(describeRevocation({ revokedReason: 'rotated' }, 'owner')).toBe('Replaced by a new key')
    })
})

describe('the expiry countdown', () => {
    it('grows more urgent as the end nears', () => {
        expect(expiryCountdown(at(24 * 45), NOW)).toMatchObject({ label: 'Expires in 45 days', tone: 'calm' })
        expect(expiryCountdown(at(24 * 5), NOW)).toMatchObject({ label: 'Expires in 5 days', tone: 'soon', days: 5 })
        expect(expiryCountdown(at(24 * 7), NOW).tone).toBe('soon')
        expect(expiryCountdown(at(5), NOW)).toMatchObject({ label: 'Expires in 5 hours', tone: 'urgent' })
        expect(expiryCountdown(at(0.5), NOW)).toMatchObject({ label: 'Expires in under an hour', tone: 'urgent' })
    })

    it('says when it ended, and that a key without an end never does', () => {
        expect(expiryCountdown(at(-3), NOW)).toMatchObject({ label: 'Expired today', tone: 'ended' })
        expect(expiryCountdown(at(-24 * 3), NOW)).toMatchObject({ label: 'Expired 3 days ago', tone: 'ended' })
        expect(expiryCountdown(null, NOW)).toEqual({ label: 'Never expires', tone: 'never', days: null })
    })
})

describe('last used', () => {
    it('reads as when, and from which address and program', () => {
        expect(describeLastUsed({
            lastUsedAt: at(-0.5), lastUsedIp: '203.0.113.24', lastUsedUserAgent: 'python-httpx/0.27.0',
        }, NOW)).toEqual({ when: 'Used 30 minutes ago', where: '203.0.113.24 · python-httpx 0.27.0' })
        expect(describeLastUsed({ lastUsedAt: null, lastUsedIp: null, lastUsedUserAgent: null }, NOW))
            .toEqual({ when: 'Never used', where: null })
    })

    it('names the program rather than quoting the user agent', () => {
        expect(clientName('curl/8.5.0')).toBe('curl 8.5.0')
        expect(clientName('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'))
            .toBe('Chrome 120')
        expect(clientName(null)).toBeNull()
    })

    it('notices an expired key that something still calls', () => {
        const usage = (daily14: number[]): ApiKeyUsage => ({ requests30d: 0, writes30d: 0, refused30d: 0, errors30d: 0, daily14 })
        const quiet = [5, 5, 5, 5, 5, 5, 5, 0, 0, 0, 0, 0, 0, 0]
        expect(stillCalled({ status: 'expired', usage: usage([...quiet.slice(0, 13), 4]) })).toBe(4)
        expect(stillCalled({ status: 'expired', usage: usage(quiet) })).toBe(0)
        expect(stillCalled({ status: 'active', usage: usage(Array(14).fill(3)) })).toBe(0)
    })
})

describe('expiry', () => {
    it('offers nothing past the deployment maximum, and "never" only without one', () => {
        expect(expiryOptions(null).map((o) => o.value)).toEqual(['7', '30', '90', '365', 'custom', 'never'])
        expect(expiryOptions(60).map((o) => o.value)).toEqual(['7', '30', 'custom'])
    })

    it('starts at 30 days, or shorter when the maximum is shorter', () => {
        expect(defaultExpiry(null)).toBe('30')
        expect(defaultExpiry(14)).toBe('7')
    })

    it('fits a choice to the maximum by taking the longest that is allowed', () => {
        expect(fitExpiry('90', null)).toBe('90')
        expect(fitExpiry('90', 60)).toBe('30')
        expect(fitExpiry('never', 400)).toBe('365')
    })

    it('turns a choice into the request fields', () => {
        const now = new Date('2026-10-01T12:00:00Z')
        expect(expiryFields('never', '', now)).toEqual({ expiresAt: null, neverExpires: true })
        expect(expiryFields('7', '', now).expiresAt).toBe('2026-10-08T12:00:00.000Z')
        expect(expiryFields('custom', '2026-12-31', now).expiresAt).toBe('2026-12-31T23:59:59.000Z')
    })

    it('takes a custom last day only after today and inside the maximum', () => {
        expect(customDateProblem('', null, NOW)).toBe('Pick the last day it should work.')
        expect(customDateProblem('2026-10-13', null, NOW)).toBeNull()               // ends tonight, UTC
        expect(customDateProblem('2026-10-12', null, NOW)).toBe('Pick a day after today.')
        expect(customDateProblem('2026-12-31', 30, NOW)).toBe('Keys here last at most 30 days.')
        expect(customDateProblem('2026-11-01', 30, NOW)).toBeNull()
    })

    it('knows how many days a choice lasts', () => {
        expect(expiryDays('90', '', NOW)).toBe(90)
        expect(expiryDays('never', '', NOW)).toBeNull()
        expect(expiryDays('custom', '2026-10-20', NOW)).toBe(8)
    })
})

describe('networks', () => {
    it('accepts one per line or comma-separated', () => {
        expect(parseCidrs('10.0.0.0/8\n 192.168.1.1, 2001:db8::/32 ')).toEqual([
            '10.0.0.0/8', '192.168.1.1', '2001:db8::/32',
        ])
        expect(parseCidrs('  ')).toEqual([])
    })

    it('says what is wrong with an entry, and accepts addresses and networks', () => {
        for (const ok of ['203.0.113.24', '10.0.0.0/8', '10.1.2.3/8', '2001:db8::/32', '::1', 'fe80::1:2:3:4']) {
            expect(cidrProblem(ok), ok).toBeNull()
        }
        expect(cidrProblem('10.0.0.300')).toBe('has a part above 255')
        expect(cidrProblem('10.0.0.0/33')).toBe('needs a prefix from 0 to 32')
        expect(cidrProblem('2001:db8::/129')).toBe('needs a prefix from 0 to 128')
        expect(cidrProblem('office')).toBe('is not an address or network')
        expect(cidrProblem('10.0.0/8')).toBe('is not an address or network')
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

describe('sitePath', () => {
    it('follows a path on this site, and nothing that leaves it', () => {
        expect(sitePath('/api/v1/auth/corp/login?next=/me/api-keys&force=1'))
            .toBe('/api/v1/auth/corp/login?next=/me/api-keys&force=1')
        for (const away of [
            'https://evil.example/login', '//evil.example/login', '/\\evil.example',
            'javascript:alert(1)', '', null, undefined,
        ]) {
            expect(sitePath(away)).toBeNull()
        }
    })
})
