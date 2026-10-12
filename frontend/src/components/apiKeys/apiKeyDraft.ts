/**
 * The create/rotate form's contents, and parking them across a sign-in.
 *
 * Confirming it's you with an identity provider leaves the page, so what was
 * filled in waits in `sessionStorage` — never a password, never a token — and
 * is taken (once) when the provider sends you back.
 */
import type { ApiKey, ApiKeyOptions, ApiKeyPermissions, PickerItem, RotateApiKeyBody } from '@/services/apiKeyService'
import { defaultExpiry, type ExpiryChoice } from './apiKeyFormat'

export type ResourceMode = 'all' | 'workspaces' | 'items'
export type Grace = RotateApiKeyBody['graceSeconds']

/** Everything the form holds, minus secrets: what is parked across a sign-in. */
export interface ApiKeyDraft {
    mode: 'create' | 'rotate'
    keyId?: string
    name: string
    description: string
    resourceMode: ResourceMode
    workspaces: string[]
    views: PickerItem[]
    dataSources: PickerItem[]
    permissions: ApiKeyPermissions
    expiry: ExpiryChoice | 'same'
    customDate: string
    cidrs: string
    grace: Grace
}

const DRAFT_KEY = 'nx-api-key-draft'

export function parkDraft(draft: ApiKeyDraft): void {
    try {
        sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
    } catch {
        // Private mode: the form simply starts empty when they come back.
    }
}

/** The parked draft, removed as it is read — it is used once. */
export function takeDraft(): ApiKeyDraft | null {
    try {
        const raw = sessionStorage.getItem(DRAFT_KEY)
        sessionStorage.removeItem(DRAFT_KEY)
        return raw ? (JSON.parse(raw) as ApiKeyDraft) : null
    } catch {
        return null
    }
}

export function freshDraft(options: ApiKeyOptions | null, rotating?: ApiKey): ApiKeyDraft {
    return {
        mode: rotating ? 'rotate' : 'create',
        keyId: rotating?.id,
        name: '',
        description: '',
        resourceMode: 'items',
        workspaces: [],
        views: [],
        dataSources: [],
        permissions: { views: 'read', data: 'none', publish: false },
        expiry: rotating ? 'same' : defaultExpiry(options?.policy.maxLifetimeDays ?? null),
        customDate: '',
        cidrs: '',
        grace: 0,
    }
}
