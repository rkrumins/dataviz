/**
 * API client for the top-level /views endpoints.
 * All view CRUD goes through this service.
 */

export interface ViewApiResponse {
  id: string
  workspaceId?: string
  workspaceName?: string
  dataSourceId?: string
  connectionId?: string
  name: string
  description?: string
  viewType: string
  config: Record<string, unknown>
  scopeFilter?: Record<string, unknown>
  visibility: string
  createdBy?: string
  tags?: string[]
  isPinned: boolean
  favouriteCount: number
  isFavourited: boolean
  createdAt: string
  updatedAt: string
}

export interface CreateViewRequest {
  name: string
  description?: string
  viewType?: string
  config?: Record<string, unknown>
  scopeFilter?: Record<string, unknown>
  workspaceId: string
  dataSourceId?: string
  visibility?: string
  tags?: string[]
  isPinned?: boolean
}

export interface UpdateViewRequest extends CreateViewRequest {}

export interface ListViewsParams {
  visibility?: string
  workspaceId?: string
  search?: string
  tags?: string[]
  limit?: number
  offset?: number
}

const BASE = '/api/v1/views'

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText)
    throw new Error(`API error ${res.status}: ${detail}`)
  }
  return res.json()
}

export const viewsApi = {
  async list(params?: ListViewsParams): Promise<ViewApiResponse[]> {
    const url = new URL(BASE, window.location.origin)
    if (params?.visibility) url.searchParams.set('visibility', params.visibility)
    if (params?.workspaceId) url.searchParams.set('workspaceId', params.workspaceId)
    if (params?.search) url.searchParams.set('search', params.search)
    if (params?.tags) params.tags.forEach(t => url.searchParams.append('tags', t))
    if (params?.limit) url.searchParams.set('limit', String(params.limit))
    if (params?.offset) url.searchParams.set('offset', String(params.offset))
    return handleResponse<ViewApiResponse[]>(await fetch(url.toString()))
  },

  async get(viewId: string): Promise<ViewApiResponse> {
    return handleResponse<ViewApiResponse>(await fetch(`${BASE}/${viewId}`))
  },

  async create(req: CreateViewRequest): Promise<ViewApiResponse> {
    return handleResponse<ViewApiResponse>(
      await fetch(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      })
    )
  },

  async update(viewId: string, req: UpdateViewRequest): Promise<ViewApiResponse> {
    return handleResponse<ViewApiResponse>(
      await fetch(`${BASE}/${viewId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      })
    )
  },

  async delete(viewId: string): Promise<void> {
    const res = await fetch(`${BASE}/${viewId}`, { method: 'DELETE' })
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText)
      throw new Error(`API error ${res.status}: ${detail}`)
    }
  },

  async updateVisibility(
    viewId: string,
    visibility: 'private' | 'workspace' | 'enterprise'
  ): Promise<ViewApiResponse> {
    return handleResponse<ViewApiResponse>(
      await fetch(`${BASE}/${viewId}/visibility`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visibility }),
      })
    )
  },

  async favourite(viewId: string): Promise<void> {
    const res = await fetch(`${BASE}/${viewId}/favourite`, { method: 'POST' })
    if (!res.ok) throw new Error(`Failed to favourite view: ${res.status}`)
  },

  async unfavourite(viewId: string): Promise<void> {
    const res = await fetch(`${BASE}/${viewId}/favourite`, { method: 'DELETE' })
    if (!res.ok) throw new Error(`Failed to unfavourite view: ${res.status}`)
  },

  async listPopular(limit = 20): Promise<ViewApiResponse[]> {
    return handleResponse<ViewApiResponse[]>(
      await fetch(`${BASE}/popular?limit=${limit}`)
    )
  },
}
