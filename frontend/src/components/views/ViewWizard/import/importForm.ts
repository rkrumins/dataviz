/**
 * Between a view file's definition and the wizard's form, in both directions, losing nothing.
 *
 * The wizard's form owns a handful of fields: layout type, layers, placements, the default node
 * sort, entity scope, visible entity and relationship types, and field filters. A view's
 * definition holds far more: display rules, entity overrides, grouping, projection, depths,
 * quick filters, keys a newer environment added. The form must never be the reason any of that
 * is lost, so writing back is a PATCH of the imported definition, not a rebuild:
 *
 *   formToDefinition(base, initial, form)
 *
 * starts from the definition as it came in (`base`) and writes only the parts of the form that
 * differ from what the form was filled with (`initial`). Clicking through the wizard without
 * changing anything therefore hands back exactly the definition that came in, byte for byte,
 * which is what lets the import prove nothing changed on the way.
 */
import { normalizeReferenceLayout } from '@/utils/referenceLayout'
import type { FieldFilter, LayerAssignmentEntry, ViewLayerConfig } from '@/types/schema'
import type { BundleViewMetadata } from '@/services/viewTransferApiService'
import type { ActiveFilter, WizardFormData } from '../ViewWizard'

export type Definition = Record<string, unknown>

/** The layouts the wizard can build. Any other view type imports as-is. */
export const BUILDABLE_VIEW_TYPES = ['graph', 'hierarchy', 'reference'] as const
export type BuildableViewType = typeof BUILDABLE_VIEW_TYPES[number]

export function isBuildable(viewType: string | null | undefined): viewType is BuildableViewType {
  return (BUILDABLE_VIEW_TYPES as readonly string[]).includes(viewType ?? '')
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Structural equality for JSON values; object key order doesn't matter. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const other = b as unknown[]
    return a.length === other.length && a.every((v, i) => sameJson(v, other[i]))
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const keys = Object.keys(ao).filter(k => ao[k] !== undefined)
  const otherKeys = Object.keys(bo).filter(k => bo[k] !== undefined)
  return keys.length === otherKeys.length && keys.every(k => sameJson(ao[k], bo[k]))
}

/**
 * A view's field filters as the wizard's filter chips. Shared with edit-mode hydration: the two
 * must read a stored filter the same way.
 */
export function fieldFiltersToActiveFilters(fieldFilters: FieldFilter[] | undefined): ActiveFilter[] {
  return (fieldFilters || []).map((f, i) => ({
    id: `${f.field}-${i}-${String(f.value)}`,
    type: f.field === 'tags' ? 'tag' : f.field === 'name' ? 'name' : 'property',
    label: f.field === 'tags'
      ? `Tag: ${f.value}`
      : f.field === 'name'
        ? `Name contains "${f.value}"`
        : `${f.field}=${f.value}`,
    value: f.value,
  }))
}

/** The wizard's filter chips as stored field filters (the wizard's own save rule). */
export function activeFiltersToFieldFilters(filters: ActiveFilter[]): FieldFilter[] {
  return filters.map(af => ({
    field: af.type === 'tag' ? 'tags' : af.type === 'name' ? 'name' : String(af.value).split('=')[0],
    operator: (af.type === 'name' ? 'contains' : 'equals') as FieldFilter['operator'],
    value: af.type === 'property' && String(af.value).includes('=')
      ? String(af.value).split('=')[1]
      : af.value,
  }))
}

