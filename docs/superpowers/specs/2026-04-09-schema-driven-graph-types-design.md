# Schema-Driven Graph Types: Remove All Hardcoding

## Context

The graph visualization system currently hardcodes entity types (14 values) and edge types (10 values) as Python enums and TypeScript unions. This prevents visualizing graphs with custom schemas -- e.g., a physical lineage graph with edge types like `has`, `hasChild` and entity types like `Layer`, `Object`, `Group`. The backend ontology system already supports arbitrary types, but the frontend and parts of the backend still assume a fixed set of types.

**Goal:** Any graph with any schema can be visualized without code changes. The ontology (served via `GET /graph/metadata/schema`) is the single source of truth.

## Scope

### In scope
- Remove `EntityType`, `EdgeType`, `Granularity` enums from backend `graph.py`
- Use plain string literals everywhere (no constants module)
- Retire frontend `MockProvider.ts` and `demo-data.ts` entirely
- Retire backend `mock_provider.py` and `demo_data.py` entirely
- Open frontend `EdgeType` union to `string`
- Add curated-palette hash-based fallback visuals for unknown types
- Remove hardcoded color/icon maps from 5 frontend components
- Reduce `default-schema.ts` to minimal fallback, rename to `fallback-schema.ts`
- Update tests that depend on retired modules

### Out of scope (deferred)
- GraphQL `Granularity` enum in `graphql/types.py` (separate API contract change)
- Frontend `LineageGranularity` type and LOD mapping (depends on GraphQL change)

---

## Backend Changes

### 1. Remove enums from `common/models/graph.py`

Delete these classes entirely (lines 9-48):
- `EntityType(str, Enum)` -- 14 hardcoded entity types
- `EdgeType(str, Enum)` -- 10 hardcoded edge types
- `Granularity(str, Enum)` -- 5 fixed levels (already deprecated)

Keep `FilterOperator(str, Enum)` -- this is a query operator, not a data type.

Update the comments on `GraphNode.entity_type` (line 68) and `GraphEdge.edge_type` (line 86) to remove references to the deleted enums.

Update the re-export barrel `app/models/graph.py` to remove `EntityType`, `EdgeType`, `Granularity` from imports and `__all__`.

### 2. Update all enum consumers to use plain strings

No constants module. The ontology is the source of truth. String literals are used directly:

| File | Change |
|------|--------|
| `app/providers/falkordb_provider.py` | `EdgeType.CONTAINS.value` -> `"CONTAINS"`, etc. Remove import. ~8 sites. |
| `app/providers/neo4j_provider.py` | Same pattern as FalkorDB. ~8 sites. |
| `app/services/assignment_engine.py` | `EdgeType.CONTAINS.value.upper()` -> `"CONTAINS"`. Remove import. ~2 sites. |
| `app/services/lineage_aggregator.py` | Dead import removal only. |
| `common/models/assignment.py` | Dead import removal only. |
| `scripts/seed_falkordb.py` | `EntityType.DOMAIN` -> `"domain"`, type hints `EdgeType` -> `str`. ~40 sites. |
| `scripts/seed_large_lineage.py` | Same pattern. ~30 sites. |
| `scripts/seed_platform_lineage.py` | Same pattern. `.value` guards simplify. ~50 sites. |
| `scripts/seed_data_lake.py` | Same pattern. ~40 sites. |
| `scripts/seed_neo4j.py` | Dead import removal only. |
| `scripts/optimize_falkordb.py` | ~5 sites. |
| `scripts/generate_analytics_data.py` | ~30 sites. |
| `scripts/add_column_lineage.py` | Dead import removal only. |
| `tests/test_falkordb_provider.py` | Replace enum values with string literals in assertions. |

### 3. Retire backend MockProvider and demo data

**Delete files:**
- `backend/app/providers/mock_provider.py`
- `backend/app/core/demo_data.py`
- `backend/tests/test_mock_provider.py`

