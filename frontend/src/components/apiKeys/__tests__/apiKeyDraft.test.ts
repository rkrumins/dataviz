/**
 * Parking the form across a sign-in: versioned, for 30 minutes, and never
 * holding a password or a token.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
    DRAFT_SHELF_LIFE_MS, clearDraft, freshDraft, parkDraft, peekDraft, type ApiKeyDraft,
} from '../apiKeyDraft'

const T0 = Date.parse('2026-10-13T12:00:00Z')

function draft(over: Partial<ApiKeyDraft> = {}): ApiKeyDraft {
    return { ...freshDraft(null), name: 'nightly sync', preset: 'loading', step: 'review', cidrs: ['10.0.0.0/8'], ...over }
}

beforeEach(() => sessionStorage.clear())

describe('a parked draft', () => {
    it('comes back as it was left, at the step it was left on', () => {
        parkDraft(draft(), T0)
        expect(peekDraft(T0 + 60_000)).toEqual(draft())
    })

    it('is versioned, and a version this code does not read starts fresh', () => {
        parkDraft(draft(), T0)
        const raw = JSON.parse(sessionStorage.getItem('nx-api-key-draft')!)
        expect(raw.v).toBe(2)
        sessionStorage.setItem('nx-api-key-draft', JSON.stringify({ ...raw, v: 1 }))
        expect(peekDraft(T0)).toBeNull()
    })

    it('lasts 30 minutes', () => {
        parkDraft(draft(), T0)
        expect(peekDraft(T0 + DRAFT_SHELF_LIFE_MS)).not.toBeNull()
        expect(peekDraft(T0 + DRAFT_SHELF_LIFE_MS + 1)).toBeNull()
        expect(DRAFT_SHELF_LIFE_MS).toBe(30 * 60 * 1000)
    })

    it('holds no password or token, because there is no field for one', () => {
        parkDraft(draft(), T0)
        expect(sessionStorage.getItem('nx-api-key-draft')).not.toMatch(/password|token/i)
    })

    it('is cleared once read', () => {
        parkDraft(draft(), T0)
        clearDraft()
        expect(peekDraft(T0)).toBeNull()
    })

    it('starts a rotation from "same length as before"', () => {
        const key = { id: 'apk_1' } as Parameters<typeof freshDraft>[1]
        expect(freshDraft(null, key)).toMatchObject({ mode: 'rotate', keyId: 'apk_1', expiry: 'same', grace: 0 })
        expect(freshDraft(null, key, 'renew').mode).toBe('renew')
    })
})
