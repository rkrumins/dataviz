/**
 * Platform Settings Service — deployment-wide defaults.
 *
 * The node-identity mapping: the bottom of the resolution chain a data source
 * walks (itself -> its provider -> its workspace -> here). Setting it is the
 * right move when every graph in a deployment is shaped the same way; anything
 * narrower belongs on the provider or the workspace.
 *
 * And how often browsers check for changes (Live updates): the interval every
 * manifest carries back to them.
 */

import { fetchWithTimeout } from './fetchWithTimeout'

const API = '/api/v1/admin/platform'

export interface NodeIdentityDefaults {
    /** Null when nothing is set at this level — the code default applies. */
    identityProperty?: string | null
    nameProperty?: string | null
    /** The code defaults, so an editor can show what "unset" resolves to
     *  instead of presenting an empty field with no meaning. */
    defaultIdentityProperty: string
    defaultNameProperty: string
    updatedAt?: string | null
    updatedBy?: string | null
}

/** Partial update: omit a field to leave it untouched, send "" to clear it. */
export interface NodeIdentityDefaultsRequest {
    identityProperty?: string
    nameProperty?: string
}

export interface LiveUpdatesSettings {
    /** Null when unset — the default applies. */
    checkIntervalSeconds: number | null
    /** The default and the bounds the server enforces, so an editor can
     *  show what "unset" means and refuse what the server would. */
    defaultCheckIntervalSeconds: number
    minCheckIntervalSeconds: number
    maxCheckIntervalSeconds: number
    updatedAt?: string | null
    updatedBy?: string | null
}

/** A number sets the interval; null clears it back to the default. */
export interface LiveUpdatesRequest {
    checkIntervalSeconds: number | null
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetchWithTimeout(`${API}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...init,
    })
    if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(detail || `Request failed: ${res.status}`)
    }
    return res.json() as Promise<T>
}

export const platformSettingsService = {
    getNodeIdentityDefaults(): Promise<NodeIdentityDefaults> {
        return request<NodeIdentityDefaults>('/node-identity')
    },

    setNodeIdentityDefaults(
        req: NodeIdentityDefaultsRequest,
    ): Promise<NodeIdentityDefaults> {
        return request<NodeIdentityDefaults>('/node-identity', {
            method: 'PUT',
            body: JSON.stringify(req),
        })
    },

    getLiveUpdates(): Promise<LiveUpdatesSettings> {
        return request<LiveUpdatesSettings>('/live-updates')
    },

    setLiveUpdates(req: LiveUpdatesRequest): Promise<LiveUpdatesSettings> {
        return request<LiveUpdatesSettings>('/live-updates', {
            method: 'PUT',
            body: JSON.stringify(req),
        })
    },
}