**Update files:**
- `backend/app/registry/provider_registry.py` -- Remove `"mock"` case from provider creation (line 363) and type mappings (lines 392, 499)
- `backend/tests/test_api_graph.py` -- Replace MockProvider with `_StubProvider` pattern (already used in `test_context_engine.py`)
- `backend/tests/test_provider_registry.py` -- Remove/update tests that reference MockProvider (5 test functions)
- `backend/tests/test_context_engine.py` -- Line 168 imports MockProvider; replace with `_StubProvider` that's already defined in the same file

### 4. No API contract changes

The wire protocol is unchanged. `GraphNode.entity_type` and `GraphEdge.edge_type` are already `str` fields. The REST API (`/graph/metadata/schema`) already serves string-based schema. The values `"domain"`, `"CONTAINS"`, etc. are identical whether they came from `EntityType.DOMAIN.value` or the bare string `"domain"`.

---

## Frontend Changes

### 1. Open `EdgeType` to `string`

**File:** `src/providers/GraphDataProvider.ts` (line 36)

Change from closed union:
```typescript
export type EdgeType =
    | 'CONTAINS' | 'BELONGS_TO' | 'TRANSFORMS'
    | 'PRODUCES' | 'CONSUMES' | 'TAGGED_WITH' | 'RELATED_TO'
```
To:
```typescript
export type EdgeType = string
```

Safe because: no exhaustive switch statements exist on `EdgeType` in this codebase. All edge type checks use string comparison (`.includes()`, `.toUpperCase() === ...`).

### 2. Create curated-palette visual fallback utility

**New file:** `src/lib/type-visuals.ts`

Pure utility (no React dependencies) that generates deterministic visuals from a type name string.

**Functions:**
- `hashString(str: string): number` -- Reuse the `simpleHash` algorithm from `workspaceColor.ts` (djb2 variant)
- `generateColorFromType(typeId: string): string` -- Index into a curated palette of 16 perceptually-distinct hex colors via `hashString(typeId) % 16`. NOT raw HSL generation (produces ugly adjacent colors per reviewer feedback). Palette inspired by Tailwind's `-500` scale colors.
- `generateIconFallback(typeId: string): string` -- Index into a curated set of ~12 generic Lucide icon names (Box, Database, Table2, Layers, Workflow, LayoutDashboard, Server, Package, FolderOpen, Columns3, GitBranch, Network) via `hashString(typeId) % 12`.
- `generateEdgeColorFromType(edgeTypeId: string): string` -- Same palette approach for edge types.

**Design:** Deterministic (same input = same color/icon always), no React deps, testable in isolation. Replaces the existing `getDefaultColor()` in `edgeTypeUtils.tsx:78-90`.

### 3. Enhance existing visual hooks with palette fallbacks

**File:** `src/hooks/useEntityVisual.ts`

Replace the static `ENTITY_VISUAL_FALLBACK` (always `#6366f1` / `Box`) with a function that returns per-type deterministic visuals:

```typescript
function entityVisualFallback(typeId: string): EntityVisualConfig {
  return {
    icon: generateIconFallback(typeId),
    color: generateColorFromType(typeId),
    shape: 'rounded', size: 'md', borderStyle: 'solid', showInMinimap: true,
  }
}
```

Same for `EDGE_VISUAL_FALLBACK` -> `edgeVisualFallback(edgeTypeId)`.

Also add a convenience hook for components that need Tailwind-style color sets:
```typescript
export function useEntityColorSet(typeId: string): { hex: string; bg: string; text: string; accent: string }
```

### 4. Remove hardcoded color maps from 5 components

| Component | Current hardcoding | Change |
|-----------|-------------------|--------|
| `DetailPanel.tsx:42-49` | `typeColors` map (6 entity types) | Use `useEntityColorSet(nodeType)` with inline styles instead of Tailwind classes |
| `EntityDrawer.tsx:90-99` | `typeColors` map (8 entity types) | Use `entityType.visual.color` (already resolved on line 83-86), fallback to `useEntityColorSet` |
| `LineageCanvas.tsx:662-673` | hex color switch in `minimapNodeColor` | Replace switch with `generateColorFromType(nodeType)` (schema path on line 656 already handles known types) |
| `LayeredLineageCanvas.tsx:262-268` | Same pattern as LineageCanvas | Same fix: `generateColorFromType(nodeType)` |
| `LineageEdge.tsx:70-86` | `typeColors` map (5 edge types) + `edgeTypeLabel` map | Use `useEdgeVisual(edgeType)` which now returns palette-based fallback colors |

