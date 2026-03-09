import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  WorkspaceSchema,
  EntityTypeSchema,
  RelationshipTypeSchema,
  ViewConfiguration,
  EntityVisualConfig,
  EntityFieldDefinition,
  EntityHierarchyConfig,
  EntityBehaviorConfig,
  RelationshipVisualConfig,
} from '@/types/schema'
import type { GraphSchema, EntityTypeDefinition, RelationshipTypeDefinition } from '@/providers/GraphDataProvider'
import { generateId } from '@/lib/utils'

interface SchemaState {
  // Current workspace schema
  schema: WorkspaceSchema | null;

  // Active view
  activeViewId: string | null;

  // Active scope key for per-datasource view isolation
  // Format: "${workspaceId}/${dataSourceId}" | null (null = global)
  activeScopeKey: string | null;

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

  // Backend schema loading
  loadFromBackend: (backendSchema: GraphSchema) => void;
  mergeBackendSchema: (backendSchema: GraphSchema) => void;

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

function convertBackendEntityType(backendEntity: EntityTypeDefinition): EntityTypeSchema {
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

function convertBackendRelationshipType(backendRel: RelationshipTypeDefinition): RelationshipTypeSchema {
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
  }
}

export const useSchemaStore = create<SchemaState>()(
  persist(
    (set, get) => ({
      schema: null,
      activeViewId: null,
      activeScopeKey: null,
      isLoadingFromBackend: false,
      backendSchemaError: null,

      loadSchema: (schema) => set({
        schema,
        activeViewId: schema.defaultViewId
      }),

      setActiveScopeKey: (workspaceId, dataSourceId) => {
        const key = workspaceId && dataSourceId
          ? `${workspaceId}/${dataSourceId}`
          : workspaceId
            ? `${workspaceId}/default`
            : null

        if (key) {
          // Migration: tag any unscoped views with the current scope on first set.
          // This prevents views created before scoping was introduced from bleeding
          // across data sources. They are attributed to whichever scope is active
          // when the user first runs the updated app.
          const { schema } = get()
          if (schema) {
            const hasUnscopedViews = schema.views.some(v => !v.scopeKey)
            if (hasUnscopedViews) {
              const migratedViews = schema.views.map(v =>
                v.scopeKey ? v : { ...v, scopeKey: key }
              )
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
        return schema.views.filter(
          v => !v.scopeKey || v.scopeKey === activeScopeKey
        )
      },

      // Load backend schema (ontology only — entity types + relationship types).
      // Views are loaded separately from the Context Model API.
      loadFromBackend: (backendSchema) => {
        try {
          const entityTypes = backendSchema.entityTypes.map(convertBackendEntityType)
          const relationshipTypes = backendSchema.relationshipTypes.map(convertBackendRelationshipType)

          const workspaceSchema: WorkspaceSchema = {
            id: generateId('workspace'),
            name: 'Dynamic Workspace',
            version: backendSchema.version,
            entityTypes,
            relationshipTypes,
            views: [],  // Views come from the Context Model API
            defaultViewId: '',
            globalVisuals: {
              theme: 'dark',
              accentColor: '#6366f1',
              fontFamily: 'Inter',
              borderRadius: 'md',
              showConfidenceScores: true,
              animationsEnabled: true,
            },
            containmentEdgeTypes: backendSchema.containmentEdgeTypes,
          }

          set({
            schema: workspaceSchema,
            activeViewId: null,
            isLoadingFromBackend: false,
            backendSchemaError: null,
          })
        } catch (error) {
          set({
            backendSchemaError: error instanceof Error ? error.message : 'Failed to load schema',
            isLoadingFromBackend: false,
          })
        }
      },

      // Merge backend schema with existing local customizations
      mergeBackendSchema: (backendSchema) => {
        const existing = get().schema

        if (!existing) {
          // No existing schema, just load fresh
          get().loadFromBackend(backendSchema)
          return
        }

        try {
          const backendEntityTypes = backendSchema.entityTypes.map(convertBackendEntityType)
          const backendRelTypes = backendSchema.relationshipTypes.map(convertBackendRelationshipType)

          // Merge entity types: backend wins for base definition, local wins for visual overrides
          const existingEntityMap = new Map(existing.entityTypes.map(e => [e.id, e]))
          const mergedEntityTypes: EntityTypeSchema[] = []

          for (const backendEntity of backendEntityTypes) {
            const localEntity = existingEntityMap.get(backendEntity.id)
            if (localEntity) {
              // Merge: use backend fields/hierarchy, preserve local visual customizations
              mergedEntityTypes.push({
                ...backendEntity,
                visual: {
                  ...backendEntity.visual,
                  // Keep local color if it was customized (different from backend)
                  color: localEntity.visual.color !== '#6366f1' ? localEntity.visual.color : backendEntity.visual.color,
                },
                // Preserve local behavior overrides
                behavior: {
                  ...backendEntity.behavior,
                  ...localEntity.behavior,
                },
              })
              existingEntityMap.delete(backendEntity.id)
            } else {
              // New entity from backend
              mergedEntityTypes.push(backendEntity)
            }
          }

          // Keep local-only entity types (user-created)
          for (const localEntity of existingEntityMap.values()) {
            mergedEntityTypes.push(localEntity)
          }

          // Merge relationship types similarly
          const existingRelMap = new Map(existing.relationshipTypes.map(r => [r.id, r]))
          const mergedRelTypes: RelationshipTypeSchema[] = []

          for (const backendRel of backendRelTypes) {
            const localRel = existingRelMap.get(backendRel.id)
            if (localRel) {
              // Keep local visual customizations
              mergedRelTypes.push({
                ...backendRel,
                visual: {
                  ...backendRel.visual,
                  strokeColor: localRel.visual.strokeColor !== '#6366f1' ? localRel.visual.strokeColor : backendRel.visual.strokeColor,
                },
              })
              existingRelMap.delete(backendRel.id)
            } else {
              mergedRelTypes.push(backendRel)
            }
          }

          // Keep local-only relationship types
          for (const localRel of existingRelMap.values()) {
            mergedRelTypes.push(localRel)
          }

          // Views are managed exclusively via the Context Model API — don't touch them here
          set({
            schema: {
              ...existing,
              entityTypes: mergedEntityTypes,
              relationshipTypes: mergedRelTypes,
              containmentEdgeTypes: backendSchema.containmentEdgeTypes,
            },
            isLoadingFromBackend: false,
            backendSchemaError: null,
          })
        } catch (error) {
          set({
            backendSchemaError: error instanceof Error ? error.message : 'Failed to merge schema',
            isLoadingFromBackend: false,
          })
        }
      },

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
      partialize: (state) => ({
        schema: state.schema,
        activeViewId: state.activeViewId,
        activeScopeKey: state.activeScopeKey,
      }),
    }
  )
)

// Selector hooks
export const useActiveView = () => useSchemaStore((s) => s.getActiveView());
export const useEntityTypes = () => useSchemaStore((s) => s.schema?.entityTypes ?? []);
export const useRelationshipTypes = () => useSchemaStore((s) => s.schema?.relationshipTypes ?? []);
export const useSchemaLoadingState = () => useSchemaStore((s) => ({
  isLoading: s.isLoadingFromBackend,
  error: s.backendSchemaError,
}));
export const useContainmentEdgeTypes = () => useSchemaStore((s) => s.schema?.containmentEdgeTypes ?? ['CONTAINS', 'BELONGS_TO']);

