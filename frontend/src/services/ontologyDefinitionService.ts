/**
 * Ontology Definition Service — CRUD for ontology definitions.
 * Ontologies are standalone, versioned, reusable semantic configurations.
 */

import { fetchWithTimeout } from './fetchWithTimeout'

const ADMIN_API = '/api/v1/admin/ontologies'

export interface OntologyCreateRequest {
    name: string
    description?: string
    evolutionPolicy?: string
    scope?: string
    containmentEdgeTypes?: string[]
    lineageEdgeTypes?: string[]
    edgeTypeMetadata?: Record<string, unknown>
    entityTypeHierarchy?: Record<string, unknown>
    rootEntityTypes?: string[]
    entityTypeDefinitions?: Record<string, unknown>
    relationshipTypeDefinitions?: Record<string, unknown>
}

export interface OntologyUpdateRequest {
    name?: string
    description?: string
    evolutionPolicy?: string
    containmentEdgeTypes?: string[]
    lineageEdgeTypes?: string[]
    edgeTypeMetadata?: Record<string, unknown>
    entityTypeHierarchy?: Record<string, unknown>
    rootEntityTypes?: string[]
    entityTypeDefinitions?: Record<string, unknown>
    relationshipTypeDefinitions?: Record<string, unknown>
}

export interface OntologyMatchResult {
    ontologyId: string
    ontologyName: string
    version: number
    jaccardScore: number
    coveredEntityTypes: string[]
    uncoveredEntityTypes: string[]
    coveredRelationshipTypes: string[]
    uncoveredRelationshipTypes: string[]
    totalEntityTypes: number
    totalRelationshipTypes: number
}

export interface OntologySuggestResponse {
    suggested: OntologyCreateRequest
    matchingOntologies: OntologyMatchResult[]
}

export interface OntologyDefinitionResponse {
    id: string
    schemaId: string
    name: string
    description: string | null
    version: number
    revision: number
    evolutionPolicy: string
    containmentEdgeTypes: string[]
    lineageEdgeTypes: string[]
    edgeTypeMetadata: Record<string, unknown>
    entityTypeHierarchy: Record<string, unknown>
    rootEntityTypes: string[]
    entityTypeDefinitions: Record<string, unknown>
    relationshipTypeDefinitions: Record<string, unknown>
    isPublished: boolean
    isSystem: boolean
    scope: string
    createdBy: string | null
    updatedBy: string | null
    publishedBy: string | null
    publishedAt: string | null
    deletedBy: string | null
    deletedAt: string | null
    createdAt: string
    updatedAt: string
}

export interface OntologyAuditEntry {
    id: string
    ontologyId: string
    schemaId: string
    action: 'created' | 'updated' | 'published' | 'deleted' | 'restored' | 'cloned' | 'imported'
    actor: string | null
    version: number | null
    summary: string | null
    changes: {
        addedEntityTypes?: string[]
        removedEntityTypes?: string[]
        addedRelationshipTypes?: string[]
        removedRelationshipTypes?: string[]
    } | null
    createdAt: string
}

/** Result of an import operation. */
export interface OntologyImportResponse {
    ontology: OntologyDefinitionResponse
    status: 'created' | 'updated' | 'new_version' | 'no_changes'
    summary: string
    changes: {
        addedEntityTypes?: string[]
        removedEntityTypes?: string[]
        addedRelationshipTypes?: string[]
        removedRelationshipTypes?: string[]
    } | null
}

