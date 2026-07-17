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

/** One physical spelling folded into a canonical suggested type id. */
export interface MergedVariantSpelling { spelling: string; count: number }

export interface OntologySuggestResponse {
    suggested: OntologyCreateRequest
    matchingOntologies: OntologyMatchResult[]
    /**
     * Physical type ids the source graph spelled more than one way, folded into one
     * canonical declared id: `{ canonicalId: [{ spelling, count }, …] }`. Only the
     * canonical spelling hits FalkorDB's index; the other spellings are case-drift until
     * the graph is normalized. Empty when every type was spelled consistently.
     */
    mergedVariants: Record<string, MergedVariantSpelling[]>
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

    /** Publish a draft. `force` overrides the breaking-change block (admin
     *  escape hatch — the server re-runs the impact check and 409s without it). */
    publish(id: string, force = false): Promise<OntologyDefinitionResponse> {
        return request<OntologyDefinitionResponse>(
            `${ADMIN_API}/${id}/publish${force ? '?force=true' : ''}`,
            { method: 'POST' },
        )
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

    auditLog(id: string, params: { limit?: number; offset?: number } = {}): Promise<OntologyAuditEntry[]> {
        const qs = new URLSearchParams()
        if (params.limit != null) qs.set('limit', String(params.limit))
        if (params.offset != null) qs.set('offset', String(params.offset))
        const query = qs.toString()
        return request<OntologyAuditEntry[]>(`${ADMIN_API}/${id}/audit${query ? `?${query}` : ''}`)
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
     * One batched, cache-only call — no live graph queries. The aggregate hero + facet
     * counts are computed over ALL sources server-side; ``params`` only narrow + page the
     * returned per-source list, so filtering/searching stays cheap at 100s of sources.
     */
    adoption(id: string, params: AdoptionParams = {}): Promise<OntologyAdoptionResponse> {
        const qs = new URLSearchParams()
        if (params.limit != null) qs.set('limit', String(params.limit))
        if (params.offset != null) qs.set('offset', String(params.offset))
        if (params.search) qs.set('search', params.search)
        if (params.filter && params.filter !== 'all') qs.set('filter', params.filter)
        if (params.sort && params.sort !== 'match') qs.set('sort', params.sort)
        const query = qs.toString()
        return request<OntologyAdoptionResponse>(
            `${ADMIN_API}/${id}/adoption${query ? `?${query}` : ''}`,
        )
    },

    /**
     * Score the graph's schema against every ontology.
     *
     * `minScore` drops layers below that Jaccard overlap. The default (0.1, set
     * server-side) keeps the onboarding wizard's suggestion list to plausible
     * candidates. Pass 0 to score EVERY layer — the Add/Move Data Source wizard
     * does that, so a layer the user expands to see carries the same numbers and
     * warnings as the top matches instead of appearing with no score at all.
     */
    suggest(
        stats: Record<string, unknown>,
        baseOntologyId?: string,
        minScore?: number,
    ): Promise<OntologySuggestResponse> {
        const params = new URLSearchParams()
        if (baseOntologyId) params.set('base_ontology_id', baseOntologyId)
        if (minScore !== undefined) params.set('min_score', String(minScore))
        const qs = params.toString()
        return request<OntologySuggestResponse>(
            qs ? `${ADMIN_API}/suggest?${qs}` : `${ADMIN_API}/suggest`,
            { method: 'POST', body: JSON.stringify(stats) },
        )
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

    /**
     * Per-assigned-source vocabulary-alignment profiles (declared → observed
     * spelling maps + drift) for the Health tab's alias table. Server-paged:
     * facet counts cover ALL assignments, `params` narrow + page the rows.
     */
    getSourceMappings(id: string, params: SourceMappingParams = {}): Promise<OntologySourceMappingsResponse> {
        const qs = new URLSearchParams()
        if (params.limit != null) qs.set('limit', String(params.limit))
        if (params.offset != null) qs.set('offset', String(params.offset))
        if (params.search) qs.set('search', params.search)
        if (params.filter && params.filter !== 'all') qs.set('filter', params.filter)
        const query = qs.toString()
        return request<OntologySourceMappingsResponse>(
            `${ADMIN_API}/${id}/source-mappings${query ? `?${query}` : ''}`,
        )
    },

    /**
     * Rank ALL data sources by how well this ontology covers their cached
     * profiled schema — server-side "Best Matches" (one request replaces the
     * old 2-per-source fan-out). Sorted best coverage first, unprofiled last.
     */
    coverageRanking(id: string, params: CoverageRankingParams = {}): Promise<OntologyCoverageRankingResponse> {
        const qs = new URLSearchParams()
        if (params.limit != null) qs.set('limit', String(params.limit))
        if (params.offset != null) qs.set('offset', String(params.offset))
        if (params.search) qs.set('search', params.search)
        if (params.filter && params.filter !== 'all') qs.set('filter', params.filter)
        const query = qs.toString()
        return request<OntologyCoverageRankingResponse>(
            `${ADMIN_API}/${id}/coverage-ranking${query ? `?${query}` : ''}`,
        )
    },

    /**
     * Export the semantic layer as raw JSON (the /export payload verbatim).
     * Dedicated method because the shared request() JSON-parses into typed
     * models — export is a document the caller downloads as-is.
     */
    async exportJson(id: string): Promise<Record<string, unknown>> {
        return request<Record<string, unknown>>(`${ADMIN_API}/${id}/export`)
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
export type AdoptionFilter = 'all' | 'drift' | 'unmapped' | 'unprofiled' | 'exact'
export type AdoptionSort = 'match' | 'issues' | 'label' | 'freshness'
export interface AdoptionParams {
    limit?: number
    offset?: number
    search?: string
    filter?: AdoptionFilter
    sort?: AdoptionSort
}
/** Instance/type segment split for the aggregate hero ring. */
export interface AdoptionSegmentSet { exact: number; drift: number; unmapped: number }
export interface AdoptionSegments { weighted: AdoptionSegmentSet; byType: AdoptionSegmentSet }
/** Per-filter source counts (over ALL sources) that drive the filter chips. */
export interface AdoptionFacets {
    all: number
    drift: number
    unmapped: number
    unprofiled: number
    exact: number
}
export interface OntologyAdoptionResponse {
    ontologyId: string
    sourceCount: number
    profiledCount: number
    matchWeighted: number
    matchByType: number
    driftTypeCount: number
    unmappedTypeCount: number
    segments: AdoptionSegments
    facets: AdoptionFacets
    /** Count AFTER search/filter (page count = sources.length). */
    total: number
    limit: number
    offset: number
    sources: AdoptionSource[]
}

/** A single data source assignment returned by getAssignments(). */
/** One declared-type entry in a source's vocabulary alignment profile. */
export interface SourceMappingEntry {
    observed?: string | string[]
    auto?: boolean
    needsConfirmation?: boolean
}

export interface SourceMappingDriftDetail {
    declared: string
    observed: string[]
    dimension: 'entity' | 'relationship'
    kind: string
    needsConfirmation?: boolean
}

/** Per-assigned-source vocabulary-alignment profile (Health tab alias table). */
export interface OntologySourceMappingRow {
    workspaceId: string
    workspaceName: string
    dataSourceId: string
    dataSourceLabel: string
    hasProfile: boolean
    hasDrift: boolean
    lastSeenAt: string | null
    entityMappings: Record<string, SourceMappingEntry>
    relationshipMappings: Record<string, SourceMappingEntry>
    driftDetails: SourceMappingDriftDetail[]
}

export type SourceMappingFilter = 'all' | 'drift' | 'pending' | 'unprofiled'

export interface SourceMappingParams {
    limit?: number
    offset?: number
    search?: string
    filter?: SourceMappingFilter
}

export interface OntologySourceMappingsResponse {
    ontologyId: string
    /** Count AFTER search/filter (page count = sources.length). */
    total: number
    limit: number
    offset: number
    /** Counts over ALL assignments, independent of search/filter. */
    facets: Record<SourceMappingFilter, number>
    sources: OntologySourceMappingRow[]
}

export type CoverageRankingFilter = 'all' | 'unassigned' | 'assigned-other' | 'assigned-this'

export interface CoverageRankingParams {
    limit?: number
    offset?: number
    search?: string
    filter?: CoverageRankingFilter
}

/** One candidate source in the server-side Best Matches ranking. */
export interface CoverageRankingSource {
    workspaceId: string
    workspaceName: string
    dataSourceId: string
    dataSourceLabel: string
    currentOntologyId: string | null
    /** False when the source has no cached profiling stats yet. */
    profiled: boolean
    coveragePercent: number | null
    uncoveredEntityCount: number
    uncoveredRelationshipCount: number
}

export interface OntologyCoverageRankingResponse {
    ontologyId: string
    total: number
    limit: number
    offset: number
    profiledCount: number
    facets: { all: number; unassigned: number; assignedOther: number; assignedThis: number }
    sources: CoverageRankingSource[]
}

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
