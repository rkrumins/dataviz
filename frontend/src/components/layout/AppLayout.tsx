/**
 * Root layout component for the app. Wraps all routes with:
 * - Auth guard
 * - ReactFlowProvider
 * - Schema/graph initialization
 * - TopBar, SidebarNav, and React Router Outlet
 *
 * Refactored from AppShell + App.tsx to support route-based navigation.
 */
import { useEffect, useMemo, useState, useRef, createContext, useContext } from 'react'
import { Outlet, Navigate } from 'react-router-dom'
import { ReactFlowProvider } from '@xyflow/react'
import { TopBar } from './TopBar'
import { SidebarNav } from './SidebarNav'
import { CommandPalette } from './CommandPalette'
import { ViewWizard } from '@/components/views/ViewWizard'
import { LoginPage } from '@/components/auth/LoginPage'
import { useAuthStore } from '@/store/auth'
import { usePreferencesStore } from '@/store/preferences'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { defaultWorkspaceSchema } from '@/lib/default-schema'
import { useOntologyMetadata, getCachedOntologyMetadata } from '@/services/ontologyService'
import { listContextModels, contextModelToViewConfig } from '@/services/contextModelService'
import { useWorkspacesStore } from '@/store/workspaces'
import { useRouteSync } from '@/hooks/useRouteSync'
import { cn } from '@/lib/utils'

// Context for View Editor Modal
interface ViewEditorContextType {
  openViewEditor: (viewId?: string) => void
  closeViewEditor: () => void
}

const ViewEditorContext = createContext<ViewEditorContextType | null>(null)

export function useViewEditorModal() {
  const context = useContext(ViewEditorContext)
  if (!context) {
    throw new Error('useViewEditorModal must be used within AppLayout')
  }
  return context
}

