/**
 * Workspace Service — CRUD for workspaces.
 * A workspace binds a Provider + Graph Name + Blueprint.
 */

const ADMIN_API = '/api/v1/admin/workspaces'

export interface WorkspaceCreateRequest {
    name: string
    providerId: string
    graphName: string
    blueprintId?: string
    description?: string
}

export interface WorkspaceUpdateRequest {
    name?: string
    description?: string
    providerId?: string
    graphName?: string
    blueprintId?: string
    isActive?: boolean
}

export interface WorkspaceResponse {
    id: string
    name: string
    description?: string
    providerId: string
    graphName?: string
    blueprintId?: string
    isDefault: boolean
    isActive: boolean
    createdAt: string
    updatedAt: string
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
    if (!res.ok) {
        const text = await res.text()
        throw new Error(`Workspace API ${res.status}: ${text || res.statusText}`)
    }
    if (res.status === 204) return undefined as T
    return res.json()
}

export const workspaceService = {
    list(): Promise<WorkspaceResponse[]> {
        return request<WorkspaceResponse[]>(ADMIN_API)
    },

    get(id: string): Promise<WorkspaceResponse> {
        return request<WorkspaceResponse>(`${ADMIN_API}/${id}`)
    },

    create(req: WorkspaceCreateRequest): Promise<WorkspaceResponse> {
        return request<WorkspaceResponse>(ADMIN_API, {
            method: 'POST',
            body: JSON.stringify(req),
        })
    },

    update(id: string, req: WorkspaceUpdateRequest): Promise<WorkspaceResponse> {
        return request<WorkspaceResponse>(`${ADMIN_API}/${id}`, {
            method: 'PUT',
            body: JSON.stringify(req),
        })
    },

    delete(id: string): Promise<void> {
        return request<void>(`${ADMIN_API}/${id}`, { method: 'DELETE' })
    },

    setDefault(id: string): Promise<WorkspaceResponse> {
        return request<WorkspaceResponse>(`${ADMIN_API}/${id}/set-default`, {
            method: 'POST',
        })
    },
}