async function request<T>(
    url: string,
    init?: RequestInit & { silent403?: boolean },
): Promise<T> {
    const res = await fetchWithTimeout(url, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
    if (!res.ok) {
        const text = await res.text()
        throw new Error(`Ontology API ${res.status}: ${text || res.statusText}`)
    }
    if (res.status === 204) return undefined as T
    return res.json()
}

// Ontologies router is system:admin-gated. Non-admin pages (dashboard,
// workspaces) probe ``list`` to render counts and pipeline state;
// suppress the global 403 modal on reads so non-admins never see an
// admin-tier denial for a background probe.
const SILENT_READ = { silent403: true } as const

export const ontologyDefinitionService = {
    list(allVersions = false, includeDeleted = false): Promise<OntologyDefinitionResponse[]> {
        const params = new URLSearchParams()
        if (allVersions) params.set('all_versions', 'true')
        if (includeDeleted) params.set('include_deleted', 'true')
        const qs = params.toString()
        return request<OntologyDefinitionResponse[]>(qs ? `${ADMIN_API}?${qs}` : ADMIN_API, SILENT_READ)
    },

    get(id: string): Promise<OntologyDefinitionResponse> {
        return request<OntologyDefinitionResponse>(`${ADMIN_API}/${id}`, SILENT_READ)
    },

    listVersions(id: string): Promise<OntologyDefinitionResponse[]> {
        return request<OntologyDefinitionResponse[]>(`${ADMIN_API}/${id}/versions`, SILENT_READ)
    },

    create(req: OntologyCreateRequest): Promise<OntologyDefinitionResponse> {
        return request<OntologyDefinitionResponse>(ADMIN_API, {
            method: 'POST',
            body: JSON.stringify(req),
        })
    },

    update(id: string, req: OntologyUpdateRequest): Promise<OntologyDefinitionResponse> {
        return request<OntologyDefinitionResponse>(`${ADMIN_API}/${id}`, {
            method: 'PUT',
            body: JSON.stringify(req),
        })
    },

    delete(id: string): Promise<void> {
        return request<void>(`${ADMIN_API}/${id}`, { method: 'DELETE' })
    },

    publish(id: string): Promise<OntologyDefinitionResponse> {
        return request<OntologyDefinitionResponse>(`${ADMIN_API}/${id}/publish`, {
            method: 'POST',
        })
    },

    clone(id: string): Promise<OntologyDefinitionResponse> {
        return request<OntologyDefinitionResponse>(`${ADMIN_API}/${id}/clone`, {
            method: 'POST',
        })
    },

    createNewVersion(id: string): Promise<OntologyDefinitionResponse> {
        return request<OntologyDefinitionResponse>(`${ADMIN_API}/${id}/new-version`, {
            method: 'POST',
        })
    },

    auditLog(id: string): Promise<OntologyAuditEntry[]> {
        return request<OntologyAuditEntry[]>(`${ADMIN_API}/${id}/audit`)
    },

    restore(id: string): Promise<OntologyDefinitionResponse> {
        return request<OntologyDefinitionResponse>(`${ADMIN_API}/${id}/restore`, {
            method: 'POST',
        })
    },

    validate(id: string): Promise<OntologyValidationResponse> {
        return request<OntologyValidationResponse>(`${ADMIN_API}/${id}/validate`, {
            method: 'POST',
        })
    },

    coverage(id: string, stats: Record<string, unknown>): Promise<OntologyCoverageResponse> {
        return request<OntologyCoverageResponse>(`${ADMIN_API}/${id}/coverage`, {
            method: 'POST',
            body: JSON.stringify(stats),
        })
    },

    /**
     * Per-data-source declared-vs-physical type match, from the cached profiling stats.
     * One batched, cache-only call — no live graph queries.
     */
    adoption(id: string): Promise<OntologyAdoptionResponse> {
        return request<OntologyAdoptionResponse>(`${ADMIN_API}/${id}/adoption`)
    },

    suggest(stats: Record<string, unknown>, baseOntologyId?: string): Promise<OntologySuggestResponse> {
        const url = baseOntologyId
            ? `${ADMIN_API}/suggest?base_ontology_id=${encodeURIComponent(baseOntologyId)}`
            : `${ADMIN_API}/suggest`
        return request<OntologySuggestResponse>(url, {
            method: 'POST',
            body: JSON.stringify(stats),
        })
    },

    /**
     * List all data sources currently assigned to this ontology (across all workspaces).
     */
    getAssignments(id: string): Promise<OntologyAssignment[]> {
        return request<OntologyAssignment[]>(`${ADMIN_API}/${id}/assignments`)
    },

    /**
     * Preview the impact of publishing this ontology draft.
     * Returns added/removed types and whether the evolution_policy allows the publish.
     */
    impact(id: string): Promise<OntologyImpactResponse> {
        return request<OntologyImpactResponse>(`${ADMIN_API}/${id}/impact`)
    },

    /**
     * Import a semantic layer from exported JSON as a new draft.
     */
    importNew(data: Record<string, unknown>): Promise<OntologyImportResponse> {
        return request<OntologyImportResponse>(`${ADMIN_API}/import`, {
            method: 'POST',
            body: JSON.stringify(data),
        })
    },

    /**
     * Import a semantic layer from exported JSON into an existing ontology.
     * - Draft target → in-place update (same version)
     * - Published target → creates new draft version
     */
    importInto(id: string, data: Record<string, unknown>): Promise<OntologyImportResponse> {
        return request<OntologyImportResponse>(`${ADMIN_API}/${id}/import`, {
            method: 'POST',
            body: JSON.stringify(data),
        })
    },
}

export interface OntologyValidationIssue {
    severity: 'error' | 'warning'
    code: string
    message: string
    affected?: string
}

export interface OntologyValidationResponse {
    isValid: boolean
    issues: OntologyValidationIssue[]
}

export interface OntologyCoverageResponse {
    coveragePercent: number
    coveredEntityTypes: string[]
    uncoveredEntityTypes: string[]
    extraEntityTypes: string[]
    coveredRelationshipTypes: string[]
    uncoveredRelationshipTypes: string[]
}

// ── Adoption (declared-vs-physical type match) ──────────────────────────────
export interface AdoptionTypeStat { id: string; count: number }
export interface AdoptionDrift { id: string; declared: string; count: number }
export interface AdoptionDimension {
    matchWeighted: number
    matchByType: number
    totalTypes: number
    totalInstances: number
    exact: AdoptionTypeStat[]
    caseDrift: AdoptionDrift[]
    unmapped: AdoptionTypeStat[]
    declaredUnused: string[]
}
export interface AdoptionSource {
    dataSourceId: string
    dataSourceLabel: string
    workspaceId: string
    workspaceName: string
    profiled: boolean
    schemaUpdatedAt: string | null
    matchWeighted: number | null
    matchByType: number | null
    nodes: AdoptionDimension | null
    edges: AdoptionDimension | null
}
export interface OntologyAdoptionResponse {
    ontologyId: string
    sourceCount: number
    profiledCount: number
    matchWeighted: number
    matchByType: number
    driftTypeCount: number
    unmappedTypeCount: number
    sources: AdoptionSource[]
}

/** A single data source assignment returned by getAssignments(). */
export interface OntologyAssignment {
    workspaceId: string
    workspaceName: string
    dataSourceId: string
    dataSourceLabel: string
}

/** Impact preview for a draft ontology publish. */
export interface OntologyImpactResponse {
    allowed: boolean
    reason: string | null
    evolutionPolicy: string
    addedEntityTypes: string[]
    removedEntityTypes: string[]
    addedRelationshipTypes: string[]
    removedRelationshipTypes: string[]
}
