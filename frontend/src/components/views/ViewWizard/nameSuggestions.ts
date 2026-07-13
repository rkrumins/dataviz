/**
 * nameSuggestions — view-name suggestions for BasicsStep.
 *
 * These are a *starting point a person will actually keep*, so the bar is
 * "reads like a product name", not "is derived from the most data".
 *
 * An earlier version templated the workspace name, the ontology name and the
 * root entity types into the list. Those are identifiers, not prose, and the
 * results were embarrassing in real estates:
 *
 *     "Overlay WS Overview"  ·  "Layered Lineage multi-containment Model"
 *     "Zones Landscape"      ·  "Zone to Asset Flow"
 *
 * So the curated list is the backbone, and exactly ONE contextual suggestion is
 * allowed — the data source's own label — and only when that label passes
 * {@link isHumanLabel}. Omitting a suggestion costs nothing; suggesting garbage
 * costs trust, so the gate is deliberately conservative.
 */

/** Minimal structural slice of ScopeContext the builder needs. */
export interface SuggestionScope {
    workspaceName?: string
    dataSourceLabel?: string
    ontologyName?: string
    isBlank?: boolean
}

/**
 * Minimal structural slice of EntityTypeSchema.
 *
 * Retained so BasicsStep's call site keeps compiling; the schema is no longer
 * templated into names (see the header).
 */
export interface SuggestionEntityType {
    id: string
    name: string
    pluralName?: string
    hierarchy?: { level?: number; canContain?: string[] }
}

/** The evergreen list. Ordered most-reached-for first. */
export const CURATED_SUGGESTIONS: readonly string[] = [
    'Data Lineage',
    'Impact Analysis',
    'Data Pipeline',
    'Domain Overview',
    'Source to Target',
    'Medallion Architecture',
]

const MAX_SUGGESTIONS = 6

/** Placeholders `buildScopeContext` emits when resolution failed. */
const GENERIC_LABELS = new Set(['unknown', 'data source', 'blank model', 'untitled'])

/**
 * Did a person name this, or did a machine mint it?
 *
 * Accepts:  "Core DWH", "Finance", "Customer 360", "Sales & Ops"
 * Rejects:  "ds_930583737602", "roots-node", "urn:synodic:…", "3e105c56b3b4"
 *
 * The last rule is the load-bearing one: a display name carries a capital or a
 * space; a slug like `roots-node` carries neither.
 */
export function isHumanLabel(label: string | undefined | null): label is string {
    const v = label?.trim()
    if (!v) return false
    if (v.length < 2 || v.length > 28) return false
    if (GENERIC_LABELS.has(v.toLowerCase())) return false
    // Identifier punctuation: urns, paths, snake_case keys.
    if (/[_:/\\]/.test(v)) return false
    if (!/^[A-Za-z]/.test(v)) return false
    // Prose alphabet only.
    if (!/^[A-Za-z0-9 &'.-]+$/.test(v)) return false
    // Digit blobs: ds_930583737602, table_1197.
    if (/\d{4,}/.test(v)) return false
    // Slug test: no capital AND no space ⇒ not a display name.
    if (!/[A-Z]/.test(v) && !v.includes(' ')) return false
    return true
}

/**
 * Up to 6 deduped suggestions: an optional "{Data source} Lineage" first, then
 * the curated list.
 *
 * `_entityTypes` is accepted for call-site compatibility and intentionally
 * unused — see the header.
 */
export function buildNameSuggestions(
    scope: SuggestionScope | undefined,
    _entityTypes?: SuggestionEntityType[],
): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    const push = (s: string) => {
        const key = s.toLowerCase()
        if (seen.has(key)) return
        seen.add(key)
        out.push(s)
    }

    // Blank models are excluded on purpose: their "data source label" IS the
    // ontology's name (see buildBlankScopeContext), which reads like a schema,
    // not like a view — that's where "Layered Lineage multi-containment Model" came from.
    const dsLabel = scope?.dataSourceLabel
    if (!scope?.isBlank && isHumanLabel(dsLabel)) {
        push(`${dsLabel.trim()} Lineage`)
    }

    CURATED_SUGGESTIONS.forEach(push)

    return out.slice(0, MAX_SUGGESTIONS)
}