Also update `LineageEdge.tsx` line 14: change `LineageEdgeData.edgeType` from `'produces' | 'consumes' | 'transforms'` to `string`.

### 5. Fix `FlatTreeItem.tsx` icon switch

**File:** `src/components/canvas/context-view/FlatTreeItem.tsx` (line 73)

Replace:
```typescript
node.typeId === 'system' ? 'Server' : node.typeId === 'container' ? 'Package' : 'FolderOpen'
```
With:
```typescript
entityType?.visual?.icon ?? generateIconFallback(node.typeId)
```

The `entityType` variable is already resolved on line 68.

### 6. Retire frontend MockProvider

**Delete files:**
- `src/providers/MockProvider.ts`
- `src/lib/demo-data.ts`

**Update files:**
- `src/providers/GraphProviderContext.tsx` -- Remove lazy MockProvider loading (lines 20-30), remove fallback to MockProvider in `useGraphProvider()` (lines 232-235) and `useGraphProviderContext()` (lines 248-263). When no provider context exists, throw immediately or show error state.
- `src/providers/index.ts` -- Remove MockProvider export
- `src/components/admin/RegistryConnections.tsx` -- Remove any MockProvider references
- `src/components/admin/RegistryAssets.tsx` -- Remove any MockProvider references

**Error state when backend unreachable:** The `GraphProviderContext` should surface the error via the existing `error` field. The UI shell renders but shows a clear "Cannot connect to backend" message with retry, instead of silently falling back to fake data.

### 7. Reduce `default-schema.ts` -> `fallback-schema.ts`

Rename `src/lib/default-schema.ts` to `src/lib/fallback-schema.ts`.

Reduce from 10 entity types to 4 minimal ones needed for basic rendering: `domain`, `dataset`, `column`, `ghost`. Remove `system`, `dataPlatform`, `container`, `schema`, `pipeline`, `dashboard`.

Reduce relationship types to 1 generic: `contains` (structural). Remove `produces`, `consumes`, `transforms`.

Keep `containmentEdgeTypes: []`, `lineageEdgeTypes: []`, `rootEntityTypes: []` (already correct -- the fallback should not assume any classification).

Add header comment: "FALLBACK ONLY. Used when the backend is unreachable and schema store has no cached data. The backend ontology is always preferred."

Update all imports of `defaultWorkspaceSchema` to use the new path/name.

---

## Edge Type Case Convention

**Convention:** Edge type IDs are UPPER_SNAKE_CASE on the wire (`CONTAINS`, `PRODUCES`, `FLOWS_TO`). All comparison code must use case-insensitive matching. The existing `normalizeEdgeType()` in `store/schema.ts` handles this. New code must follow the same pattern.

---

## Verification Plan

### Backend
1. Run `python -c "from backend.common.models.graph import GraphNode, GraphEdge"` -- verify no ImportError
2. Run `python -c "from backend.app.models.graph import *"` -- verify re-exports work without enums
3. Run full pytest suite -- all tests pass
4. Run one seed script against a test FalkorDB instance -- verify nodes/edges created with correct string types
5. Verify `GET /graph/metadata/schema` returns unchanged JSON structure

### Frontend
1. `npx tsc --noEmit` -- no compile errors after EdgeType widening
2. Load app with the standard ontology -- all existing entity/edge types render with their ontology-defined colors/icons (not hash fallbacks)
3. Load app with a custom ontology containing unknown types (e.g., `Layer`, `Object`, `has`, `hasChild`) -- they render with distinct, stable colors and generic icons
4. Disconnect backend -- app shows error state, not mock data
5. Verify EdgeLegend, DetailPanel, EntityDrawer all display custom types correctly
6. Verify minimap colors are deterministic (same type = same color across sessions)
