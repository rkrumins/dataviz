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
     *  organization's, a built-in, or (template managers) a pending request. */
    via: 'owner' | 'grant' | 'workspace' | 'organization' | 'builtin' | 'request'
    canEdit: boolean
    canDelete: boolean
    /** Change who can use it: audience and shares. */
    canShare: boolean
    /** Built-ins only, for template managers. */
    canHide: boolean
    /** Feature it at the top of the library — managers, for templates everyone can use. */
    canFeature?: boolean
    /** Ask for it to be offered to the whole organization. */
    canRequestPromotion?: boolean
    /** Approve or decline that request — managers. */
    canDecidePromotion?: boolean
}

/** A pending request to offer a template to everyone. */
export interface TemplatePromotionRequest {
    requestedBy?: string | null
    requestedAt: string
    note?: string | null
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
    /** Its layers' version: changing the layers makes a new one. */
    version: number
    /** Spotlit at the top of the library by a template manager. */
    featured?: boolean
    /** The caller's favourite. */
    isFavourite?: boolean
    /** When the caller last built a view from it. */
    lastUsedAt?: string | null
    /** Workspaces (that the caller can see) whose new views start from it. */
    defaultFor?: { workspaceId: string; workspaceName?: string | null }[]
    /** Pending request to offer it to everyone — for its requester, owner and managers. */
    promotionRequest?: TemplatePromotionRequest | null
    access: LayoutTemplateAccess
}

/** One version of a template's layers. */
export interface LayoutTemplateVersionSummary {
    version: number
    /** The template's name when this version was kept. */
    name: string
    changeNote?: string | null
    layerCount: number
    createdBy?: string | null
    createdAt: string
}

export interface LayoutTemplateVersion extends LayoutTemplateVersionSummary {
    layers: ViewLayerConfig[]
}

/** An edit: a new version is kept only when the layers actually change. */
export interface LayoutTemplatePatch extends Partial<LayoutTemplateInput> {
    /** What changed — kept with the new version. */
    changeNote?: string | null
    /** Tell the people whose views were built from an older version. */
    notifyUsers?: boolean
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
    update(id: string, patch: LayoutTemplatePatch): Promise<LayoutTemplate> {
        return authFetch<LayoutTemplate>(url(id), { method: 'PUT', body: JSON.stringify(patch) })
    },

    /** Every version of its layers, newest first. */
    versions(id: string): Promise<LayoutTemplateVersionSummary[]> {
        return authFetch<{ items: LayoutTemplateVersionSummary[] }>(url(id, '/versions')).then(r => r.items)
    },

    version(id: string, version: number): Promise<LayoutTemplateVersion> {
        return authFetch<LayoutTemplateVersion>(url(id, `/versions/${version}`))
    },

    /** Make an earlier version's layers the newest version. */
    restoreVersion(id: string, version: number): Promise<LayoutTemplate> {
        return authFetch<LayoutTemplate>(url(id, `/versions/${version}/restore`), { method: 'POST' })
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

    setFeatured(id: string, featured: boolean): Promise<LayoutTemplate> {
        return authFetch<LayoutTemplate>(url(id, '/featured'), {
            method: 'PUT', body: JSON.stringify({ featured }),
        })
    },

    favourite(id: string): Promise<LayoutTemplate> {
        return authFetch<LayoutTemplate>(url(id, '/favourite'), { method: 'POST' })
    },

    unfavourite(id: string): Promise<void> {
        return authFetch<void>(url(id, '/favourite'), { method: 'DELETE' })
    },

    /** Ask for it to be offered to the whole organization. */
    requestPromotion(id: string, note?: string | null): Promise<LayoutTemplate> {
        return authFetch<LayoutTemplate>(url(id, '/promotion-request'), {
            method: 'POST', body: JSON.stringify({ note: note ?? null }),
        })
    },

    withdrawPromotion(id: string): Promise<void> {
        return authFetch<void>(url(id, '/promotion-request'), { method: 'DELETE' })
    },

    /** The pending requests — template managers only. */
    promotionRequests(): Promise<LayoutTemplate[]> {
        return authFetch<{ items: LayoutTemplate[] }>(`${BASE}/promotion-requests`, { silent403: true })
            .then(r => r.items)
    },

    answerPromotion(id: string, approve: boolean, note?: string | null): Promise<LayoutTemplate> {
        return authFetch<LayoutTemplate>(url(id, `/promotion-request/${approve ? 'approve' : 'decline'}`), {
            method: 'POST', body: JSON.stringify({ note: note ?? null }),
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
