import { useMemo } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  WorkspaceSchema,
  EntityTypeSchema,
  RelationshipTypeSchema,
  ViewConfiguration,
  EntityVisualConfig,
  EntityFieldDefinition,
  EntityBehaviorConfig,
  RelationshipVisualConfig,
} from '@/types/schema'
import type {
  GraphSchema,
  EntityTypeDefinition,
  RelationshipTypeDefinition,
  EdgeTypeMetadata,
} from '@/providers/GraphDataProvider'
import { generateId } from '@/lib/utils'

const EMPTY_ENTITY_TYPES: EntityTypeSchema[] = []
const EMPTY_REL_TYPES: RelationshipTypeSchema[] = []
const EMPTY_STRING_ARRAY: string[] = []
const EMPTY_VIEWS: ViewConfiguration[] = []
const EMPTY_ENTITY_HIERARCHY_MAP: Record<string, { canContain: string[]; canBeContainedBy: string[] }> = {}
const EMPTY_EDGE_TYPE_METADATA_MAP: Record<string, EdgeTypeMetadata> = {}
// These are intentionally EMPTY — the backend's ontology (or its graph introspection)
// defines what containment and lineage mean for each specific graph.
// Components must wait for the schema to load before making hierarchy decisions;
// they must never hardcode graph-topology assumptions.
const DEFAULT_CONTAINMENT_EDGE_TYPES: string[] = []
const DEFAULT_LINEAGE_EDGE_TYPES: string[] = []
const DEFAULT_GLOBAL_VISUALS: WorkspaceSchema['globalVisuals'] = {
  theme: 'dark',
  accentColor: '#6366f1',
  fontFamily: 'Inter',
  borderRadius: 'md',
  showConfidenceScores: true,
  animationsEnabled: true,
}

function jsonEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

interface SchemaState {
  // Current workspace schema
  schema: WorkspaceSchema | null;

  // Active view
  activeViewId: string | null;

  // Active scope key for per-datasource view isolation
  // Format: "${workspaceId}/${dataSourceId}" | null (null = global)
  activeScopeKey: string | null;

  // Scope of the currently-loaded schema. Used by loadFromBackend to detect
  // cross-workspace payload swaps so the no-op guard can't accidentally skip
  // a legitimate workspace switch that happened to produce the same digest.
  // Format: "${workspaceId}/${dataSourceId}" | null.
  lastLoadedScopeKey: string | null;

  // Loading state for backend schema
  isLoadingFromBackend: boolean;
  backendSchemaError: string | null;

  // Actions
  loadSchema: (schema: WorkspaceSchema) => void;
  setActiveView: (viewId: string) => void;

  // Set scope key (called by workspacesStore when ws/ds changes)
  setActiveScopeKey: (workspaceId: string | null, dataSourceId: string | null) => void;

  // Returns only the views visible in the current scope:
  // views where !view.scopeKey (global/legacy) OR view.scopeKey === activeScopeKey
  visibleViews: () => ViewConfiguration[];

  // Backend schema loading. `scope` identifies which workspace/data-source
  // this payload belongs to — loadFromBackend uses it to guard against
  // accidental cross-workspace content swaps and to stamp lastLoadedScopeKey.
  loadFromBackend: (
    backendSchema: GraphSchema,
    scope?: { workspaceId?: string | null; dataSourceId?: string | null },
  ) => void;

  // Full reset: clears schema, active view, and all derived state. Called
  // by cleanupOnWorkspaceSwitch so the next <SchemaScope> render cold-fetches.
  reset: () => void;

  // Entity Types
  addEntityType: (entityType: EntityTypeSchema) => void;
  updateEntityType: (id: string, updates: Partial<EntityTypeSchema>) => void;
  removeEntityType: (id: string) => void;
  getEntityType: (id: string) => EntityTypeSchema | undefined;

  // Relationship Types
  addRelationshipType: (relType: RelationshipTypeSchema) => void;
  updateRelationshipType: (id: string, updates: Partial<RelationshipTypeSchema>) => void;
  removeRelationshipType: (id: string) => void;

  // Views
  addView: (view: ViewConfiguration) => void;
  updateView: (id: string, updates: Partial<ViewConfiguration>) => void;
  addOrUpdateView: (view: ViewConfiguration) => void;
  /** Upsert many views in a single set() call — avoids N sequential store updates. */
  upsertViews: (views: ViewConfiguration[]) => void;
  removeView: (id: string) => void;
  duplicateView: (id: string) => string;
  getActiveView: () => ViewConfiguration | undefined;

