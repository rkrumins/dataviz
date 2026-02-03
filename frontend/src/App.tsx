import { useEffect, useMemo } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { AppShell } from '@/components/layout/AppShell'
import { LoginPage } from '@/components/auth/LoginPage'
import { useAuthStore } from '@/store/auth'
import { usePreferencesStore } from '@/store/preferences'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { defaultWorkspaceSchema } from '@/lib/default-schema'
import { useOntologyMetadata, getCachedOntologyMetadata } from '@/services/ontologyService'

function App() {
  const { isAuthenticated } = useAuthStore()
  const { theme } = usePreferencesStore()
  const { setNodes, setEdges, setActiveLens } = useCanvasStore()
  const { loadSchema, schema } = useSchemaStore()
  const provider = useGraphProvider()
  const { containmentEdgeTypes, isLoading: isLoadingOntology, metadata: ontologyMetadata } = useOntologyMetadata()

  // Use defaults if no containment types available - memoize to prevent recreation
  const effectiveContainmentTypes = useMemo(() =>
    containmentEdgeTypes.length > 0
      ? containmentEdgeTypes
      : ['CONTAINS', 'BELONGS_TO'],
    [containmentEdgeTypes]
  )

  // Initialize schema and demo data on mount
  useEffect(() => {
    // Only initialize if authenticated
    if (!isAuthenticated) return

    // Wait for ontology metadata to finish loading (either success or error)
    // If still loading and no cached metadata, wait
    const cachedMeta = getCachedOntologyMetadata()
    if (isLoadingOntology && !ontologyMetadata && !cachedMeta) {
      console.log('[App] Waiting for ontology metadata to load...')
      return
    }

    // Log what we're using
    if (containmentEdgeTypes.length > 0) {
      console.log('[App] Using containment edge types from backend:', containmentEdgeTypes)
    } else {
      console.warn('[App] No containment edge types from backend, using defaults:', effectiveContainmentTypes)
    }

    // Load/refresh schema - check version to handle updates
    const currentVersion = schema?.version
    const defaultVersion = defaultWorkspaceSchema.version

    if (!schema || currentVersion !== defaultVersion) {
      // Force refresh schema when version changes or not loaded
      loadSchema(defaultWorkspaceSchema)
    }

    // DEBUG: Diagnose Schema Loading
    console.log('--- SCHEMA DEBUG ---')
    console.log('Current Schema Version:', schema?.version)
    console.log('Default Schema Version:', defaultWorkspaceSchema.version)
    console.log('Registered Entity Types:', schema?.entityTypes.map(t => t.id))
    console.log('Has dataPlatform?', schema?.entityTypes.some(t => t.id === 'dataPlatform'))
    console.log('Has container?', schema?.entityTypes.some(t => t.id === 'container'))

    if (schema?.version !== defaultWorkspaceSchema.version) {
      console.warn('MISMATCH DETECTED: Triggering loadSchema...')
      // Force reload if not matching (redundant to main effect but good for debug)
      loadSchema(defaultWorkspaceSchema)
    }

    // Initialize backend data
    // Always fetch to ensure we get the latest data from backend, especially during dev/testing
    const fetchInitialGraph = async () => {
      try {
        // Fetch initial nodes based on Ontology Roots
        // Hierarchical loading: Start with high-level containers defined by ontology
        const rootTypes = ontologyMetadata?.rootEntityTypes?.length && ontologyMetadata.rootEntityTypes.length > 0
          ? ontologyMetadata.rootEntityTypes
          : ['domain', 'dataPlatform', 'system'] // Safe defaults

        console.log('[App] Fetching initial graph for root types:', rootTypes)

        // 1. Fetch Root Nodes
        const initialNodes = await provider.getNodes({
          entityTypes: rootTypes as any[],
          limit: 100 // Reasonable limit for top-level roots
        })

        if (initialNodes.length === 0) {
          console.log('[App] No root nodes found.')
          return
        }

        const urns = initialNodes.map(n => n.urn)

        // 2. Fetch direct edges for these roots (to show initial connectivity/context)
        // We do NOT fetch the entire containment hierarchy here. That is lazy loaded.
        const [outgoingEdges, incomingEdges] = await Promise.all([
          provider.getEdges({
            sourceUrns: urns,
            limit: 500
          }),
          provider.getEdges({
            targetUrns: urns,
            limit: 500
          })
        ])

        // Combine all nodes
        const allNodes = [...initialNodes]
        const nodeMap = new Map(allNodes.map(n => [n.urn, n]))
        const uniqueNodes = Array.from(nodeMap.values())

        // Combine all edges and deduplicate
        const allEdges = [...outgoingEdges, ...incomingEdges]
        const edgeMap = new Map<string, typeof allEdges[0]>()
        allEdges.forEach(e => edgeMap.set(e.id, e))
        const uniqueEdges = Array.from(edgeMap.values())

        console.log(`[App] Loaded ${uniqueNodes.length} nodes from backend`)
        console.log(`[App] Containment edge types: ${effectiveContainmentTypes.join(', ')}`)

        // Log containment edges specifically
        const containmentCount = uniqueEdges.filter(e => {
          const edgeType = (e.edgeType || '').toUpperCase()
          return effectiveContainmentTypes.some(type => type.toUpperCase() === edgeType)
        }).length
        console.log(`[App] Found ${containmentCount} containment edges out of ${uniqueEdges.length} total edges`)
        console.log(`[App] Containment edges:`, uniqueEdges.filter(e => {
          const edgeType = (e.edgeType || '').toUpperCase()
          return effectiveContainmentTypes.some(type => type.toUpperCase() === edgeType)
        }).map(e => `${e.sourceUrn} -> ${e.targetUrn} (${e.edgeType})`))

        setNodes(uniqueNodes.map(n => ({
          id: n.urn,
          type: n.entityType === 'schemaField' ? 'schemaField' :
            n.entityType === 'column' ? 'column' :
              (n.entityType === 'dataPlatform' || n.entityType === 'system' as any) ? 'system' :
                (n.entityType === 'dataset') ? 'dataset' : 'domain',
          position: { x: Math.random() * 800, y: Math.random() * 600 },
          data: {
            label: n.displayName,
            type: n.entityType as any,
            metadata: n.properties,
            childCount: n.childCount,
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
            relationship: e.edgeType, // Also set relationship for compatibility
            ...e.properties
          }
        })))
      } catch (err) {
        console.error("Failed to load initial backend data", err)
      }
    }

    fetchInitialGraph()
  }, [isAuthenticated, isLoadingOntology, ontologyMetadata, provider, effectiveContainmentTypes.join(','), setNodes, setEdges, setActiveLens, loadSchema, schema])
  // Note: Using effectiveContainmentTypes.join(',') as dependency to avoid array reference issues

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

