/**
 * How an API key reads to a person: what it may do, on what, until when.
 * Pure, so the page and the admin inventory say it the same way.
 */
import type {
    ApiKey, ApiKeyPermissions, ApiKeyResources, ApiKeyStatus, Level, PickerItem,
} from '@/services/apiKeyService'

const LEVEL_WORD: Record<Level, string> = { none: 'no', read: 'read', write: 'read & write' }

/** "Views: read & write · Publish · Data: read" */
export function describePermissions(p: ApiKeyPermissions): string {
    const parts: string[] = []
    if (p.views !== 'none') parts.push(`Views: ${LEVEL_WORD[p.views]}`)
    if (p.publish) parts.push('Publish')
    if (p.data !== 'none') parts.push(`Data: ${LEVEL_WORD[p.data]}`)
    return parts.join(' · ') || 'Nothing'
}

function count(n: number, one: string, many: string): string | null {
    if (n === 0) return null
    return `${n} ${n === 1 ? one : many}`
}

/** "Everything you can access", or "2 workspaces, 1 view". */
export function describeResources(r: ApiKeyResources): string {
    if (r === 'all') return 'Everything you can access'
    return [
        count(r.workspaces?.length ?? 0, 'workspace', 'workspaces'),
        count(r.views?.length ?? 0, 'view', 'views'),
        count(r.dataSources?.length ?? 0, 'data source', 'data sources'),
    ].filter(Boolean).join(', ') || 'Nothing selected'
}

export const STATUS_LABEL: Record<ApiKeyStatus, string> = {
    active: 'Active',
    paused: 'Paused — sign in to resume',
    expired: 'Expired',
    revoked: 'Revoked',
    owner_inactive: 'Owner suspended',
    ip_not_allowed: 'Used from an address it does not allow',
}

export function isLive(key: Pick<ApiKey, 'status'>): boolean {
    return key.status === 'active' || key.status === 'paused'
}

// ── Expiry ──────────────────────────────────────────────────────────

export type ExpiryChoice = '7' | '30' | '60' | '90' | '365' | 'custom' | 'never'

export interface ExpiryOption {
    value: ExpiryChoice
    label: string
}

const PRESETS: ExpiryOption[] = [
    { value: '7', label: '7 days' },
    { value: '30', label: '30 days' },
    { value: '60', label: '60 days' },
    { value: '90', label: '90 days' },
    { value: '365', label: '1 year' },
    { value: 'custom', label: 'Custom date' },
    { value: 'never', label: 'Never' },
]

/** The choices the deployment allows: nothing past its maximum, and "never"
 *  only when there is no maximum. */
export function expiryOptions(maxLifetimeDays: number | null): ExpiryOption[] {
    return PRESETS.filter((o) => {
        if (o.value === 'never') return maxLifetimeDays === null
        if (o.value === 'custom') return true
        return maxLifetimeDays === null || Number(o.value) <= maxLifetimeDays
    })
}

/** 30 days, or the longest the deployment allows if that is shorter. */
export function defaultExpiry(maxLifetimeDays: number | null): ExpiryChoice {
    if (maxLifetimeDays === null || maxLifetimeDays >= 30) return '30'
    return '7'
}

/** The request's expiry fields for a choice; a custom date ends that day. */
export function expiryFields(
    choice: ExpiryChoice, customDate: string, now: Date = new Date(),
): { expiresAt: string | null; neverExpires: boolean } {
    if (choice === 'never') return { expiresAt: null, neverExpires: true }
    if (choice === 'custom') {
        const end = customDate ? new Date(`${customDate}T23:59:59Z`) : null
        return { expiresAt: end && !Number.isNaN(end.getTime()) ? end.toISOString() : null, neverExpires: false }
    }
    const at = new Date(now.getTime() + Number(choice) * 24 * 60 * 60 * 1000)
    return { expiresAt: at.toISOString(), neverExpires: false }
}

// ── Networks ────────────────────────────────────────────────────────

/** One address or network per line, or comma-separated; blanks dropped. */
export function parseCidrs(text: string): string[] {
    return text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
}

// ── Asking for more than you have ──────────────────────────────────

const RANK: Record<Level, number> = { none: 0, read: 1, write: 2 }

/**
 * The picked views and data sources the key would get less on than its
 * permissions say, because their owner holds less there. Not an error — a
 * key never reaches past its owner — but worth saying before it is made.
 */
export function overreach(
    permissions: ApiKeyPermissions,
    views: PickerItem[],
    dataSources: PickerItem[],
): PickerItem[] {
    return [
        ...views.filter((v) => RANK[permissions.views] > RANK[v.level]),
        ...dataSources.filter((d) => RANK[permissions.data] > RANK[d.level]),
    ]
}

/** A `curl` line to check the key works: `/api-keys/self` describes the key
 *  making the request and changes nothing. */
export function curlExample(token: string, origin: string): string {
    return `curl -H "Authorization: Bearer ${token}" ${origin}/api/v1/api-keys/self`
}