  // Helpers
  getVisibleEntityTypes: () => EntityTypeSchema[];
  getEntityVisual: (typeId: string) => EntityVisualConfig | undefined;
}

// ============================================
// Converters: Backend Schema → Frontend Schema
// ============================================

export function convertBackendEntityType(backendEntity: EntityTypeDefinition): EntityTypeSchema {
  return {
    id: backendEntity.id,
    name: backendEntity.name,
    pluralName: backendEntity.pluralName,
    description: backendEntity.description,
    visual: {
      icon: backendEntity.visual.icon,
      color: backendEntity.visual.color,
      shape: backendEntity.visual.shape as EntityVisualConfig['shape'],
      size: backendEntity.visual.size as EntityVisualConfig['size'],
      borderStyle: backendEntity.visual.borderStyle as EntityVisualConfig['borderStyle'],
      showInMinimap: backendEntity.visual.showInMinimap,
    },
    fields: backendEntity.fields.map((f): EntityFieldDefinition => ({
      id: f.id,
      name: f.name,
      type: f.type as EntityFieldDefinition['type'],
      required: f.required,
      showInNode: f.showInNode,
      showInPanel: f.showInPanel,
      showInTooltip: f.showInTooltip,
      displayOrder: f.displayOrder,
    })),
    hierarchy: {
      level: backendEntity.hierarchy.level,
      canContain: backendEntity.hierarchy.canContain,
      canBeContainedBy: backendEntity.hierarchy.canBeContainedBy,
      defaultExpanded: backendEntity.hierarchy.defaultExpanded,
      rollUpFields: [],
    },
    behavior: {
      selectable: backendEntity.behavior.selectable,
      draggable: backendEntity.behavior.draggable,
      expandable: backendEntity.behavior.expandable,
      traceable: backendEntity.behavior.traceable,
      clickAction: backendEntity.behavior.clickAction as EntityBehaviorConfig['clickAction'],
      doubleClickAction: backendEntity.behavior.doubleClickAction as EntityBehaviorConfig['doubleClickAction'],
    },
  }
}

export function convertBackendRelationshipType(backendRel: RelationshipTypeDefinition): RelationshipTypeSchema {
  return {
    id: backendRel.id,
    name: backendRel.name,
    description: backendRel.description,
    sourceTypes: backendRel.sourceTypes,
    targetTypes: backendRel.targetTypes,
    visual: {
      strokeColor: backendRel.visual.strokeColor,
      strokeWidth: backendRel.visual.strokeWidth,
      strokeStyle: backendRel.visual.strokeStyle as RelationshipVisualConfig['strokeStyle'],
      animated: backendRel.visual.animated,
      animationSpeed: backendRel.visual.animationSpeed as RelationshipVisualConfig['animationSpeed'],
      arrowType: backendRel.visual.arrowType as RelationshipVisualConfig['arrowType'],
      curveType: backendRel.visual.curveType as RelationshipVisualConfig['curveType'],
    },
    bidirectional: backendRel.bidirectional,
    showLabel: backendRel.showLabel,
    isContainment: backendRel.isContainment ?? false,
    isLineage: backendRel.isLineage ?? false,
    category: (backendRel.category ?? 'association') as NonNullable<RelationshipTypeSchema['category']>,
  }
}

