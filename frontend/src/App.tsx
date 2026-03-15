import { useEffect, useRef } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { AppShell } from '@/components/layout/AppShell'
import { LoginPage } from '@/components/auth/LoginPage'
import { useAuthStore } from '@/store/auth'
import { usePreferencesStore } from '@/store/preferences'
import { useCanvasStore } from '@/store/canvas'
import {
  useSchemaStore,
  useContainmentEdgeTypes,
  useRootEntityTypes,
  useEntityTypeHierarchyMap,
  useSchemaIsLoading,
} from '@/store/schema'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { useGraphSchema } from '@/hooks/useGraphSchema'

function App() {
  const { isAuthenticated } = useAuthStore()
  const { theme } = usePreferencesStore()
  const { setNodes, setEdges } = useCanvasStore()
  const { schema } = useSchemaStore()
  const provider = useGraphProvider()
  const containmentEdgeTypes = useContainmentEdgeTypes()
  const rootEntityTypes = useRootEntityTypes()
  const entityTypeHierarchy = useEntityTypeHierarchyMap()
  const isLoadingOntology = useSchemaIsLoading()

  // React Query-backed schema loading (replaces manual mergeBackendSchema pattern)
  const { isLoading: isLoadingBackendSchema } = useGraphSchema()

  // Track which (provider, entity-type signature) combo we've already loaded for.
  // Tracking provider alone is not enough: when the workspace changes, the schema
  // store still holds the OLD workspace's entity types during the render where
  // hasLoadedBackendSchema first becomes true (loadFromBackend runs in the same
  // effects batch but its zustand update isn't visible until the next render).
  // By including the entity-type signature we allow a re-fetch when the correct
  // types arrive in the following render, without opening an infinite-loop risk.
  const graphLoadedForRef = useRef<{ provider: typeof provider; typesSig: string } | null>(null)

  const hasLoadedBackendSchema = !isLoadingBackendSchema

  // Initialize graph data on mount (after schema is loaded)
  // Re-runs when provider changes (workspace switch) or when entity types change
  // (new workspace schema arrived) — guards prevent unnecessary repeated fetches.
  useEffect(() => {
    // Wait until the schema has loaded so we have ontology-defined root types,
    // containment edges, and hierarchy. Never guess with hardcoded type names.
    if (!isAuthenticated) return
    if (isLoadingOntology || !hasLoadedBackendSchema) return
    if (rootEntityTypes.length === 0) return

    // Skip if we already loaded for this exact provider + entity-type combination
    const typesSig = rootEntityTypes.join(',')
    if (graphLoadedForRef.current?.provider === provider &&
        graphLoadedForRef.current?.typesSig === typesSig) return
    graphLoadedForRef.current = { provider, typesSig }

    if (containmentEdgeTypes.length > 0) {
      console.log('[App] Using containment edge types from backend:', containmentEdgeTypes)
    }

    const fetchInitialGraph = async () => {
      try {
        const rootTypes = rootEntityTypes

        // Child types from ontology hierarchy
        const childTypes = new Set<string>()
        for (const rootType of rootTypes) {
          const hierarchy = entityTypeHierarchy[rootType]
          hierarchy?.canContain?.forEach((t: string) => childTypes.add(t))
        }

        console.log('[App] Fetching initial graph for root types:', rootTypes, 'child types:', [...childTypes])

        // Step 1: Fetch root nodes
        const rootNodes = await provider.getNodes({
          entityTypes: rootTypes as any[],
          limit: 200
        })

        // Step 2: Fetch first-level children for all roots (parallel)
        const childrenPromises = rootNodes.map(root =>
          provider.getChildren(root.urn, { limit: 100 })
        )
        const childrenResults = await Promise.all(childrenPromises)
        const allChildren = childrenResults.flat()

        // Step 3: Fetch orphaned nodes of child types (e.g. dataPlatforms without a domain parent).
        // These won't be found by getChildren since they have no parent in our root set.
        let orphanNodes: typeof rootNodes = []
        if (childTypes.size > 0) {
          const childTypeNodes = await provider.getNodes({
            entityTypes: [...childTypes] as any[],
            limit: 200
          })
          // Filter out nodes we already have from children
          const knownUrns = new Set([
            ...rootNodes.map(n => n.urn),
            ...allChildren.map(n => n.urn)
          ])
          orphanNodes = childTypeNodes.filter(n => !knownUrns.has(n.urn))
        }

        // Combine all discovered nodes
        const nodeMap = new Map<string, typeof rootNodes[0]>()
        for (const n of [...rootNodes, ...allChildren, ...orphanNodes]) {
          nodeMap.set(n.urn, n)
        }
        const uniqueNodes = Array.from(nodeMap.values())

        if (uniqueNodes.length === 0) {
          console.log('[App] No nodes found.')
          return
        }

        // Step 4: Fetch edges between loaded nodes only.
        // We fetch outgoing edges from all loaded URNs, then filter to only keep
        // edges where BOTH source AND target are in our loaded set. This avoids
        // pulling thousands of containment edges to unloaded descendants.
        const urnSet = new Set(uniqueNodes.map(n => n.urn))
        const outgoingEdges = await provider.getEdges({ sourceUrns: [...urnSet], limit: 2000 })

        // Keep only edges whose target is also a loaded node
        const uniqueEdges = outgoingEdges.filter(e => urnSet.has(e.targetUrn))

        console.log(`[App] Loaded ${uniqueNodes.length} nodes (${rootNodes.length} roots, ${allChildren.length} children, ${orphanNodes.length} orphans), ${uniqueEdges.length} edges`)

        // Use the entity type id directly as the React Flow node type.
        // GenericNode handles all types via the ontology schema — no hardcoded mapping.
        setNodes(uniqueNodes.map(n => ({
          id: n.urn,
          type: 'generic',
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
  }, [isAuthenticated, hasLoadedBackendSchema, isLoadingOntology, rootEntityTypes, entityTypeHierarchy, provider, containmentEdgeTypes, setNodes, setEdges, schema])

  // Apply theme class to document
  useEffect(() => {
    const root = document.documentElement

    if (theme === 'system') {
      const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      root.classList.toggle('dark', systemDark)

      // Listen for system theme changes
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      const handler = (e: MediaQueryListEvent) => {
        root.classList.toggle('dark', e.matches)
      }
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
      <AppShell />
    </ReactFlowProvider>
  )
}

export default App

