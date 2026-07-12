/**
 * nameSuggestions — context-catered view-name suggestions for BasicsStep.
 *
 * Pure module (no React) so the ranking logic is unit-testable. Suggestions
 * are built from the wizard's resolved scope (workspace / data source /
 * ontology) plus the schema's root entity types, so they describe what the
 * user is actually building instead of generic boilerplate.
 */

/** Minimal structural slice of ScopeContext the builder needs. */
export interface SuggestionScope {
    workspaceName?: string
    dataSourceLabel?: string
    ontologyName?: string
    isBlank?: boolean
}

/** Minimal structural slice of EntityTypeSchema the builder needs. */
export interface SuggestionEntityType {
    id: string
    name: string
    pluralName?: string
    hierarchy?: { level?: number; canContain?: string[] }
}

/** Fallback labels produced by buildScopeContext when resolution failed —
 *  never worth templating into a suggestion. */
const GENERIC_LABELS = new Set(['unknown', 'data source', 'blank model'])

function usable(label: string | undefined): label is string {
    return !!label?.trim() && !GENERIC_LABELS.has(label.trim().toLowerCase())
}

/**
 * Root types = entity types that sit at the top of the containment
 * hierarchy: prefer explicit `hierarchy.level === 0`; otherwise types never
 * listed in any other type's `canContain`; otherwise the first two types.
 */
export function deriveRootTypes(entityTypes: SuggestionEntityType[]): SuggestionEntityType[] {
    if (entityTypes.length === 0) return []

    const explicitRoots = entityTypes.filter(et => et.hierarchy?.level === 0)
    if (explicitRoots.length > 0) return explicitRoots

    const contained = new Set(
        entityTypes.flatMap(et => et.hierarchy?.canContain ?? []),
    )
    const structuralRoots = entityTypes.filter(et => !contained.has(et.id))
    if (structuralRoots.length > 0) return structuralRoots

    return entityTypes.slice(0, 2)
}

const EVERGREEN = ['Impact Analysis', 'Source to Target']

/**
 * Build up to 6 deduped suggestions, most-specific first:
 *   1. "{dataSourceLabel} Lineage"          (existing-data journeys)
 *   2. "{workspaceName} Overview"
 *   3. "{ontologyName} Model"               (blank journeys)
 *   4. "{RootTypePlural} Landscape"
 *   5. "{RootType} to {SecondRootType} Flow"
 *   6. evergreen tails
 */
export function buildNameSuggestions(
    scope: SuggestionScope | undefined,
    entityTypes: SuggestionEntityType[],
): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    const push = (s: string | undefined) => {
        const v = s?.trim()
        if (!v) return
        const key = v.toLowerCase()
        if (seen.has(key)) return
        seen.add(key)
        out.push(v)
    }

    // Blank models have no meaningful data-source label distinct from the
    // ontology, so lead with the ontology there instead.
    if (!scope?.isBlank && usable(scope?.dataSourceLabel)) {
        push(`${scope.dataSourceLabel} Lineage`)
    }
    if (usable(scope?.workspaceName)) {
        push(`${scope.workspaceName} Overview`)
    }
    if (scope?.isBlank && usable(scope?.ontologyName)) {
        push(`${scope.ontologyName} Model`)
    }

    const roots = deriveRootTypes(entityTypes)
    const first = roots[0]
    // Single-root schemas (the common case) still deserve a "X to Y Flow"
    // suggestion — fall back to the root's first containable child type.
    const firstChildId = first?.hierarchy?.canContain?.[0]
    const second = roots[1]
        ?? (firstChildId ? entityTypes.find(et => et.id === firstChildId) : undefined)
    if (first) push(`${(first.pluralName || first.name).trim()} Landscape`)
    if (first && second && second.id !== first.id) {
        push(`${first.name.trim()} to ${second.name.trim()} Flow`)
    }

    EVERGREEN.forEach(push)

    return out.slice(0, 6)
}