export const useSchemaStore = create<SchemaState>()(
  persist(
    (set, get) => ({
      schema: null,
      activeViewId: null,
      activeScopeKey: null,
      lastLoadedScopeKey: null,
      isLoadingFromBackend: false,
      backendSchemaError: null,

      loadSchema: (schema) => set((state) => {
        // Preserve the active view when still valid.
        const hasActive = !!state.activeViewId && schema.views.some(v => v.id === state.activeViewId)
        return {
          schema,
          activeViewId: hasActive ? state.activeViewId : schema.defaultViewId,
        }
      }),

      setActiveScopeKey: (workspaceId, dataSourceId) => {
        const key = workspaceId && dataSourceId
          ? `${workspaceId}/${dataSourceId}`
          : workspaceId
            ? `${workspaceId}/default`
            : null

        const currentState = get()
        // Avoid no-op writes that can trigger render loops in strict mode.
        if (currentState.activeScopeKey === key) {
          const schema = currentState.schema
          const hasUnscopedViews = !!schema && schema.views.some(v => !v.scopeKey)
          if (!hasUnscopedViews) return
        }

        if (key) {
          // Migration: tag any unscoped views with a scopeKey derived from their
          // own data. Views WITH a dataSourceId get their exact scope; views WITHOUT
          // (legacy/unscoped) get "wsId/default" so they remain visible across all
          // datasources in their workspace — not pinned to whichever datasource
          // happened to be active at migration time.
          const { schema } = get()
          if (schema) {
            const hasUnscopedViews = schema.views.some(v => !v.scopeKey)
            if (hasUnscopedViews) {
              const migratedViews = schema.views.map(v => {
                if (v.scopeKey) return v
                // Derive correct scopeKey from the view's own binding
                const wsId = v.workspaceId ?? workspaceId
                const viewScopeKey = wsId && v.dataSourceId
                  ? `${wsId}/${v.dataSourceId}`
                  : wsId
                    ? `${wsId}/default`
                    : key
                return { ...v, scopeKey: viewScopeKey }
              })
              set({
                schema: { ...schema, views: migratedViews },
                activeScopeKey: key,
              })
              return
            }
          }
        }

        set({ activeScopeKey: key })
      },

      visibleViews: () => {
        const { schema, activeScopeKey } = get()
        if (!schema) return []
        const activeWorkspaceId = activeScopeKey?.split('/')[0]
        const activeDataSourceId = activeScopeKey?.split('/')[1]
        return schema.views.filter(v => {
          // Global/legacy views with no scope — always visible
          if (!v.scopeKey && !v.workspaceId) return true

          // Use explicit dataSourceId field for precise filtering:
          // - Unscoped views (dataSourceId is null/undefined) → visible for ALL datasources in same workspace
          // - Scoped views (dataSourceId is set) → visible ONLY when that datasource is active
          if (activeWorkspaceId && v.workspaceId === activeWorkspaceId) {
            if (!v.dataSourceId) return true                     // workspace-level → always visible in this workspace
            if (v.dataSourceId === activeDataSourceId) return true // exact datasource match
            return false
          }

          // Fallback: exact scopeKey match (covers edge cases)
          if (v.scopeKey === activeScopeKey) return true

          return false
        })
      },

      // Load backend schema (ontology only — entity types + relationship types).
      // Views are loaded separately from the Context Model API.
      loadFromBackend: (backendSchema, scope) => {
        try {
          const entityTypes = backendSchema.entityTypes.map(convertBackendEntityType)
          const relationshipTypes = backendSchema.relationshipTypes.map(convertBackendRelationshipType)
          // Derive a scope key from whatever the caller passed — if none,
          // fall back to the currently-active scope. The scope key is part
          // of the no-op guard so two workspaces with a coincidentally-
          // identical ontology digest still trigger a legitimate rewrite
          // when the user switches between them.
          const incomingScopeKey = (() => {
            const ws = scope?.workspaceId ?? null
            const ds = scope?.dataSourceId ?? null
            if (ws && ds) return `${ws}/${ds}`
            return get().activeScopeKey
          })()
          set((state) => {
            const prevSchema = state.schema
            const nextContainment = backendSchema.containmentEdgeTypes ?? DEFAULT_CONTAINMENT_EDGE_TYPES
            const nextLineage = backendSchema.lineageEdgeTypes ?? DEFAULT_LINEAGE_EDGE_TYPES

            // Strategic no-op: skip the write only when (a) the payload is
            // byte-identical AND (b) we're still inside the same scope key.
            // Dropping the scope check would let a cross-workspace switch
            // with a matching digest accidentally serve stale state.
            if (
              prevSchema &&
              state.lastLoadedScopeKey === incomingScopeKey &&
              prevSchema.version === backendSchema.version &&
              jsonEquals(prevSchema.entityTypes, entityTypes) &&
              jsonEquals(prevSchema.relationshipTypes, relationshipTypes) &&
              jsonEquals(prevSchema.containmentEdgeTypes ?? DEFAULT_CONTAINMENT_EDGE_TYPES, nextContainment) &&
              jsonEquals(prevSchema.lineageEdgeTypes ?? DEFAULT_LINEAGE_EDGE_TYPES, nextLineage)
            ) {
              if (state.backendSchemaError || state.isLoadingFromBackend) {
                return {
                  ...state,
                  isLoadingFromBackend: false,
                  backendSchemaError: null,
                }
              }
              return state
            }

            // Preserve view state (loaded from Context Model API) across
            // same-scope ontology refreshes, but blow it away on a scope
            // switch — otherwise a stale view from workspace W1 lingers
            // after switching to W2.
            const isSameScope = state.lastLoadedScopeKey === incomingScopeKey
            const preservedViews = isSameScope ? (prevSchema?.views ?? []) : []
            const defaultViewId = isSameScope
              ? (prevSchema?.defaultViewId ?? (preservedViews[0]?.id ?? ''))
              : ''
            const activeViewStillValid =
              isSameScope &&
              !!state.activeViewId &&
              preservedViews.some(v => v.id === state.activeViewId)

            const workspaceSchema: WorkspaceSchema = {
              id: prevSchema?.id ?? generateId('workspace'),
              name: prevSchema?.name ?? 'Dynamic Workspace',
              version: backendSchema.version,
              entityTypes,
              relationshipTypes,
              views: preservedViews,
              defaultViewId,
              globalVisuals: prevSchema?.globalVisuals ?? DEFAULT_GLOBAL_VISUALS,
              containmentEdgeTypes: nextContainment,
              lineageEdgeTypes: nextLineage,
              rootEntityTypes: backendSchema.rootEntityTypes ?? [],
            }

            return {
              ...state,
              schema: workspaceSchema,
              activeViewId: activeViewStillValid ? state.activeViewId : (defaultViewId || null),
              lastLoadedScopeKey: incomingScopeKey,
              isLoadingFromBackend: false,
              backendSchemaError: null,
            }
          })
        } catch (error) {
          set({
            backendSchemaError: error instanceof Error ? error.message : 'Failed to load schema',
            isLoadingFromBackend: false,
          })
        }
      },

      reset: () =>
        set({
          schema: null,
          activeViewId: null,
          lastLoadedScopeKey: null,
          isLoadingFromBackend: false,
          backendSchemaError: null,
        }),

      setActiveView: (viewId) => set({ activeViewId: viewId }),

      // Entity Types
      addEntityType: (entityType) => set((state) => {
        if (!state.schema) return state;
        return {
          schema: {
            ...state.schema,
            entityTypes: [...state.schema.entityTypes, entityType],
          },
        };
      }),

      updateEntityType: (id, updates) => set((state) => {
        if (!state.schema) return state;
        return {
          schema: {
            ...state.schema,
            entityTypes: state.schema.entityTypes.map((et) =>
              et.id === id ? { ...et, ...updates } : et
            ),
          },
        };
      }),

      removeEntityType: (id) => set((state) => {
        if (!state.schema) return state;
        return {
          schema: {
            ...state.schema,
            entityTypes: state.schema.entityTypes.filter((et) => et.id !== id),
          },
        };
      }),

      getEntityType: (id) => {
        return get().schema?.entityTypes.find((et) => et.id === id);
      },

      // Relationship Types
      addRelationshipType: (relType) => set((state) => {
        if (!state.schema) return state;
        return {
          schema: {
            ...state.schema,
            relationshipTypes: [...state.schema.relationshipTypes, relType],
          },
        };
      }),

      updateRelationshipType: (id, updates) => set((state) => {
        if (!state.schema) return state;
        return {
          schema: {
            ...state.schema,
            relationshipTypes: state.schema.relationshipTypes.map((rt) =>
              rt.id === id ? { ...rt, ...updates } : rt
            ),
          },
        };
      }),

      removeRelationshipType: (id) => set((state) => {
        if (!state.schema) return state;
        return {
          schema: {
            ...state.schema,
            relationshipTypes: state.schema.relationshipTypes.filter((rt) => rt.id !== id),
          },
        };
      }),

      // Views
      addView: (view) => set((state) => {
        if (!state.schema) return state;
        // Tag with current scope key (so it only appears for this workspace+datasource)
        const scopedView: ViewConfiguration = state.activeScopeKey
          ? { ...view, scopeKey: view.scopeKey ?? state.activeScopeKey }
          : view
        return {
          schema: {
            ...state.schema,
            views: [...state.schema.views, scopedView],
          },
        };
      }),

      updateView: (id, updates) => set((state) => {
        if (!state.schema) return state;
        return {
          schema: {
            ...state.schema,
            views: state.schema.views.map((v) =>
              v.id === id ? { ...v, ...updates, updatedAt: new Date().toISOString() } : v
            ),
          },
        };
      }),

      addOrUpdateView: (view) => set((state) => {
        if (!state.schema) return state;
        const existingIndex = state.schema.views.findIndex((v) => v.id === view.id);
        if (existingIndex >= 0) {
          const updatedViews = [...state.schema.views];
          updatedViews[existingIndex] = { ...view, updatedAt: new Date().toISOString() };
          return {
            schema: {
              ...state.schema,
              views: updatedViews,
            },
          };
        }
        return {
          schema: {
            ...state.schema,
            views: [...state.schema.views, view],
          },
        };
      }),

      upsertViews: (views) => set((state) => {
        if (views.length === 0) return state
        // If schema hasn't been created yet (ontology not loaded), create a
        // minimal shell so views are stored and available immediately. The
        // ontology data (entity types, relationship types, etc.) will be
        // merged in later by loadFromBackend — it preserves views.
        const schema: WorkspaceSchema = state.schema ?? {
          id: generateId('workspace'),
          name: 'Dynamic Workspace',
          version: '0',
          entityTypes: [],
          relationshipTypes: [],
          views: [],
          defaultViewId: '',
          globalVisuals: DEFAULT_GLOBAL_VISUALS,
          containmentEdgeTypes: DEFAULT_CONTAINMENT_EDGE_TYPES,
          lineageEdgeTypes: DEFAULT_LINEAGE_EDGE_TYPES,
          rootEntityTypes: [],
        }
        const existingMap = new Map(schema.views.map(v => [v.id, v]))
        for (const view of views) {
          existingMap.set(view.id, { ...view, updatedAt: new Date().toISOString() })
        }
        return {
          schema: {
            ...schema,
            views: Array.from(existingMap.values()),
          },
        }
      }),

      removeView: (id) => set((state) => {
        if (!state.schema) return state;
        return {
          schema: {
            ...state.schema,
            views: state.schema.views.filter((v) => v.id !== id),
          },
          activeViewId: state.activeViewId === id
            ? state.schema.defaultViewId
            : state.activeViewId,
        };
      }),

      duplicateView: (id) => {
        const state = get();
        if (!state.schema) return '';

        const original = state.schema.views.find((v) => v.id === id);
        if (!original) return '';

        const newId = generateId('view');
        const now = new Date().toISOString();
        const duplicate: ViewConfiguration = {
          ...original,
          id: newId,
          name: `${original.name} (Copy)`,
          isDefault: false,
          createdAt: now,
          updatedAt: now,
        };

        set((state) => ({
          schema: state.schema ? {
            ...state.schema,
            views: [...state.schema.views, duplicate],
          } : null,
        }));

        return newId;
      },

      getActiveView: () => {
        const { schema, activeViewId } = get();
        if (!schema || !activeViewId) return undefined;
        return schema.views.find((v) => v.id === activeViewId);
      },

      // Helpers
      getVisibleEntityTypes: () => {
        const { schema, activeViewId } = get();
        if (!schema || !activeViewId) return [];

        const view = schema.views.find((v) => v.id === activeViewId);
        if (!view) return schema.entityTypes;

        return schema.entityTypes.filter((et) =>
          view.content.visibleEntityTypes.includes(et.id)
        );
      },

      getEntityVisual: (typeId) => {
        const state = get();
        const entityType = state.getEntityType(typeId);
        if (!entityType) return undefined;

        const view = state.getActiveView();
        const override = view?.entityOverrides[typeId];

        return override
          ? { ...entityType.visual, ...override }
          : entityType.visual;
      },
    }),
    {
      name: 'nexus-schema',
      // ONLY persist `activeViewId` (a UI preference: the last view the user
      // had selected). Schema data is never persisted — it's refetched from
      // the backend via <SchemaScope> on every page load, which is the only
      // safe lifecycle after the Phase 2 refactor. `activeScopeKey` is also
      // intentionally NOT persisted: it mirrors the workspaces store and
      // must be re-derived from the authoritative source on page load.
      // `lastLoadedScopeKey` must also never be persisted — if it survives
      // a reload it will fool the no-op guard into skipping a legitimate
      // first fetch.
      partialize: (state) => ({
        activeViewId: state.activeViewId,
      }),
    }
  )
)

