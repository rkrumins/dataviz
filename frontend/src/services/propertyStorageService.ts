/**
 * propertyStorageService — how a data source physically stores node properties,
 * and what would change if it were aligned.
 *
 * A graph built outside the platform almost always nests every user property
 * under one container key (`n.properties`, `n.attributes`, …). Those properties
 * render — the read path hydrates the container — but stay invisible to
 * Advanced Search, because a nested value is not an indexable field.
 *
 * Three calls, all scoped to one (workspace, data source):
 *   • `getPropertyStorage`    — the report: what shape is each label in?
 *   • `previewPropertyMapping`— before/after for real nodes, writes nothing
 *   • `savePropertyMapping`   — persist the mapping (merged server-side)
 */
import { authFetch } from './apiClient'

/** Reserved-key collision: a physical field whose name the platform owns. */
export interface PropertyCollision {
    /** The colliding physical field, e.g. "level". */
    field: string
    /** A few real values, so the operator can tell whether it's theirs. */
    samples: unknown[]
    /** Safe path the field could be remapped to, e.g. "source/level". */
    suggested: string
}

export interface LabelStorage {
    sampled: number
    /**
     * `container` — everything nested, nothing native (needs alignment).
     * `mixed`     — some of each: mid-migration or an inconsistent source.
     * `native`    — the platform's own shape; nothing to do.
     * `empty`     — no nodes sampled.
     */
    storage: 'native' | 'container' | 'mixed' | 'empty'
    nativeKeys: string[]
    containerKeys: string[]
    /** Property paths unpacking would produce, e.g. "technical/format". */
    inferredPaths: string[]
    /** Exact count (not sampled) of nodes carrying the container. */
    affectedNodes: number
    /** Nodes whose container could not be parsed — preserved, never stripped. */
    unparseable: number
    collisions: PropertyCollision[]
}

export interface PropertyStorageReport {
    containerKey: string | null
    separator: string
    collectUnmapped: boolean
    propertyOverrides: Record<string, string>
    labels: Record<string, LabelStorage>
    totals: {
        labels: number
        affectedNodes: number
        newPaths: number
        /** Labels in `container` or `mixed` state. */
        needsAlignment: string[]
    }
    elapsedMs: number
}

/** The property half of the source's schema mapping — what this tab edits. */
export interface PropertyMapping {
    /** Node property holding the nested container. `null` = all native. */
    containerKey: string | null
    /** Joins a nested path into a flat key. Only "/" renders as folders. */
    separator: string
    /** Collect native non-reserved fields as user properties. */
    collectUnmapped: boolean
    /** Physical field -> property path, for reserved-key collisions. */
    propertyOverrides: Record<string, string>
}

export interface PropertyPreviewSample {
    urn: string
    label: string
    displayName: string
    /** Property bag as the drawer shows it today. */
    before: Record<string, unknown>
    /** Property bag under the proposed mapping. */
    after: Record<string, unknown>
    /**
     * Keys not already fields on the physical node that would become ones —
     * the actual payoff of aligning. Empty when the node is already native,
     * so the UI must not promise a gain that isn't there.
     */
    newlySearchable: string[]
}

export interface PropertyPreview {
    samples: PropertyPreviewSample[]
    count: number
}

export const DEFAULT_PROPERTY_MAPPING: PropertyMapping = {
    containerKey: 'properties',
    separator: '/',
    collectUnmapped: true,
    propertyOverrides: {},
}

/** Only "/" is rendered as a folder tree by PropertyEditor's groupByPath. */
export const FOLDER_SEPARATOR = '/'

/** `/api/v1/{ws}/graph/properties/{path}?dataSourceId=…` */
function url(wsId: string, path: string, dataSourceId: string, extra = ''): string {
    return `/api/v1/${encodeURIComponent(wsId)}/graph/properties/${path}`
        + `?dataSourceId=${encodeURIComponent(dataSourceId)}${extra}`
}

export async function getPropertyStorage(
    wsId: string,
    dataSourceId: string,
    samplePerLabel = 200,
): Promise<PropertyStorageReport> {
    return authFetch<PropertyStorageReport>(
        url(wsId, 'storage', dataSourceId, `&samplePerLabel=${samplePerLabel}`),
    )
}

export async function previewPropertyMapping(
    wsId: string,
    dataSourceId: string,
    mapping: PropertyMapping,
    opts?: { labels?: string[]; limit?: number },
): Promise<PropertyPreview> {
    return authFetch<PropertyPreview>(
        url(wsId, 'storage/preview', dataSourceId),
        {
            method: 'POST',
            body: JSON.stringify({
                mapping,
                labels: opts?.labels,
                limit: opts?.limit ?? 5,
            }),
        },
    )
}

export async function savePropertyMapping(
    wsId: string,
    dataSourceId: string,
    mapping: PropertyMapping,
): Promise<PropertyMapping> {
    return authFetch<PropertyMapping>(
        url(wsId, 'mapping', dataSourceId),
        { method: 'PUT', body: JSON.stringify(mapping) },
    )
}

/** Report -> the mapping currently in force, for seeding the editor. */
export function mappingFromReport(report: PropertyStorageReport): PropertyMapping {
    return {
        containerKey: report.containerKey,
        separator: report.separator,
        collectUnmapped: report.collectUnmapped,
        propertyOverrides: { ...report.propertyOverrides },
    }
}
