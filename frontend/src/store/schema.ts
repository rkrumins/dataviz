import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { 
  WorkspaceSchema, 
  EntityTypeSchema, 
  RelationshipTypeSchema,
  ViewConfiguration,
  EntityVisualConfig,
} from '@/types/schema'
import { generateId } from '@/lib/utils'

interface SchemaState {
  // Current workspace schema
  schema: WorkspaceSchema | null;
  
  // Active view
  activeViewId: string | null;
  
  // Actions
  loadSchema: (schema: WorkspaceSchema) => void;
  setActiveView: (viewId: string) => void;
  
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
  removeView: (id: string) => void;
  duplicateView: (id: string) => string;
  getActiveView: () => ViewConfiguration | undefined;
  
  // Helpers
  getVisibleEntityTypes: () => EntityTypeSchema[];
  getEntityVisual: (typeId: string) => EntityVisualConfig | undefined;
}

export const useSchemaStore = create<SchemaState>()(
  persist(
    (set, get) => ({
      schema: null,
      activeViewId: null,
      
      loadSchema: (schema) => set({ 
        schema, 
        activeViewId: schema.defaultViewId 
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
        return {
          schema: {
            ...state.schema,
            views: [...state.schema.views, view],
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
      }),
    }
  )
)

// Selector hooks
export const useActiveView = () => useSchemaStore((s) => s.getActiveView());
export const useEntityTypes = () => useSchemaStore((s) => s.schema?.entityTypes ?? []);
export const useRelationshipTypes = () => useSchemaStore((s) => s.schema?.relationshipTypes ?? []);