export function AppLayout() {
  const { isAuthenticated } = useAuthStore()
  const { theme, sidebarCollapsed } = usePreferencesStore()
  const { setNodes, setEdges, setActiveLens } = useCanvasStore()
  const { loadSchema, schema, mergeBackendSchema, loadFromBackend } = useSchemaStore()
  const provider = useGraphProvider()
  const { containmentEdgeTypes, isLoading: isLoadingOntology, metadata: ontologyMetadata } = useOntologyMetadata()

  const [hasLoadedBackendSchema, setHasLoadedBackendSchema] = useState(false)
  const [isLoadingBackendSchema, setIsLoadingBackendSchema] = useState(false)
  const graphLoadedForProviderRef = useRef<typeof provider | null>(null)

  // View editor state
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [viewEditorOpen, setViewEditorOpen] = useState(false)
  const [editingViewId, setEditingViewId] = useState<string | undefined>()

  const openViewEditor = (viewId?: string) => {
    setEditingViewId(viewId)
    setViewEditorOpen(true)
  }
  const closeViewEditor = () => {
    setViewEditorOpen(false)
    setEditingViewId(undefined)
  }

  // Sync React Router location with Zustand navigation store
  useRouteSync()

  const effectiveContainmentTypes = useMemo(() =>
    containmentEdgeTypes.length > 0
      ? containmentEdgeTypes
      : ['CONTAINS', 'BELONGS_TO'],
    [containmentEdgeTypes]
  )

  // Load schema from backend on startup
  useEffect(() => {
    if (!isAuthenticated || hasLoadedBackendSchema || isLoadingBackendSchema) return

    const loadBackendSchema = async () => {
      setIsLoadingBackendSchema(true)
      try {
        const backendSchema = await provider.getFullSchema()
        if (backendSchema && backendSchema.entityTypes.length > 0) {
          if (schema) {
            mergeBackendSchema(backendSchema)
          } else {
            loadFromBackend(backendSchema)
          }
        } else {
          if (!schema) loadSchema(defaultWorkspaceSchema)
        }
      } catch {
        if (!schema) loadSchema(defaultWorkspaceSchema)
      } finally {
        setHasLoadedBackendSchema(true)
        setIsLoadingBackendSchema(false)
      }
    }
    loadBackendSchema()
  }, [isAuthenticated, hasLoadedBackendSchema, isLoadingBackendSchema, provider, schema, mergeBackendSchema, loadFromBackend, loadSchema])

  // Load views from the Context Model API into the schema store cache
  const activeWorkspaceId = useWorkspacesStore(s => s.activeWorkspaceId)
  useEffect(() => {
    if (!isAuthenticated || !hasLoadedBackendSchema || !activeWorkspaceId) return

    const loadViews = async () => {
      try {
        const models = await listContextModels(activeWorkspaceId)
        const { addOrUpdateView } = useSchemaStore.getState()
        for (const cm of models) {
          addOrUpdateView(contextModelToViewConfig(cm))
        }
      } catch (err) {
        console.error('[AppLayout] Failed to load views from API:', err)
      }
    }
    loadViews()
  }, [isAuthenticated, hasLoadedBackendSchema, activeWorkspaceId])

  // Initialize graph data
  useEffect(() => {
    if (!isAuthenticated) return
    if (!hasLoadedBackendSchema && !schema) return

    const cachedMeta = getCachedOntologyMetadata()
    if (isLoadingOntology && !ontologyMetadata && !cachedMeta) return
    if (graphLoadedForProviderRef.current === provider) return
    graphLoadedForProviderRef.current = provider

    if (!schema) loadSchema(defaultWorkspaceSchema)

    const fetchInitialGraph = async () => {
      try {
        const rootTypes = ontologyMetadata?.rootEntityTypes?.length && ontologyMetadata.rootEntityTypes.length > 0
          ? ontologyMetadata.rootEntityTypes
          : ['domain', 'dataPlatform', 'system']

        const childTypes = new Set<string>()
        if (ontologyMetadata?.entityTypeHierarchy) {
          for (const rootType of rootTypes) {
            const hierarchy = ontologyMetadata.entityTypeHierarchy[rootType]
            if (hierarchy?.canContain) {
              hierarchy.canContain.forEach((t: string) => childTypes.add(t))
            }
          }
        }

        const rootNodes = await provider.getNodes({ entityTypes: rootTypes as any[], limit: 200 })
        const childrenResults = await Promise.all(
          rootNodes.map(root => provider.getChildren(root.urn, { limit: 100 }))
        )
        const allChildren = childrenResults.flat()

        let orphanNodes: typeof rootNodes = []
        if (childTypes.size > 0) {
          const childTypeNodes = await provider.getNodes({ entityTypes: [...childTypes] as any[], limit: 200 })
          const knownUrns = new Set([...rootNodes.map(n => n.urn), ...allChildren.map(n => n.urn)])
          orphanNodes = childTypeNodes.filter(n => !knownUrns.has(n.urn))
        }

        const nodeMap = new Map<string, typeof rootNodes[0]>()
        for (const n of [...rootNodes, ...allChildren, ...orphanNodes]) {
          nodeMap.set(n.urn, n)
        }
        const uniqueNodes = Array.from(nodeMap.values())
        if (uniqueNodes.length === 0) return

        const urnSet = new Set(uniqueNodes.map(n => n.urn))
        const outgoingEdges = await provider.getEdges({ sourceUrns: [...urnSet], limit: 2000 })
        const uniqueEdges = outgoingEdges.filter(e => urnSet.has(e.targetUrn))

        const toNodeType = (entityType: string) => {
          switch (entityType) {
            case 'schemaField': case 'column': return 'column'
            case 'dataPlatform': case 'system': return 'system'
            case 'dataset': case 'table': return 'dataset'
            case 'container': return 'container'
            default: return 'domain'
          }
        }

        setNodes(uniqueNodes.map(n => ({
          id: n.urn,
          type: toNodeType(n.entityType as string),
          position: { x: Math.random() * 800, y: Math.random() * 600 },
          data: {
            label: n.displayName,
            type: n.entityType as any,
            metadata: n.properties,
            childCount: n.childCount,
            classifications: n.tags,
            businessLabel: n.properties?.businessLabel as string,
            ...n
          }
        })))

        setEdges(uniqueEdges.map(e => ({
          id: e.id,
          source: e.sourceUrn,
          target: e.targetUrn,
          type: 'lineage',
          data: {
            edgeType: e.edgeType,
            relationship: e.edgeType,
            ...e.properties
          }
        })))
      } catch (err) {
        console.error("Failed to load initial backend data", err)
      }
    }

    fetchInitialGraph()
  }, [isAuthenticated, hasLoadedBackendSchema, isLoadingOntology, ontologyMetadata, provider, effectiveContainmentTypes.join(','), setNodes, setEdges, setActiveLens, loadSchema, schema])

  // Apply theme
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') {
      const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      root.classList.toggle('dark', systemDark)
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      const handler = (e: MediaQueryListEvent) => root.classList.toggle('dark', e.matches)
      mediaQuery.addEventListener('change', handler)
      return () => mediaQuery.removeEventListener('change', handler)
    } else {
      root.classList.toggle('dark', theme === 'dark')
    }
  }, [theme])

  if (!isAuthenticated) {
    return <LoginPage />
  }

  return (
    <ReactFlowProvider>
      <ViewEditorContext.Provider value={{ openViewEditor, closeViewEditor }}>
        <div className="h-screen w-screen flex flex-col overflow-hidden bg-canvas">
          <TopBar onOpenCommandPalette={() => setCommandPaletteOpen(true)} />

          <div className="flex-1 flex overflow-hidden">
            <SidebarNav />

            <main
              className={cn(
                "flex-1 relative overflow-hidden transition-all duration-300",
                sidebarCollapsed ? "ml-16" : "ml-64"
              )}
            >
              <Outlet />
            </main>
          </div>

          <CommandPalette
            open={commandPaletteOpen}
            onOpenChange={setCommandPaletteOpen}
          />

          <ViewWizard
            mode={editingViewId ? 'edit' : 'create'}
            viewId={editingViewId}
            isOpen={viewEditorOpen}
            onClose={closeViewEditor}
            onComplete={() => closeViewEditor()}
          />
        </div>
      </ViewEditorContext.Provider>
    </ReactFlowProvider>
  )
}