/** Fill the wizard's form from a view file's definition and metadata. */
export function definitionToForm(
  definition: Definition,
  metadata: BundleViewMetadata,
  opts: { dataSourceId?: string; visibility?: WizardFormData['visibility'] } = {},
): WizardFormData {
  const layout = asObject(definition.layout)
  const content = asObject(definition.content)
  const filters = asObject(definition.filters)
  const { layers, assignments, defaultNodeSortMode } = normalizeReferenceLayout(layout.referenceLayout)
  const layoutType = isBuildable(layout.type as string) ? layout.type as BuildableViewType
    : isBuildable(metadata.viewType) ? metadata.viewType : 'reference'
  const scope = content.entityScope
  return {
    name: metadata.name,
    description: metadata.description ?? '',
    icon: metadata.icon ?? 'Layout',
    visibility: opts.visibility ?? 'private',
    tags: [...(metadata.tags ?? [])],
    dataSourceId: opts.dataSourceId,
    layoutType,
    layers,
    assignments,
    defaultNodeSortMode,
    entityScope: scope === 'all' || scope === 'curated' ? scope : undefined,
    visibleEntityTypes: Array.isArray(content.visibleEntityTypes) ? [...content.visibleEntityTypes as string[]] : [],
    visibleRelationshipTypes: Array.isArray(content.visibleRelationshipTypes)
      ? [...content.visibleRelationshipTypes as string[]] : [],
    advancedFilters: fieldFiltersToActiveFilters(filters.fieldFilters as FieldFilter[] | undefined),
    scopeEdges: layers[0]?.scopeEdges,
    isValid: true,
  }
}

/**
 * The definition to import: `base` with only what changed in the form written into it.
 * Never mutates its inputs.
 */
export function formToDefinition(base: Definition, initial: WizardFormData, form: WizardFormData): Definition {
  const out = structuredClone(base) as Definition

  if (form.layoutType !== initial.layoutType) {
    out.layout = { ...asObject(out.layout), type: form.layoutType }
  }

  const scopeEdgesChanged = !sameJson(form.scopeEdges, initial.scopeEdges)
  const layersChanged = scopeEdgesChanged || !sameJson(form.layers, initial.layers)
  const assignmentsChanged = !sameJson(form.assignments, initial.assignments)
  const sortChanged = form.defaultNodeSortMode !== initial.defaultNodeSortMode
  if (layersChanged || assignmentsChanged || sortChanged) {
    const layout = asObject(out.layout)
    // Everything else the reference layout carries (display rules, anything newer) stays as is.
    const referenceLayout: Record<string, unknown> = { ...asObject(layout.referenceLayout) }
    // The wizard edits one scope for the whole view; it only overwrites the layers' own when
    // it was actually changed here.
    const layers: ViewLayerConfig[] = scopeEdgesChanged
      ? form.layers.map(l => ({ ...l, scopeEdges: form.scopeEdges }))
      : form.layers
    if (layersChanged) referenceLayout.layers = layers
    if (layersChanged || assignmentsChanged) {
      // A placement on a layer that no longer exists places nothing; the server would refuse it.
      const layerIds = new Set(layers.map(l => l.id))
      const assignments: Record<string, LayerAssignmentEntry> = {}
      for (const [urn, entry] of Object.entries(form.assignments)) {
        if (layerIds.has(entry.layerId)) assignments[urn] = entry
      }
      referenceLayout.assignments = assignments
    }
    if (sortChanged) {
      if (form.defaultNodeSortMode) referenceLayout.defaultNodeSortMode = form.defaultNodeSortMode
      else delete referenceLayout.defaultNodeSortMode
    }
    out.layout = { ...layout, referenceLayout }
  }

  const contentUpdates: Record<string, unknown> = {}
  if (form.entityScope !== initial.entityScope && form.entityScope) contentUpdates.entityScope = form.entityScope
  if (!sameJson(form.visibleEntityTypes, initial.visibleEntityTypes)) {
    contentUpdates.visibleEntityTypes = form.visibleEntityTypes
  }
  if (!sameJson(form.visibleRelationshipTypes, initial.visibleRelationshipTypes)) {
    contentUpdates.visibleRelationshipTypes = form.visibleRelationshipTypes
  }
  if (Object.keys(contentUpdates).length > 0) {
    out.content = { ...asObject(out.content), ...contentUpdates }
  }

  if (!sameJson(form.advancedFilters, initial.advancedFilters)) {
    out.filters = { ...asObject(out.filters), fieldFilters: activeFiltersToFieldFilters(form.advancedFilters) }
  }
  return out
}

/** The metadata to import with: the form's name, description, icon and tags. */
export function formToMetadata(form: WizardFormData, viewType: string): BundleViewMetadata {
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    icon: form.icon || null,
    tags: form.tags,
    viewType,
  }
}
