/**
 * The create/rotate choices, and parking them across a sign-in.
 *
 * Confirming it's you with an identity provider leaves the page, so what was
 * chosen waits in `sessionStorage` — never a password, never a token — and is
 * picked up when the provider sends you back, at the step you left from.
 *
 * A parked draft is versioned and lasts 30 minutes: a shape this code no
 * longer reads, or a form someone walked away from, starts fresh rather than
 * coming back half-understood. It also says whose keys it is for, so a
 * service account's comes back on that account's page and nowhere else.
 */
import type { ApiKey, ApiKeyOptions, ApiKeyPermissions, PickerItem, RotateApiKeyBody } from '@/services/apiKeyService'
import { defaultExpiry, type ExpiryChoice } from './apiKeyFormat'
import type { PresetId } from './presets'

export type ResourceMode = 'all' | 'workspaces' | 'items'
export type Grace = RotateApiKeyBody['graceSeconds']
export type WizardStep = 'purpose' | 'reach' | 'permissions' | 'safety' | 'review'

export const DRAFT_VERSION = 2
/** How long a parked draft waits for its owner to come back. */
export const DRAFT_SHELF_LIFE_MS = 30 * 60 * 1000

/** Everything the form holds, minus secrets: what is parked across a sign-in. */
export interface ApiKeyDraft {
    v: typeof DRAFT_VERSION
    /** Renew is a rotation of a key that has stopped: no grace to give. */
    mode: 'create' | 'rotate' | 'renew'
    keyId?: string
    step: WizardStep
    preset: PresetId | null
    name: string
    description: string
    resourceMode: ResourceMode
    workspaces: string[]
    views: PickerItem[]
    dataSources: PickerItem[]
    permissions: ApiKeyPermissions
    expiry: ExpiryChoice | 'same'
    customDate: string
    cidrs: string[]
    grace: Grace
    /** The service account the key is for; absent for your own. */
    principal?: string
}

const DRAFT_KEY = 'nx-api-key-draft'

export function parkDraft(draft: ApiKeyDraft, now: number = Date.now()): void {
    try {
        sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, savedAt: now }))
    } catch {
        // Private mode: the form simply starts empty when they come back.
    }
}

/** The parked draft, if it is one this code reads, it is still fresh, and it
 *  is for these keys: a service account's (`principal`), or your own. */
export function peekDraft(now: number = Date.now(), principal: string | null = null): ApiKeyDraft | null {
    try {
        const raw = sessionStorage.getItem(DRAFT_KEY)
        if (!raw) return null
        const { savedAt, ...draft } = JSON.parse(raw) as ApiKeyDraft & { savedAt?: number }
        if (draft.v !== DRAFT_VERSION || typeof savedAt !== 'number') return null
        if (now - savedAt > DRAFT_SHELF_LIFE_MS || now < savedAt) return null
        if ((draft.principal ?? null) !== principal) return null
        return draft
    } catch {
        return null
    }
}

/** A draft is used once: cleared as soon as the page has read it. */
export function clearDraft(): void {
    try {
        sessionStorage.removeItem(DRAFT_KEY)
    } catch {
        // Nothing was parked where nothing can be stored.
    }
}

export function freshDraft(
    options: ApiKeyOptions | null, rotating?: ApiKey, mode: ApiKeyDraft['mode'] = rotating ? 'rotate' : 'create',
): ApiKeyDraft {
    return {
        v: DRAFT_VERSION,
        mode,
        keyId: rotating?.id,
        step: 'purpose',
        preset: null,
        name: '',
        description: '',
        resourceMode: 'items',
        workspaces: [],
        views: [],
        dataSources: [],
        permissions: { views: 'read', data: 'none', publish: false },
        expiry: rotating ? 'same' : defaultExpiry(options?.policy.maxLifetimeDays ?? null),
        customDate: '',
        cidrs: [],
        grace: 0,
    }
}
