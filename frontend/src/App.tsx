import { useEffect, useMemo, useState, useCallback } from 'react'
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
  const { loadSchema, schema, mergeBackendSchema, loadFromBackend } = useSchemaStore()
  const provider = useGraphProvider()
  const { containmentEdgeTypes, isLoading: isLoadingOntology, metadata: ontologyMetadata } = useOntologyMetadata()
  
  // Track if we've attempted to load schema from backend
  const [hasLoadedBackendSchema, setHasLoadedBackendSchema] = useState(false)
  const [isLoadingBackendSchema, setIsLoadingBackendSchema] = useState(false)

  // Use defaults if no containment types available - memoize to prevent recreation
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
        console.log('[App] Loading schema from backend...')
        const backendSchema = await provider.getFullSchema()
        
        if (backendSchema && backendSchema.entityTypes.length > 0) {
          console.log('[App] Backend schema loaded:', {
            entityTypes: backendSchema.entityTypes.length,
            relationshipTypes: backendSchema.relationshipTypes.length,
            rootTypes: backendSchema.rootEntityTypes,
          })
          
          // Merge backend schema with any existing local customizations
          if (schema) {
            mergeBackendSchema(backendSchema)
            console.log('[App] Merged backend schema with existing schema')
          } else {
            loadFromBackend(backendSchema)
            console.log('[App] Loaded fresh schema from backend')
          }
        } else {
          console.warn('[App] Backend returned empty schema, using defaults')
          if (!schema) {
            loadSchema(defaultWorkspaceSchema)
          }
        }
      } catch (err) {
        console.warn('[App] Failed to load schema from backend, using defaults:', err)
        // Fall back to default schema
        if (!schema) {
          loadSchema(defaultWorkspaceSchema)
        }
      } finally {
        setHasLoadedBackendSchema(true)
        setIsLoadingBackendSchema(false)
      }
    }
    
    loadBackendSchema()
  }, [isAuthenticated, hasLoadedBackendSchema, isLoadingBackendSchema, provider, schema, mergeBackendSchema, loadFromBackend, loadSchema])

  // Initialize graph data on mount (after schema is loaded)
  useEffect(() => {
    // Only initialize if authenticated and schema loading is complete
    if (!isAuthenticated) return
    if (!hasLoadedBackendSchema && !schema) return // Wait for schema

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

    // If schema still not loaded (edge case), load defaults
    if (!schema) {
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
          type: n.entityType === 'schemaField' ? 'column' :
            n.entityType === 'column' ? 'column' : // Handle legacy/mismatched types
              (n.entityType === 'dataPlatform' || n.entityType === 'system' as any) ? 'system' :
                (n.entityType === 'dataset' || n.entityType === 'table' as any) ? 'dataset' :
                  (n.entityType === 'container') ? 'container' : 'domain',
          position: { x: Math.random() * 800, y: Math.random() * 600 },
          data: {
            label: n.displayName,
            type: n.entityType as any,
            metadata: n.properties,
            childCount: n.childCount,
            // Ensure compatibility with HierarchyCanvas
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
            relationship: e.edgeType, // Also set relationship for compatibility
            ...e.properties
          }
        })))
      } catch (err) {
        console.error("Failed to load initial backend data", err)
      }
    }

    fetchInitialGraph()
  }, [isAuthenticated, hasLoadedBackendSchema, isLoadingOntology, ontologyMetadata, provider, effectiveContainmentTypes.join(','), setNodes, setEdges, setActiveLens, loadSchema, schema])
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

