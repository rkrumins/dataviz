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

/** A key ended by its own rotation was replaced, not revoked. */
export function statusLabel(key: Pick<ApiKey, 'status' | 'revokedReason'>): string {
    if (key.status === 'revoked' && key.revokedReason === 'rotated') return 'Replaced'
    return STATUS_LABEL[key.status] ?? key.status
}

/** Who ended a key, in words — the owner's page and the inventory differ on "you". */
export function describeRevocation(key: Pick<ApiKey, 'revokedReason'>, viewer: 'owner' | 'admin'): string {
    switch (key.revokedReason) {
        case 'rotated': return 'Replaced by a new key'
        case 'owner': return viewer === 'owner' ? 'You revoked it' : 'Revoked by its owner'
        case 'admin': return 'Revoked by an administrator'
        case 'self': return 'Revoked with the key itself'
        default: return 'Revoked'
    }
}

export function isLive(key: Pick<ApiKey, 'status'>): boolean {
    return key.status === 'active' || key.status === 'paused'
}

/**
 * Renewing makes a fresh token for a key whose time ran out. Not a paused
 * one: its owner signing in again resumes it — the very sign-in a renewal
 * would ask for — so renewing would revoke a working key for nothing.
 */
export function isRenewable(key: Pick<ApiKey, 'status'>): boolean {
    return key.status === 'expired'
}

// ── Time, in words ──────────────────────────────────────────────────

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function plural(n: number, one: string): string {
    return `${n} ${one}${n === 1 ? '' : 's'}`
}

/** "just now", "28 minutes ago", "3 days ago" — from `now`, so it can be pinned. */
export function ago(iso: string, now: Date = new Date()): string {
    const ms = now.getTime() - new Date(iso).getTime()
    if (ms < MINUTE) return 'just now'
    if (ms < HOUR) return `${plural(Math.floor(ms / MINUTE), 'minute')} ago`
    if (ms < DAY) return `${plural(Math.floor(ms / HOUR), 'hour')} ago`
    if (ms < 30 * DAY) return `${plural(Math.floor(ms / DAY), 'day')} ago`
    if (ms < 365 * DAY) return `${plural(Math.floor(ms / (30 * DAY)), 'month')} ago`
    return `${plural(Math.floor(ms / (365 * DAY)), 'year')} ago`
}

/** "Fri, Oct 17" this year; "Oct 13, 2027" another — a weekday says little that far off. */
export function formatDay(iso: string, now: Date = new Date()): string {
    const at = new Date(iso)
    return at.toLocaleDateString(undefined, at.getFullYear() === now.getFullYear()
        ? { weekday: 'short', month: 'short', day: 'numeric' }
        : { month: 'short', day: 'numeric', year: 'numeric' })
}

