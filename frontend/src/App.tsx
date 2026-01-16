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
    // Load default schema if not already loaded
    if (!schema) {
      loadSchema(defaultWorkspaceSchema)
    }
    
    // Initialize demo data
    initializeDemoData(setNodes, setEdges, setActiveLens)
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