// Selector hooks
export const useActiveView = () => useSchemaStore((s) => s.getActiveView());
export const useEntityTypes = () => useSchemaStore((s) => s.schema?.entityTypes ?? EMPTY_ENTITY_TYPES);
export const useRelationshipTypes = () => useSchemaStore((s) => s.schema?.relationshipTypes ?? EMPTY_REL_TYPES);
export const useSchemaIsLoading = () => useSchemaStore((s) => s.isLoadingFromBackend);
export const useSchemaError = () => useSchemaStore((s) => s.backendSchemaError);
export const useContainmentEdgeTypes = () => useSchemaStore((s) => s.schema?.containmentEdgeTypes ?? DEFAULT_CONTAINMENT_EDGE_TYPES);
export const useLineageEdgeTypes = () => useSchemaStore((s) => s.schema?.lineageEdgeTypes ?? DEFAULT_LINEAGE_EDGE_TYPES);
export const useRootEntityTypes = () => useSchemaStore((s) => s.schema?.rootEntityTypes ?? EMPTY_STRING_ARRAY)
/** All views from the schema, stable empty-array fallback — safe to use as a Zustand selector. */
export const useSchemaViews = () => useSchemaStore((s) => s.schema?.views ?? EMPTY_VIEWS);
export function useEntityTypeHierarchyMap() {
  const entityTypes = useEntityTypes()
  return useMemo(() => {
    if (entityTypes.length === 0) return EMPTY_ENTITY_HIERARCHY_MAP
    return Object.fromEntries(
      entityTypes.map((entityType) => [
        entityType.id,
        {
          canContain: entityType.hierarchy?.canContain ?? EMPTY_STRING_ARRAY,
          canBeContainedBy: entityType.hierarchy?.canBeContainedBy ?? EMPTY_STRING_ARRAY,
        },
      ])
    )
  }, [entityTypes])
}

