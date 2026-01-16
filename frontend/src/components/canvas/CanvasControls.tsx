import { Panel, useReactFlow } from '@xyflow/react'
import { 
  ZoomIn, 
  ZoomOut, 
  Maximize2, 
  Grid3X3,
  Map,
  Magnet
} from 'lucide-react'
import { usePreferencesStore } from '@/store/preferences'
import { usePersonaStore } from '@/store/persona'
import { cn } from '@/lib/utils'

export function CanvasControls() {
  const { fitView, zoomIn, zoomOut } = useReactFlow()
  const { showGrid, showMinimap, snapToGrid, toggleGrid, toggleMinimap, toggleSnapToGrid } = usePreferencesStore()
  const mode = usePersonaStore((s) => s.mode)

  return (
    <Panel position="top-right" className="flex flex-col gap-2">
      {/* LOD Indicator */}
      <div className="glass-panel-subtle rounded-lg px-3 py-2">
        <div className="flex items-center gap-2">
          <div className={cn(
            "w-2 h-2 rounded-full",
            mode === 'business' ? "bg-accent-business" : "bg-accent-technical"
          )} />
          <span className="text-xs font-medium text-ink-secondary">
            {mode === 'business' ? 'Business View' : 'Technical View'}
          </span>
        </div>
        <div className="flex items-center gap-1 mt-1.5">
          <LODButton label="Domains" level="domain" active={mode === 'business'} />
          <LODButton label="Apps" level="app" active={true} />
          <LODButton label="Assets" level="asset" active={mode === 'technical'} />
        </div>
      </div>

      {/* Canvas Options */}
      <div className="glass-panel-subtle rounded-lg p-1 flex flex-col gap-0.5">
        <ControlButton
          icon={Grid3X3}
          label="Toggle Grid"
          active={showGrid}
          onClick={toggleGrid}
        />
        <ControlButton
          icon={Map}
          label="Toggle Minimap"
          active={showMinimap}
          onClick={toggleMinimap}
        />
        <ControlButton
          icon={Magnet}
          label="Snap to Grid"
          active={snapToGrid}
          onClick={toggleSnapToGrid}
        />
        <div className="h-px bg-glass-border my-1" />
        <ControlButton
          icon={ZoomIn}
          label="Zoom In"
          onClick={() => zoomIn()}
        />
        <ControlButton
          icon={ZoomOut}
          label="Zoom Out"
          onClick={() => zoomOut()}
        />
        <ControlButton
          icon={Maximize2}
          label="Fit View"
          onClick={() => fitView({ padding: 0.2 })}
        />
      </div>
    </Panel>
  )
}

interface ControlButtonProps {
  icon: React.ComponentType<{ className?: string }>
  label: string
  active?: boolean
  onClick: () => void
}

function ControlButton({ icon: Icon, label, active, onClick }: ControlButtonProps) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={cn(
        "w-8 h-8 rounded-lg flex items-center justify-center",
        "transition-all duration-150",
        active
          ? "bg-accent-lineage/20 text-accent-lineage"
          : "text-ink-secondary hover:bg-black/5 dark:hover:bg-white/10 hover:text-ink"
      )}
    >
      <Icon className="w-4 h-4" />
    </button>
  )
}

interface LODButtonProps {
  label: string
  level: 'domain' | 'app' | 'asset'
  active: boolean
}

function LODButton({ label, level, active }: LODButtonProps) {
  const colors = {
    domain: 'bg-purple-500',
    app: 'bg-cyan-500',
    asset: 'bg-green-500',
  }

  return (
    <button
      className={cn(
        "px-2 py-1 rounded text-2xs font-medium transition-all",
        active
          ? `${colors[level]} text-white`
          : "bg-black/5 dark:bg-white/5 text-ink-muted hover:text-ink-secondary"
      )}
    >
      {label}
    </button>
  )
}

