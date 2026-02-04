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

    // Initialize backend data
    // Always fetch to ensure we get the latest data from backend, especially during dev/testing
    const fetchInitialGraph = async () => {
      try {
        // Fetch initial nodes (Root Domains or Platforms)
        // Hierarchical loading: Start with high-level containers
        const initialNodes = await provider.getNodes({
          entityTypes: ['domain'],
          limit: 100
        })

        if (initialNodes.length === 0) return

        const urns = initialNodes.map(n => n.urn)
        
        // Fetch edges for these nodes - both incoming and outgoing
        // Also fetch ALL containment edges (not just those connected to initial nodes)
        // This ensures we get the full hierarchy even if parent nodes aren't in initial set
        const [outgoingEdges, incomingEdges, allContainmentEdges] = await Promise.all([
          provider.getEdges({
            sourceUrns: urns,
            limit: 1000
          }),
          provider.getEdges({
            targetUrns: urns,
            limit: 1000
          }),
          // Fetch ALL containment edges using backend-provided types
          // Don't filter by URNs - we want the full hierarchy
          effectiveContainmentTypes.length > 0 ? provider.getEdges({
            edgeTypes: effectiveContainmentTypes as any,
            limit: 5000  // Higher limit to get all containment edges
          }) : Promise.resolve([])
        ])
        
        // Also get nodes referenced by containment edges that we don't have yet
        const containmentNodeUrns = new Set<string>()
        allContainmentEdges.forEach(e => {
          containmentNodeUrns.add(e.sourceUrn)
          containmentNodeUrns.add(e.targetUrn)
        })
        const missingUrns = Array.from(containmentNodeUrns).filter(urn => !urns.includes(urn))
        const additionalNodes = missingUrns.length > 0 
          ? await provider.getNodes({ urns: missingUrns, limit: 1000 })
          : []

        // Combine all nodes
        const allNodes = [...initialNodes, ...additionalNodes]
        const nodeMap = new Map(allNodes.map(n => [n.urn, n]))
        const uniqueNodes = Array.from(nodeMap.values())

        // Combine all edges and deduplicate
        const allEdges = [...outgoingEdges, ...incomingEdges, ...allContainmentEdges]
        const edgeMap = new Map<string, typeof allEdges[0]>()
        allEdges.forEach(e => edgeMap.set(e.id, e))
        const uniqueEdges = Array.from(edgeMap.values())

        console.log(`[App] Loaded ${uniqueNodes.length} nodes (${initialNodes.length} initial + ${additionalNodes.length} from containment) and ${uniqueEdges.length} edges from backend`)
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
          type: (n.entityType === 'dataPlatform' || n.entityType === 'system' as any) ? 'system' :
            (n.entityType === 'dataset' || n.entityType === 'schemaField') ? 'dataset' : 'domain',
          position: { x: Math.random() * 800, y: Math.random() * 600 },
          data: {
            label: n.displayName,
            type: n.entityType as any,
            metadata: n.properties,
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

