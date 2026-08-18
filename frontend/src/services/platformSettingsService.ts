/**
 * Platform Settings Service — deployment-wide defaults.
 *
 * Currently the node-identity mapping: the bottom of the resolution chain a
 * data source walks (itself -> its provider -> its workspace -> here). Setting
 * it is the right move when every graph in a deployment is shaped the same way;
 * anything narrower belongs on the provider or the workspace.
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
}
