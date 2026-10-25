/**
 * Starting points for a key, named for the job rather than the permission.
 *
 * Each sets what the key may do, how it is limited and how long it lasts —
 * all still editable on the steps after. A preset its owner cannot satisfy
 * (nobody can give a key more than they hold) is offered disabled, with the
 * reason, judged from the levels they hold in their workspaces.
 */
import type { ApiKeyPermissions, Level, WorkspaceAccess } from '@/services/apiKeyService'
import { RANK, fitExpiry, type ExpiryChoice } from './apiKeyFormat'
import type { ApiKeyDraft, ResourceMode } from './apiKeyDraft'
import { ownerWords, type OwnerWords } from './keyClient'

export type PresetId = 'reporting' | 'loading' | 'publishing' | 'custom'

export interface Preset {
    id: PresetId
    title: string
    blurb: string
    /** A name to start from, shown in the empty name field. */
    example: string
    permissions: ApiKeyPermissions
    resourceMode: ResourceMode
    expiry: ExpiryChoice
}

export const PRESETS: Preset[] = [
    {
        id: 'reporting',
        title: 'Read data for reporting',
        blurb: 'Dashboards, notebooks and exports that read views and graphs. Changes nothing.',
        example: 'Quarterly revenue dashboard',
        permissions: { views: 'read', data: 'read', publish: false },
        resourceMode: 'items',
        expiry: '90',
    },
    {
        id: 'loading',
        title: 'Load data and signal refreshes',
        blurb: 'A pipeline that writes to graphs and tells the platform a data source changed.',
        example: 'Nightly warehouse load',
        permissions: { views: 'none', data: 'write', publish: false },
        resourceMode: 'items',
        expiry: '30',
    },
    {
        id: 'publishing',
        title: 'Publish views from CI',
        blurb: 'A build that keeps views in step with code and publishes them to everyone.',
        example: 'CI view publisher',
        permissions: { views: 'write', data: 'read', publish: true },
        resourceMode: 'workspaces',
        expiry: '90',
    },
    {
        id: 'custom',
        title: 'Custom',
        blurb: 'Start from read-only on what you pick, and choose everything yourself.',
        example: 'Inventory script',
        permissions: { views: 'read', data: 'none', publish: false },
        resourceMode: 'items',
        expiry: '30',
    },
]

export function presetById(id: PresetId | null): Preset | null {
    return PRESETS.find((p) => p.id === id) ?? null
}

const CANNOT: Record<'views' | 'data', Record<Exclude<Level, 'none'>, string>> = {
    views: { read: 'read views', write: 'edit views' },
    data: { read: 'read data', write: 'change data' },
}

/**
 * Whether the keys' owner — you, or a service account — can have this kind of
 * key, and if not why. One workspace has to give everything the preset asks
 * for, because that is where its key works.
 */
export function presetAvailability(
    preset: Preset, workspaces: WorkspaceAccess[], owner: OwnerWords = ownerWords(null),
): { available: true; reason: null } | { available: false; reason: string } {
    if (preset.id === 'custom') return { available: true, reason: null }
    if (workspaces.length === 0) {
        return { available: false, reason: `${owner.subject} ${owner.is} not a member of any workspace yet.` }
    }
    const p = preset.permissions
    const fits = (w: WorkspaceAccess) => RANK[w.views] >= RANK[p.views]
        && RANK[w.data] >= RANK[p.data]
        && (!p.publish || w.publish)
    if (workspaces.some(fits)) return { available: true, reason: null }

    if (p.publish && !workspaces.some((w) => w.publish)) {
        return { available: false, reason: `${owner.subject} cannot publish views in any workspace.` }
    }
    for (const kind of ['views', 'data'] as const) {
        const level = p[kind]
        if (level !== 'none' && !workspaces.some((w) => RANK[w[kind]] >= RANK[level])) {
            return { available: false, reason: `${owner.subject} cannot ${CANNOT[kind][level]} in any workspace.` }
        }
    }
    return { available: false, reason: `No one workspace gives ${owner.object} everything this needs.` }
}

/** What choosing a preset sets: its access, its reach and its lifetime. */
export function presetPatch(
    preset: Preset, maxLifetimeDays: number | null,
): Pick<ApiKeyDraft, 'preset' | 'permissions' | 'resourceMode' | 'expiry'> {
    return {
        preset: preset.id,
        permissions: { ...preset.permissions },
        resourceMode: preset.resourceMode,
        expiry: fitExpiry(preset.expiry, maxLifetimeDays),
    }
}
