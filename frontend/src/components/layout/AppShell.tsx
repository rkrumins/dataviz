import { useState } from 'react'
import { TopBar } from './TopBar'
import { SidebarNav } from './SidebarNav'
import { CommandPalette } from './CommandPalette'
import { LineageCanvas } from '@/components/canvas/LineageCanvas'
import { DetailPanel } from '@/components/panels/DetailPanel'
import { usePreferencesStore } from '@/store/preferences'
import { useCanvasStore } from '@/store/canvas'
import { cn } from '@/lib/utils'

export function AppShell() {
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const { sidebarCollapsed } = usePreferencesStore()
  const selectedNodeIds = useCanvasStore((s) => s.selectedNodeIds)
  
  const showDetailPanel = selectedNodeIds.length === 1

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-canvas">
      {/* Top Bar */}
      <TopBar onOpenCommandPalette={() => setCommandPaletteOpen(true)} />
      
      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar */}
        <SidebarNav />
        
        {/* Canvas Area */}
        <main 
          className={cn(
            "flex-1 relative overflow-hidden transition-all duration-300",
            sidebarCollapsed ? "ml-16" : "ml-64"
          )}
        >
          <LineageCanvas />
          
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
    </div>
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

