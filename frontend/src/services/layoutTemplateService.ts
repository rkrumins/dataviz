/**
 * Layout templates — reusable Context View layer arrangements, with a lifecycle.
 * Maps to ``/api/v1/layout-templates`` (``endpoints/layout_templates.py``).
 *
 * Who may do what with each template is the server's call and arrives on it as
 * ``access``: the UI offers exactly those actions and re-derives nothing from
 * permission claims. Shares reuse the view grant shapes — same table, same roles.
 */
import type { ViewLayerConfig } from '@/types/schema'
import { authFetch } from './apiClient'
import type { ViewGrantCreateRequest, ViewGrantResponse } from './viewGrantsService'

/** Stored like a view's visibility: Personal, Workspace, Organization. */
export type TemplateVisibility = 'private' | 'workspace' | 'enterprise'

export interface LayoutTemplateAccess {
    /** How the caller reaches it: their own, a share, their workspace, the
     *  organization's, or a built-in. */
    via: 'owner' | 'grant' | 'workspace' | 'organization' | 'builtin'
    canEdit: boolean
    canDelete: boolean
    /** Change who can use it: audience and shares. */
    canShare: boolean
    /** Built-ins only, for template managers. */
    canHide: boolean
}

export interface LayoutTemplate {
    id: string
    name: string
    description?: string | null
    category?: string | null
    visibility: TemplateVisibility
    builtIn: boolean
    /** A built-in hidden from everyone but template managers. */
    hidden: boolean
    workspaceId?: string | null
    workspaceName?: string | null
    layers: ViewLayerConfig[]
    createdBy?: string | null
    createdAt: string
    updatedAt: string
    /** Live views built from it that the caller can open. */
    usageCount: number
    /** People and groups it is shared with — only for those who may share it. */
    grantCount?: number | null
    access: LayoutTemplateAccess
}

export interface LayoutTemplateInput {
    name: string
    description?: string | null
    category?: string | null
    visibility: TemplateVisibility
    /** Required for the workspace tier, refused for the others. */
    workspaceId?: string | null
    layers: ViewLayerConfig[]
}

const BASE = '/api/v1/layout-templates'

function url(id: string, suffix = ''): string {
    return `${BASE}/${encodeURIComponent(id)}${suffix}`
}

export const layoutTemplateService = {
    list(opts?: { includeHidden?: boolean }): Promise<{ items: LayoutTemplate[]; total: number }> {
        return authFetch(`${BASE}${opts?.includeHidden ? '?includeHidden=true' : ''}`)
    },

    get(id: string): Promise<LayoutTemplate> {
        return authFetch<LayoutTemplate>(url(id))
    },

    create(input: LayoutTemplateInput): Promise<LayoutTemplate> {
        return authFetch<LayoutTemplate>(BASE, { method: 'POST', body: JSON.stringify(input) })
    },

    /** Partial: absent fields stay as they are. */
    update(id: string, patch: Partial<LayoutTemplateInput>): Promise<LayoutTemplate> {
        return authFetch<LayoutTemplate>(url(id), { method: 'PUT', body: JSON.stringify(patch) })
    },

    /** A soft delete: `restore` brings back the same template, shares and all. */
    remove(id: string): Promise<void> {
        return authFetch<void>(url(id), { method: 'DELETE' })
    },

    restore(id: string): Promise<LayoutTemplate> {
        return authFetch<LayoutTemplate>(url(id, '/restore'), { method: 'POST' })
    },

    setHidden(id: string, hidden: boolean): Promise<LayoutTemplate> {
        return authFetch<LayoutTemplate>(url(id, '/hidden'), {
            method: 'PUT', body: JSON.stringify({ hidden }),
        })
    },

    grants: {
        list(id: string): Promise<ViewGrantResponse[]> {
            return authFetch<ViewGrantResponse[]>(url(id, '/grants'), { silent403: true })
        },
        create(id: string, req: ViewGrantCreateRequest): Promise<ViewGrantResponse> {
            return authFetch<ViewGrantResponse>(url(id, '/grants'), {
                method: 'POST', body: JSON.stringify(req),
            })
        },
        update(id: string, grantId: string, role: 'editor' | 'viewer'): Promise<ViewGrantResponse> {
            return authFetch<ViewGrantResponse>(url(id, `/grants/${encodeURIComponent(grantId)}`), {
                method: 'PUT', body: JSON.stringify({ role }),
            })
        },
        delete(id: string, grantId: string): Promise<void> {
            return authFetch<void>(url(id, `/grants/${encodeURIComponent(grantId)}`), { method: 'DELETE' })
        },
    },
}