export function useEdgeTypeMetadataMap() {
  const relTypes = useRelationshipTypes()
  return useMemo(() => {
    if (relTypes.length === 0) return EMPTY_EDGE_TYPE_METADATA_MAP
    return Object.fromEntries(
      relTypes.map((relType) => [
        relType.id,
        {
          isContainment: relType.isContainment ?? false,
          isLineage: relType.isLineage ?? false,
          direction: 'source-to-target',
          category: relType.category ?? 'association',
        },
      ])
    )
  }, [relTypes])
}

// ============================================
// Edge Classification Helpers (non-hook)
// These read from the Zustand store snapshot — call inside components or hooks only.
// ============================================

/** Normalise raw edge type string for case-insensitive comparison */
export function normalizeEdgeType(edge: { data?: { edgeType?: string; relationship?: string } }): string {
  return (edge.data?.edgeType || edge.data?.relationship || '').toUpperCase()
}

/** Pure helper: check edge type against a set of containment types (case-insensitive) */
export function isContainmentEdgeType(edgeType: string, containmentTypes: string[]): boolean {
  const normalized = edgeType.toUpperCase()
  return containmentTypes.some(t => t.toUpperCase() === normalized)
}

/** Pure helper: check edge type against a set of lineage types (case-insensitive) */
export function isLineageEdgeType(edgeType: string, lineageTypes: string[]): boolean {
  const normalized = edgeType.toUpperCase()
  return lineageTypes.some(t => t.toUpperCase() === normalized)
}

