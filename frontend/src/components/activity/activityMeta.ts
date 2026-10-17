/**
 * How the explorer names, colours and groups the ledger's six categories.
 *
 * The slot is the category's index in `ACTIVITY_CATEGORIES` and never changes:
 * colour follows the entity, so "Operations is indigo" holds on every chart,
 * chip and timeline row, whatever a filter leaves on screen.
 */
import {
    Database, Fingerprint, KeyRound, LayoutGrid, Settings2, Workflow,
    type LucideIcon,
} from 'lucide-react'

import {
    ACTIVITY_CATEGORIES,
    type ActivityCategory,
    type ActivityEvent,
    type ActivityScope,
} from '@/services/activityService'

export interface CategoryMeta {
    label: string
    /** Index into the chart palette — fixed, see the module note. */
    slot: number
    icon: LucideIcon
    description: string
}

export const CATEGORY_META: Record<ActivityCategory, CategoryMeta> = {
    operations: {
        label: 'Operations', slot: 0, icon: Workflow,
        description: 'Aggregation runs, refreshes, reconciliation and ingestion jobs started by hand',
    },
    access: {
        label: 'Access', slot: 1, icon: KeyRound,
        description: 'Roles, groups, workspace members, view shares and access requests',
    },
    identity: {
        label: 'Identity', slot: 2, icon: Fingerprint,
        description: 'Sign-ins, sessions, SSO, identity providers and invites',
    },
    data: {
        label: 'Data', slot: 3, icon: Database,
        description: 'Data sources, providers, workspaces and version control',
    },
    content: {
        label: 'Content', slot: 4, icon: LayoutGrid,
        description: 'Views and ontologies',
    },
    platform: {
        label: 'Platform', slot: 5, icon: Settings2,
        description: 'Feature flags, platform settings, branding and activity exports',
    },
}

export const slotOf = (category: string): number =>
    Math.max(0, ACTIVITY_CATEGORIES.indexOf(category as ActivityCategory))

/** A one-click question. `categories` empty means every category. */
export interface Lens {
    id: string
    label: string
    categories: ActivityCategory[]
    /** Also show the per-request refusals "Everything" leaves out. */
    includeNoise?: boolean
    hint: string
}

export const LENSES: Lens[] = [
    {
        id: 'everything', label: 'Everything', categories: [],
        hint: 'Every recorded change. Routine per-request refusals are left out — Security shows them.',
    },
    { id: 'operations', label: 'Operations', categories: ['operations'], hint: CATEGORY_META.operations.description },
    { id: 'access', label: 'Access', categories: ['access'], hint: CATEGORY_META.access.description },
    { id: 'identity', label: 'Identity', categories: ['identity'], hint: CATEGORY_META.identity.description },
    { id: 'data', label: 'Data', categories: ['data'], hint: CATEGORY_META.data.description },
    { id: 'content', label: 'Content', categories: ['content'], hint: CATEGORY_META.content.description },
    { id: 'platform', label: 'Platform', categories: ['platform'], hint: CATEGORY_META.platform.description },
    {
        id: 'security', label: 'Security', categories: ['identity', 'access'], includeNoise: true,
        hint: 'Identity and access together, including every refused request.',
    },
]

/** What a workspace admin's lens can hold: the server shows them nothing else. */
export const WORKSPACE_LENS_IDS = ['everything', 'operations', 'access', 'data'] as const

export const DEFAULT_LENS = 'everything'

/** Categories where a person's change is expected to say why. A sign-in or
 *  a view saved has no "why" worth asking for; a rebuild or a grant does. */
const REASONED: ReadonlySet<string> = new Set(['operations', 'access', 'data', 'platform'])

/** True when the row should say "No reason given" out loud: a person changed
 *  something that warrants one, and gave none. */
export function reasonExpected(event: Pick<ActivityEvent, 'actorKind' | 'category' | 'statedReason'>): boolean {
    return event.actorKind === 'user' && REASONED.has(event.category) && !event.statedReason
}

/** Name of a person as the timeline writes it; `null` when no one acted. */
export function actorName(event: Pick<ActivityEvent, 'actor' | 'actorKind'>): string | null {
    if (event.actor) return event.actor.name || event.actor.email || event.actor.id
    if (event.actorKind === 'system') return 'The platform'
    if (event.actorKind === 'service') return 'A service'
    if (event.actorKind === 'anonymous') return 'Someone not signed in'
    return null
}

/**
 * Which activity a workspace page shows, if any. An auditor reads everything
 * recorded against the workspace, through the platform log; the workspace's
 * own admin reads its workspace-audience activity. Anyone else sees no tab.
 */
export function workspaceActivityScope(
    workspaceId: string | undefined,
    { isAdmin, isAuditor }: { isAdmin: boolean; isAuditor: boolean },
): ActivityScope | null {
    if (!workspaceId || !(isAdmin || isAuditor)) return null
    return { kind: 'workspace', workspaceId, asAuditor: isAuditor }
}

/** "every ~3 days", from the usual gap between a source's manual operations. */
export function cadencePhrase(medianGapHours: number | null): string | null {
    if (medianGapHours === null) return null
    if (medianGapHours < 1) return 'several times an hour'
    if (medianGapHours < 36) return `every ~${Math.round(medianGapHours)}h`
    return `every ~${Math.round(medianGapHours / 24)} days`
}

/** "2 years", "400 days": how long the log keeps activity. */
export function retentionPhrase(days: number): string {
    if (days % 365 !== 0) return `${days} days`
    const years = days / 365
    return `${years} year${years === 1 ? '' : 's'}`
}

/** A user id, as a drill-in writes it — not text to match against names. */
export const isPersonId = (value: string) => /^usr_[A-Za-z0-9_-]{2,}$/.test(value)

const addDays = (day: string, n: number) =>
    new Date(Date.parse(`${day.slice(0, 10)}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/**
 * The days a span of chart buckets covers, as a custom range. A week bucket
 * runs six days past the day it starts, but a span never reaches past the
 * window's own last day.
 */
export function spanToRange(
    buckets: string[], granularity: 'day' | 'week', first: number, last: number, lastDay: string,
): { kind: 'custom'; from: string; to: string } {
    const end = granularity === 'week' ? addDays(buckets[last], 6) : buckets[last].slice(0, 10)
    return { kind: 'custom', from: buckets[first].slice(0, 10), to: end < lastDay ? end : lastDay }
}
