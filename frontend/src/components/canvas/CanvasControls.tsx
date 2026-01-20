/**
 * CanvasControls - Right-side panel with canvas controls
 * 
 * Provides:
 * - View mode indicator (Business/Technical)
 * - LOD quick filters (Domains, Apps, Assets)
 * - Canvas options (Grid, Minimap, Snap)
 * - Zoom controls
 */

import { useState } from 'react'
import { Panel, useReactFlow } from '@xyflow/react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Grid3X3,
  Map,
  Magnet,
  Layers,
  ChevronDown,
  ChevronUp,
  MousePointer2,
} from 'lucide-react'
import { usePreferencesStore } from '@/store/preferences'
import { usePersonaStore } from '@/store/persona'
import { cn } from '@/lib/utils'

export function CanvasControls() {
  const { fitView, zoomIn, zoomOut, getZoom } = useReactFlow()
  const { showGrid, showMinimap, snapToGrid, toggleGrid, toggleMinimap, toggleSnapToGrid } = usePreferencesStore()
  const mode = usePersonaStore((s) => s.mode)
  const [isExpanded, setIsExpanded] = useState(true)

  return (
    <Panel position="top-right" className="flex flex-col gap-2">
      {/* View Mode Indicator */}
      <div className="glass-panel-subtle rounded-xl px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div className={cn(
            "w-2.5 h-2.5 rounded-full ring-2 ring-offset-1 ring-offset-canvas",
            mode === 'business'
              ? "bg-accent-business ring-accent-business/30"
              : "bg-accent-technical ring-accent-technical/30"
          )} />
          <span className="text-xs font-semibold text-ink">
            {mode === 'business' ? 'Business View' : 'Technical View'}
          </span>
        </div>

        {/* LOD Quick Filters */}
        <div className="flex items-center gap-1 mt-2">
          <LODButton label="Domains" level="domain" active={mode === 'business'} />
          <LODButton label="Apps" level="app" active={true} />
          <LODButton label="Assets" level="asset" active={mode === 'technical'} />
        </div>
      </div>

      {/* Canvas Controls - Collapsible */}
      <div className="glass-panel-subtle rounded-xl overflow-hidden">
        {/* Header */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full flex items-center justify-between px-3 py-2 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
        >
          <span className="text-xs font-medium text-ink-secondary">Canvas Controls</span>
          {isExpanded ? (
            <ChevronUp className="w-3.5 h-3.5 text-ink-muted" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-ink-muted" />
          )}
        </button>

        <AnimatePresence>
          {isExpanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="overflow-hidden"
            >
              <div className="px-2 pb-2 space-y-1">
                {/* Display Options */}
                <div className="px-1 py-1">
                  <span className="text-2xs font-medium text-ink-muted uppercase tracking-wider">Display</span>
                </div>

                <ControlButton
                  icon={Grid3X3}
                  label="Grid"
                  description="Show dot grid"
                  active={showGrid}
                  onClick={toggleGrid}
                />
                <ControlButton
                  icon={Map}
                  label="Minimap"
                  description="Overview map"
                  active={showMinimap}
                  onClick={toggleMinimap}
                />
                <ControlButton
                  icon={Magnet}
                  label="Snap"
                  description="Snap to grid"
                  active={snapToGrid}
                  onClick={toggleSnapToGrid}
                />

                {/* Zoom Controls */}
                <div className="h-px bg-glass-border my-2" />
                <div className="px-1 py-1">
                  <span className="text-2xs font-medium text-ink-muted uppercase tracking-wider">Zoom</span>
                </div>

                <div className="flex items-center gap-1">
                  <ZoomButton
                    icon={ZoomOut}
                    label="Zoom out"
                    onClick={() => zoomOut()}
                  />
                  <ZoomButton
                    icon={ZoomIn}
                    label="Zoom in"
                    onClick={() => zoomIn()}
                  />
                  <ZoomButton
                    icon={Maximize2}
                    label="Fit to view"
                    onClick={() => fitView({ padding: 0.2 })}
                  />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Quick Help Tip */}
      <div className="glass-panel-subtle rounded-xl px-3 py-2 max-w-[200px]">
        <div className="flex items-start gap-2">
          <MousePointer2 className="w-3.5 h-3.5 text-accent-lineage mt-0.5 flex-shrink-0" />
          <div className="text-2xs text-ink-muted leading-relaxed">
            <span className="text-ink-secondary font-medium">Tip:</span> Double-click a node to focus and trace its lineage
          </div>
        </div>
      </div>
    </Panel>
  )
}

interface ControlButtonProps {
  icon: React.ComponentType<{ className?: string }>
  label: string
  description?: string
  active?: boolean
  onClick: () => void
}

function ControlButton({ icon: Icon, label, description, active, onClick }: ControlButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg",
        "transition-all duration-150 text-left",
        active
          ? "bg-accent-lineage/10 text-accent-lineage"
          : "text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink"
      )}
    >
      <div className={cn(
        "w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0",
        active
          ? "bg-accent-lineage/20"
          : "bg-black/5 dark:bg-white/5"
      )}>
        <Icon className="w-3.5 h-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium">{label}</div>
        {description && (
          <div className="text-2xs text-ink-muted truncate">{description}</div>
        )}
      </div>
      {active !== undefined && (
        <div className={cn(
          "w-2 h-2 rounded-full flex-shrink-0",
          active ? "bg-accent-lineage" : "bg-black/10 dark:bg-white/10"
        )} />
      )}
    </button>
  )
}

interface ZoomButtonProps {
  icon: React.ComponentType<{ className?: string }>
  label: string
  onClick: () => void
}

function ZoomButton({ icon: Icon, label, onClick }: ZoomButtonProps) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={cn(
        "flex-1 flex items-center justify-center gap-1.5 px-2 py-2 rounded-lg",
        "bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10",
        "text-ink-secondary hover:text-ink transition-all"
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
    domain: { bg: 'bg-purple-500', ring: 'ring-purple-500/30' },
    app: { bg: 'bg-cyan-500', ring: 'ring-cyan-500/30' },
    asset: { bg: 'bg-green-500', ring: 'ring-green-500/30' },
  }

  return (
    <button
      className={cn(
        "flex-1 px-2 py-1.5 rounded-lg text-2xs font-medium transition-all",
        active
          ? `${colors[level].bg} text-white shadow-sm`
          : "bg-black/5 dark:bg-white/5 text-ink-muted hover:text-ink-secondary hover:bg-black/10 dark:hover:bg-white/10"
      )}
    >
      {label}
    </button>
  )
}