/** Hook: returns whether an edge type is a containment edge per the loaded ontology */
export function useIsContainmentEdge() {
  const types = useContainmentEdgeTypes()
  return (edgeType: string) => isContainmentEdgeType(edgeType, types)
}

/** Hook: returns whether an edge type is a lineage edge per the loaded ontology */
export function useIsLineageEdge() {
  const types = useLineageEdgeTypes()
  return (edgeType: string) => isLineageEdgeType(edgeType, types)
}

/** Hook: returns edge classification category from relationship definitions */
export function useGetEdgeClassification() {
  const relTypes = useRelationshipTypes()
  return (edgeType: string): 'structural' | 'flow' | 'metadata' | 'association' => {
    const upper = edgeType.toUpperCase()
    const rel = relTypes.find(r => r.id.toUpperCase() === upper)
    return (rel?.category as 'structural' | 'flow' | 'metadata' | 'association') ?? 'association'
  }
}

/** Hook: returns full relationship definition for an edge type (used for metadata access) */
export function useGetEdgeTypeDefinition() {
  const relTypes = useRelationshipTypes()
  return (edgeType: string) => {
    const upper = edgeType.toUpperCase()
    return relTypes.find(r => r.id.toUpperCase() === upper) ?? null
  }
}

/**
 * Hook: returns the ontology entity type schemas for the active data source.
 * Each entry includes hierarchy.level (0 = coarsest/root, higher = finer/leaf)
 * which drives all granularity-based projections and lineage aggregation.
 */
export function useSchemaEntityTypes() {
  return useSchemaStore((s) => s.schema?.entityTypes ?? EMPTY_ENTITY_TYPES)
}

