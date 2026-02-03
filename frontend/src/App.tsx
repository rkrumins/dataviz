import { useEffect } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { AppShell } from '@/components/layout/AppShell'
import { LoginPage } from '@/components/auth/LoginPage'
import { useAuthStore } from '@/store/auth'
import { usePreferencesStore } from '@/store/preferences'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { defaultWorkspaceSchema } from '@/lib/default-schema'

function App() {
  const { isAuthenticated } = useAuthStore()
  const { theme } = usePreferencesStore()
  const { setNodes, setEdges, setActiveLens } = useCanvasStore()
  const { loadSchema, schema } = useSchemaStore()
  const provider = useGraphProvider()

  // Initialize schema and demo data on mount
  useEffect(() => {
    // Only initialize if authenticated
    if (!isAuthenticated) return

    // Load/refresh schema - check version to handle updates
    const currentVersion = schema?.version
    const defaultVersion = defaultWorkspaceSchema.version

    if (!schema || currentVersion !== defaultVersion) {
      // Force refresh schema when version changes or not loaded
      loadSchema(defaultWorkspaceSchema)
    }

    // Initialize backend data
    const currentNodes = useCanvasStore.getState().nodes
    if (currentNodes.length === 0) {
      const fetchInitialGraph = async () => {
        try {
          // Fetch initial nodes
          const initialNodes = await provider.getNodes({ limit: 100 })

          // Fetch edges for these nodes
          const urns = initialNodes.map(n => n.urn)
          const edges = await provider.getEdges({
            sourceUrns: urns,
            limit: 500
          })

          if (initialNodes.length > 0) {
            console.log(`Loaded ${initialNodes.length} nodes and ${edges.length} edges from backend`)
            setNodes(initialNodes.map(n => ({
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

            setEdges(edges.map(e => ({
              id: e.id,
              source: e.sourceUrn,
              target: e.targetUrn,
              type: 'lineage',
              data: {
                edgeType: e.edgeType,
                ...e.properties
              }
            })))
          }
        } catch (err) {
          console.error("Failed to load initial backend data", err)
        }
      }

      fetchInitialGraph()
    }
  }, [setNodes, setEdges, setActiveLens, loadSchema, schema, isAuthenticated, provider])

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

