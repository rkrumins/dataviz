import { useEffect } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { AppShell } from '@/components/layout/AppShell'
import { usePreferencesStore } from '@/store/preferences'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { initializeDemoData } from '@/lib/demo-data'
import { defaultWorkspaceSchema } from '@/lib/default-schema'

function App() {
  const { theme } = usePreferencesStore()
  const { setNodes, setEdges, setActiveLens } = useCanvasStore()
  const { loadSchema, schema } = useSchemaStore()

  // Initialize schema and demo data on mount
  useEffect(() => {
    // Load/refresh schema - check version to handle updates
    const currentVersion = schema?.version
    const defaultVersion = defaultWorkspaceSchema.version

    if (!schema || currentVersion !== defaultVersion) {
      // Force refresh schema when version changes or not loaded
      loadSchema(defaultWorkspaceSchema)
    }

    // Initialize demo data with generator (5 domains, 10 apps each, 5-15 assets per app, 10-100 columns per asset)
    initializeDemoData(setNodes, setEdges, setActiveLens, true, {
      domainCount: 2,
      appsPerDomain: 3,
      assetsPerApp: { min: 3, max: 5 },
      columnsPerAsset: { min: 5, max: 20 },
      includeDashboards: true,
      includeGhostNodes: true,
    })
  }, [setNodes, setEdges, setActiveLens, loadSchema, schema])

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

  return (
    <ReactFlowProvider>
      <AppShell />
    </ReactFlowProvider>
  )
}

export default App