/** "today at 14:00", "tomorrow at 09:30", "Fri, Oct 17 at 14:00". */
export function formatWhen(at: Date, now: Date = new Date()): string {
    const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    const days = Math.round(
        (new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY,
    )
    if (days === 0) return `today at ${time}`
    if (days === 1) return `tomorrow at ${time}`
    return `${formatDay(at.toISOString(), now)} at ${time}`
}

/**
 * How close a key is to stopping, as the card shows it.
 *
 * `urgent` is under a day, `soon` within a week — the window the page's
 * banner and the owner's reminder use — `calm` beyond it, `ended` once
 * passed, and `never` for a key without an end, which is its own kind of
 * attention rather than none.
 */
export type Urgency = 'never' | 'calm' | 'soon' | 'urgent' | 'ended'

export interface Countdown {
    label: string
    tone: Urgency
    /** Whole days left, rounded; null when it never expires. */
    days: number | null
}

export function expiryCountdown(expiresAt: string | null, now: Date = new Date()): Countdown {
    if (!expiresAt) return { label: 'Never expires', tone: 'never', days: null }
    const ms = new Date(expiresAt).getTime() - now.getTime()
    if (ms <= 0) {
        const past = -ms
        const label = past < DAY ? 'Expired today'
            : past < 2 * DAY ? 'Expired yesterday'
                : `Expired ${ago(expiresAt, now)}`
        return { label, tone: 'ended', days: -Math.floor(past / DAY) }
    }
    const days = Math.round(ms / DAY)
    if (ms < HOUR) return { label: 'Expires in under an hour', tone: 'urgent', days: 0 }
    if (ms < DAY) return { label: `Expires in ${plural(Math.floor(ms / HOUR), 'hour')}`, tone: 'urgent', days: 0 }
    if (ms <= 7 * DAY) return { label: `Expires in ${plural(days, 'day')}`, tone: 'soon', days }
    if (days <= 60) return { label: `Expires in ${days} days`, tone: 'calm', days }
    if (days < 365) return { label: `Expires in ${Math.round(days / 30)} months`, tone: 'calm', days }
    return { label: `Expires in ${plural(Math.round(days / 365), 'year')}`, tone: 'calm', days }
}

/** "python-httpx 0.27.0", "curl 8.5.0", "Chrome 120" — the program, not the string. */
export function clientName(userAgent: string | null): string | null {
    if (!userAgent?.trim()) return null
    const browser = /\b(Edg|Firefox|Chrome|Safari)\/(\d+)/.exec(userAgent)
    if (/^Mozilla\//.test(userAgent) && browser) {
        return `${browser[1] === 'Edg' ? 'Edge' : browser[1]} ${browser[2]}`
    }
    const [product] = userAgent.trim().split(/\s+/)
    return product.replace('/', ' ')
}

/** When a key was last used, and from where: "28 minutes ago", "203.0.113.24 · curl 8.5.0". */
export function describeLastUsed(
    key: Pick<ApiKey, 'lastUsedAt' | 'lastUsedIp' | 'lastUsedUserAgent'>,
    now: Date = new Date(),
): { when: string; where: string | null } {
    if (!key.lastUsedAt) return { when: 'Never used', where: null }
    const where = [key.lastUsedIp, clientName(key.lastUsedUserAgent)].filter(Boolean).join(' · ')
    return { when: `Used ${ago(key.lastUsedAt, now)}`, where: where || null }
}

/**
 * An expired key something still calls: its refusals keep arriving. Worth
 * saying, because whatever calls it is failing right now.
 */
export function stillCalled(key: Pick<ApiKey, 'status' | 'usage'>): number {
    if (key.status !== 'expired') return 0
    return key.usage.daily14.slice(-7).reduce((n, v) => n + v, 0)
}

// ── Expiry ──────────────────────────────────────────────────────────

export type ExpiryChoice = '7' | '30' | '90' | '365' | 'custom' | 'never'

export interface ExpiryOption {
    value: ExpiryChoice
    label: string
}

const PRESETS: ExpiryOption[] = [
    { value: '7', label: '7 days' },
    { value: '30', label: '30 days' },
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

/** The choice itself when the deployment allows it, else the longest that it does. */
export function fitExpiry(choice: ExpiryChoice, maxLifetimeDays: number | null): ExpiryChoice {
    const allowed = expiryOptions(maxLifetimeDays).map((o) => o.value)
    if (allowed.includes(choice)) return choice
    const shorter = allowed.filter((v) => v !== 'custom' && v !== 'never')
    return shorter[shorter.length - 1] ?? 'custom'
}

/** How many days a choice lasts; null for never. */
export function expiryDays(choice: ExpiryChoice, customDate: string, now: Date = new Date()): number | null {
    if (choice === 'never') return null
    if (choice !== 'custom') return Number(choice)
    const end = new Date(`${customDate}T23:59:59Z`).getTime()
    return Number.isNaN(end) ? 0 : Math.max(0, Math.ceil((end - now.getTime()) / DAY))
}

/** What is wrong with a custom last day: it is after today, and inside the deployment's maximum. */
export function customDateProblem(date: string, maxLifetimeDays: number | null, now: Date = new Date()): string | null {
    if (!date) return 'Pick the last day it should work.'
    const end = new Date(`${date}T23:59:59Z`).getTime()
    if (Number.isNaN(end)) return 'That is not a date.'
    if (end <= now.getTime()) return 'Pick a day after today.'
    if (maxLifetimeDays !== null && end - now.getTime() > (maxLifetimeDays + 1) * DAY) {
        return `Keys here last at most ${maxLifetimeDays} days.`
    }
    return null
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

/** A key allows at most this many networks. */
export const MAX_CIDRS = 20

function ipv4Problem(address: string): string | null {
    const parts = address.split('.')
    if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p))) return 'is not an address or network'
    if (parts.some((p) => Number(p) > 255)) return 'has a part above 255'
    return null
}

function ipv6Problem(address: string): string | null {
    if (!/^[0-9a-fA-F:.]+$/.test(address) || (address.match(/::/g) ?? []).length > 1) {
        return 'is not an address or network'
    }
    const groups = address.split(':')
    const tail = groups[groups.length - 1]
    const v4 = tail.includes('.')
    if (v4 && ipv4Problem(tail)) return 'is not an address or network'
    const hex = v4 ? groups.slice(0, -1) : groups
    if (hex.some((g) => g.length > 4)) return 'is not an address or network'
    const width = hex.filter(Boolean).length + (v4 ? 2 : 0)
    if (address.includes('::') ? width > 7 : width !== 8) return 'is not an address or network'
    return null
}

/**
 * What is wrong with one network entry, or null. An address, or a network in
 * CIDR form; host bits are fine — the server keeps the network they belong to.
 */
export function cidrProblem(entry: string): string | null {
    const [address, prefix, extra] = entry.trim().split('/')
    if (extra !== undefined || !address) return 'is not an address or network'
    const v6 = address.includes(':')
    const problem = v6 ? ipv6Problem(address) : ipv4Problem(address)
    if (problem) return problem
    if (prefix === undefined) return null
    const max = v6 ? 128 : 32
    if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > max) return `needs a prefix from 0 to ${max}`
    return null
}

// ── Asking for more than you have ──────────────────────────────────

/** Levels in order, so "at least read" is a comparison. */
export const RANK: Record<Level, number> = { none: 0, read: 1, write: 2 }

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
