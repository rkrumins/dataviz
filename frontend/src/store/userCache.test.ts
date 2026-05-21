/**
 * sessionStorage user-cache tests.
 *
 * Verifies the cache only seeds renders — it never substitutes for
 * the cookie validation flow, the schema version invalidates stale
 * entries, and all clear/wipe paths actually empty the storage.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AuthUser } from '@/services/authService'
import {
    clearUserCache,
    readUserCache,
    writeUserCache,
} from './userCache'

const STORAGE_KEY = 'nx_user_v1'

function _user(overrides: Partial<AuthUser> = {}): AuthUser {
    return {
        id: 'usr_1',
        email: 'alice@example.com',
        firstName: 'Alice',
        lastName: 'Doe',
        role: 'user',
        status: 'active',
        authProvider: 'local',
        createdAt: '2026-05-20T00:00:00Z',
        updatedAt: '2026-05-20T00:00:00Z',
        ...overrides,
    }
}

describe('userCache', () => {
    beforeEach(() => {
        sessionStorage.clear()
    })

    afterEach(() => {
        sessionStorage.clear()
    })

    it('round-trips a valid user DTO', () => {
        const u = _user()
        writeUserCache(u)
        expect(readUserCache()).toEqual(u)
    })

    it('returns null when no cache is present', () => {
        expect(readUserCache()).toBeNull()
    })

    it('writes a versioned envelope so we can detect schema drift', () => {
        writeUserCache(_user())
        const raw = sessionStorage.getItem(STORAGE_KEY)
        expect(raw).toBeTruthy()
        const parsed = JSON.parse(raw!)
        expect(parsed._v).toBe(1)
        expect(parsed.user.id).toBe('usr_1')
    })

    it('treats a mismatched schema version as a miss and wipes the entry', () => {
        sessionStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({ _v: 999, user: _user() }),
        )
        expect(readUserCache()).toBeNull()
        // The bad entry was wiped to keep the next write clean.
        expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('rejects DTOs missing required string fields', () => {
        // Drop ``role`` — the validator must refuse the entry.
        const bad = { _v: 1, user: { ..._user(), role: '' } }
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(bad))
        expect(readUserCache()).toBeNull()
        expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('rejects DTOs with wrong field types', () => {
        const bad = {
            _v: 1,
            user: { ..._user(), email: 42 as unknown as string },
        }
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(bad))
        expect(readUserCache()).toBeNull()
    })

    it('handles corrupted JSON by wiping the key and returning null', () => {
        sessionStorage.setItem(STORAGE_KEY, '{not valid json')
        expect(readUserCache()).toBeNull()
        expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('clearUserCache removes the entry', () => {
        writeUserCache(_user())
        expect(sessionStorage.getItem(STORAGE_KEY)).not.toBeNull()
        clearUserCache()
        expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
    })

    it('clearUserCache is a no-op when nothing is cached', () => {
        expect(() => clearUserCache()).not.toThrow()
    })

    it('does not throw when sessionStorage rejects writes (private mode)', () => {
        // Force setItem to throw to emulate Safari private-mode behaviour.
        const original = Storage.prototype.setItem
        Storage.prototype.setItem = function _throwing() {
            throw new DOMException('QuotaExceededError')
        }
        try {
            expect(() => writeUserCache(_user())).not.toThrow()
        } finally {
            Storage.prototype.setItem = original
        }
    })

    it('overwrites an existing entry on the next write', () => {
        writeUserCache(_user({ role: 'user' }))
        writeUserCache(_user({ role: 'admin' }))
        expect(readUserCache()?.role).toBe('admin')
    })
})
