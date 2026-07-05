/**
 * resolveRowLayer — pure, ONTOLOGY-AGNOSTIC per-row layer resolution for Build Mode.
 *
 * Build Mode places each entity in the column configured for ITS TYPE, for ANY
 * schema. Nothing here hard-codes a type or layer name: the `typeId → layerId`
 * map is derived at runtime from the view's own `sortedLayers[].entityTypes`, so
 * `Layer→Object→Group→Attribute`, `Domain→Application→Database→Table→Column`, or
 * any hierarchy of any depth work identically. Handles fewer columns than types
 * (unmapped types hit the fallback), a column holding several types, and a type
 * mapping to several columns (deterministic: first in `sortedLayers` wins).
 */
import type { BuildRow } from './buildRow'

/** Minimal row shape needed to place a row. A full `BuildRow` satisfies it, but
 *  callers/tests may pass a bare `{ typeId }`. `layerId` is the explicit per-row
 *  override the Grid sets in Task 2 (supported now). */
export type RowLike = Pick<BuildRow, 'typeId'> & { id?: string; layerId?: string }

export interface ResolveRowLayerContext {
  /** `typeId` (lower-cased) → `layerId`, from `buildTypeLayerMap(sortedLayers)`. */
  typeLayerMap: Map<string, string>
  /** `rowId` → explicit per-row layer override (set by the Grid in Task 2). */
  overrides?: Map<string, string>
  /** Layer for a type that maps to no column — the Build-open layer (`buildLayerId`). */
  fallbackLayerId?: string
}

/**
 * Build a `typeId → layerId` map from a view's layers. Case-insensitive; when a
 * type appears in several layers the FIRST (earliest in `sortedLayers`) wins, so
 * a multi-mapped type resolves deterministically. Layers with no `entityTypes`
 * contribute nothing.
 */
export function buildTypeLayerMap(
  sortedLayers: { id: string; entityTypes?: string[] }[],
): Map<string, string> {
  const map = new Map<string, string>()
  for (const layer of sortedLayers) {
    for (const type of layer.entityTypes ?? []) {
      const key = type.toLowerCase()
      if (!map.has(key)) map.set(key, layer.id)
    }
  }
  return map
}

/**
 * Resolve a single row's target layer:
 *   1. explicit per-row override — `overrides[row.id]`, else the row's own
 *      `layerId` field (the Grid override, Task 2),
 *   2. else the row's type-derived layer (`typeLayerMap[row.typeId]`),
 *   3. else `fallbackLayerId`.
 * Returns `undefined` only when the type maps nowhere and no fallback is given.
 */
export function resolveRowLayer(row: RowLike, ctx: ResolveRowLayerContext): string | undefined {
  const override = (row.id != null ? ctx.overrides?.get(row.id) : undefined) ?? row.layerId
  if (override) return override
  const typeKey = row.typeId?.toLowerCase()
  const typeLayer = typeKey != null ? ctx.typeLayerMap.get(typeKey) : undefined
  return typeLayer ?? ctx.fallbackLayerId
}
