import { useEffect, useMemo, useRef } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { AppShell } from '@/components/layout/AppShell'
import { LoginPage } from '@/components/auth/LoginPage'
import { useAuthStore } from '@/store/auth'
import { usePreferencesStore } from '@/store/preferences'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { useOntologyMetadata, getCachedOntologyMetadata } from '@/services/ontologyService'
import { useGraphSchema } from '@/hooks/useGraphSchema'

function App() {
  const { isAuthenticated } = useAuthStore()
  const { theme } = usePreferencesStore()
  const { setNodes, setEdges, setActiveLens } = useCanvasStore()
  const { schema } = useSchemaStore()
  const provider = useGraphProvider()
  const { containmentEdgeTypes, isLoading: isLoadingOntology, metadata: ontologyMetadata } = useOntologyMetadata()

  // React Query-backed schema loading (replaces manual mergeBackendSchema pattern)
  const { isLoading: isLoadingBackendSchema } = useGraphSchema()

  // Track which provider instance we've loaded graph data for (prevents re-fetch cascades)
  const graphLoadedForProviderRef = useRef<typeof provider | null>(null)

  // Use defaults if no containment types available - memoize to prevent recreation
  const effectiveContainmentTypes = useMemo(() =>
    containmentEdgeTypes.length > 0
      ? containmentEdgeTypes
      : ['CONTAINS', 'BELONGS_TO'],
    [containmentEdgeTypes]
  )

  const hasLoadedBackendSchema = !isLoadingBackendSchema

  // Initialize graph data on mount (after schema is loaded)
  // Runs ONCE per provider instance — subsequent dep changes (ontology, schema) do NOT re-fetch.
  useEffect(() => {
    // Only initialize if authenticated and schema loading is complete
    if (!isAuthenticated) return
    if (!hasLoadedBackendSchema && !schema) return // Wait for schema

    // Wait for ontology metadata to finish loading (either success or error)
    const cachedMeta = getCachedOntologyMetadata()
    if (isLoadingOntology && !ontologyMetadata && !cachedMeta) {
      console.log('[App] Waiting for ontology metadata to load...')
      return
    }

    // Only fetch once per provider instance (prevents cascading re-fetches
    // when ontology, schema, or other deps change after initial load)
    if (graphLoadedForProviderRef.current === provider) return
    graphLoadedForProviderRef.current = provider

    // Log what we're using
    if (containmentEdgeTypes.length > 0) {
      console.log('[App] Using containment edge types from backend:', containmentEdgeTypes)
    } else {
      console.warn('[App] No containment edge types from backend, using defaults:', effectiveContainmentTypes)
    }

    // If schema still not loaded (edge case), load defaults
    if (!schema) {
      loadSchema(defaultWorkspaceSchema)
    }

    // Initialize backend data — loads the top 2 levels of the hierarchy
    // so the user immediately sees roots + their direct children.
    const fetchInitialGraph = async () => {
      try {
        const rootTypes = ontologyMetadata?.rootEntityTypes?.length && ontologyMetadata.rootEntityTypes.length > 0
          ? ontologyMetadata.rootEntityTypes
          : ['domain', 'dataPlatform', 'system'] // Safe defaults

        // Also determine child types from ontology hierarchy so we can load
        // orphaned nodes that exist at the top level without a parent.
        const childTypes = new Set<string>()
        if (ontologyMetadata?.entityTypeHierarchy) {
          for (const rootType of rootTypes) {
            const hierarchy = ontologyMetadata.entityTypeHierarchy[rootType]
            if (hierarchy?.canContain) {
              hierarchy.canContain.forEach((t: string) => childTypes.add(t))
            }
          }
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

        const toNodeType = (entityType: string) => {
          switch (entityType) {
            case 'schemaField':
            case 'column':
              return 'column'
            case 'dataPlatform':
            case 'system':
              return 'system'
            case 'dataset':
            case 'table':
              return 'dataset'
            case 'container':
              return 'container'
            default:
              return 'domain'
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

