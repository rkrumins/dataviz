import { useState, createContext, useContext } from 'react'
import { TopBar } from './TopBar'
import { SidebarNav } from './SidebarNav'
import { CommandPalette } from './CommandPalette'
import { CanvasRouter } from '@/components/canvas/CanvasRouter'
import { DetailPanel } from '@/components/panels/DetailPanel'
import { ViewEditor } from '@/components/views/ViewEditor'
import { usePreferencesStore } from '@/store/preferences'
import { useCanvasStore } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import type { ViewConfiguration } from '@/types/schema'
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
    throw new Error('useViewEditorModal must be used within AppShell')
  }
  return context
}

export function AppShell() {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [viewEditorOpen, setViewEditorOpen] = useState(false)
  const [editingViewId, setEditingViewId] = useState<string | undefined>()
  
  const { sidebarCollapsed } = usePreferencesStore()
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds)
  const addOrUpdateView = useSchemaStore((s) => s.addOrUpdateView)
  
  const showDetailPanel = selectedNodeIds.length === 1
  
  // View editor handlers
  const openViewEditor = (viewId?: string) => {
    setEditingViewId(viewId)
    setViewEditorOpen(true)
  }
  
  const closeViewEditor = () => {
    setViewEditorOpen(false)
    setEditingViewId(undefined)
  }
  
  const handleSaveView = (view: ViewConfiguration) => {
    addOrUpdateView(view)
    closeViewEditor()
  }

  return (
    <ViewEditorContext.Provider value={{ openViewEditor, closeViewEditor }}>
      <div className="h-screen w-screen flex flex-col overflow-hidden bg-canvas">
        {/* Top Bar */}
        <TopBar onOpenCommandPalette={() => setCommandPaletteOpen(true)} />
        
        {/* Main Content Area */}
        <div className="flex-1 flex overflow-hidden">
          {/* Sidebar */}
          <SidebarNav />
          
          {/* Canvas Area - switches between Graph/Hierarchy based on view */}
          <main 
            className={cn(
              "flex-1 relative overflow-hidden transition-all duration-300",
              sidebarCollapsed ? "ml-16" : "ml-64"
            )}
          >
            <CanvasRouter />
            
            {/* Loading Overlay */}
            <LoadingOverlay />
          </main>
          
          {/* Detail Panel (slides in from right) */}
          <DetailPanel 
            isOpen={showDetailPanel} 
            nodeId={selectedNodeIds[0]} 
          />
        </div>
        
        {/* Command Palette (modal) */}
        <CommandPalette 
          open={commandPaletteOpen} 
          onOpenChange={setCommandPaletteOpen} 
        />
        
        {/* View Editor (modal) - rendered at root for proper stacking */}
        {viewEditorOpen && (
          <ViewEditor
            viewId={editingViewId}
            onClose={closeViewEditor}
            onSave={handleSaveView}
          />
        )}
      </div>
    </ViewEditorContext.Provider>
  )
}

function LoadingOverlay() {
  const isLoading = useCanvasStore((s) => s.isLoading)
  
  if (!isLoading) return null
  
  return (
    <div className="absolute bottom-4 left-4 glass-panel-subtle rounded-lg px-3 py-2 flex items-center gap-2 animate-fade-in">
      <div className="w-4 h-4 border-2 border-accent-lineage border-t-transparent rounded-full animate-spin" />
      <span className="text-sm text-ink-secondary">Loading lineage...</span>
    </div>
  )
}

