/**
 * Connection Service — CRUD for registered graph database connections.
 *
 * All requests go to /api/v1/connections (the visualization service).
 * The graph service (/graph/v1/providers/*) is used for pre-registration
 * ping/discovery and is called directly from the ConnectionsPanel UI.
 */

import { fetchWithTimeout } from './fetchWithTimeout'

const API = '/api/v1/connections'

export interface ConnectionCredentials {
    username?: string
    password?: string
    token?: string
}

export interface ConnectionCreateRequest {
    name: string
    providerType: 'falkordb' | 'neo4j' | 'datahub' | 'mock'
    host?: string
    port?: number
    graphName?: string
    credentials?: ConnectionCredentials
    tlsEnabled?: boolean
    extraConfig?: Record<string, unknown>
}

export interface ConnectionUpdateRequest {
    name?: string
    host?: string
    port?: number
    graphName?: string
    credentials?: ConnectionCredentials
    tlsEnabled?: boolean
    isActive?: boolean
    extraConfig?: Record<string, unknown>
}

export interface ConnectionResponse {
    id: string
    name: string
    providerType: 'falkordb' | 'neo4j' | 'datahub' | 'mock'
    host?: string
    port?: number
    graphName?: string
    tlsEnabled: boolean
    isPrimary: boolean
    isActive: boolean
    extraConfig?: Record<string, unknown>
    createdAt: string
    updatedAt: string
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetchWithTimeout(url, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
    if (!res.ok) {
        const text = await res.text()
        throw new Error(`Connection API ${res.status}: ${text || res.statusText}`)
    }
    if (res.status === 204) return undefined as T
    return res.json()
}

export const connectionService = {
    list(): Promise<ConnectionResponse[]> {
        return request<ConnectionResponse[]>(API)
    },

    get(id: string): Promise<ConnectionResponse> {
        return request<ConnectionResponse>(`${API}/${id}`)
    },

    create(req: ConnectionCreateRequest): Promise<ConnectionResponse> {
        return request<ConnectionResponse>(API, {
            method: 'POST',
            body: JSON.stringify(req),
        })
    },

    update(id: string, req: ConnectionUpdateRequest): Promise<ConnectionResponse> {
        return request<ConnectionResponse>(`${API}/${id}`, {
            method: 'PUT',
            body: JSON.stringify(req),
        })
    },

    delete(id: string): Promise<void> {
        return request<void>(`${API}/${id}`, { method: 'DELETE' })
    },

    test(id: string): Promise<{ status: string; latencyMs: number }> {
        return request<{ status: string; latencyMs: number }>(`${API}/${id}/test`, {
            method: 'POST',
        })
    },

    setPrimary(id: string): Promise<ConnectionResponse> {
        return request<ConnectionResponse>(`${API}/${id}/set-primary`, {
            method: 'POST',
        })
    },

    listGraphs(id: string): Promise<{ graphs: string[] }> {
        return request<{ graphs: string[] }>(`${API}/${id}/graphs`)
    },
}
