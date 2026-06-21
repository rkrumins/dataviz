/**
 * ViewControls — the always-visible visibility cluster: the Lineage mesh toggle
 * plus the consolidated "View" settings menu (lineage rendering + canvas
 * display). Rendered in BOTH Explore and Edit modes so users can adjust what's
 * visible on the canvas without leaving whatever they're doing.
 */

import { motion } from 'framer-motion'
import { GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CanvasDensity, LineageRenderMode } from '@/store/preferences'
import { ViewControlsMenu } from './ViewControlsMenu'

export interface ViewControlsProps {
  showLineageFlow: boolean
  onToggleLineageFlow: () => void
  showEdgeDirection: boolean
  onToggleEdgeDirection: () => void
  lineageRenderMode: LineageRenderMode
  onSetLineageRenderMode: (mode: LineageRenderMode) => void
  canvasZoom: number
  onSetCanvasZoom: (n: number) => void
  canvasDensity: CanvasDensity
  onSetCanvasDensity: (density: CanvasDensity) => void
  showCanvasTypeBadge: boolean
  onToggleCanvasTypeBadge: () => void
  subtleCanvasTreeLines: boolean
  onToggleSubtleCanvasTreeLines: () => void
  onResetCanvasDisplaySettings: () => void
}

export function ViewControls({
  showLineageFlow,
  onToggleLineageFlow,
  showEdgeDirection,
  onToggleEdgeDirection,
  lineageRenderMode,
  onSetLineageRenderMode,
  canvasZoom,
  onSetCanvasZoom,
  canvasDensity,
  onSetCanvasDensity,
  showCanvasTypeBadge,
  onToggleCanvasTypeBadge,
  subtleCanvasTreeLines,
  onToggleSubtleCanvasTreeLines,
  onResetCanvasDisplaySettings,
}: ViewControlsProps) {
  return (
    <div className="flex items-center gap-3">
      {/* Lineage Flow Toggle */}
      <button
        onClick={onToggleLineageFlow}
        title={showLineageFlow ? 'Hide the lineage mesh on the canvas' : 'Show the lineage mesh on the canvas'}
        className={cn(
          'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all duration-300',
          showLineageFlow
            ? 'bg-gradient-to-r from-accent-lineage/15 to-accent-lineage/[0.08] text-accent-lineage shadow-sm shadow-accent-lineage/10 border border-accent-lineage/35 dark:from-accent-lineage/20 dark:to-accent-lineage/10 dark:shadow-lg dark:shadow-accent-lineage/20 dark:border-accent-lineage/30'
            : 'bg-black/[0.04] border border-black/[0.10] text-ink-muted hover:bg-black/[0.08] hover:text-ink dark:bg-white/[0.04] dark:border-white/[0.08] dark:hover:bg-white/[0.08]',
        )}
      >
        <motion.div animate={{ rotate: showLineageFlow ? 0 : -180 }} transition={{ duration: 0.3 }}>
          <GitBranch className="w-4 h-4" />
        </motion.div>
        <span>Lineage</span>
        <div className={cn(
          'w-2 h-2 rounded-full transition-colors duration-300',
          showLineageFlow ? 'bg-green-500 dark:bg-green-400 dark:shadow-lg dark:shadow-green-400/50' : 'bg-ink-muted/30',
        )} />
      </button>

      {/* Consolidated View settings (lineage rendering + canvas display) */}
      <ViewControlsMenu
        showLineageFlow={showLineageFlow}
        lineageRenderMode={lineageRenderMode}
        onSetLineageRenderMode={onSetLineageRenderMode}
        showEdgeDirection={showEdgeDirection}
        onToggleEdgeDirection={onToggleEdgeDirection}
        canvasZoom={canvasZoom}
        onSetCanvasZoom={onSetCanvasZoom}
        canvasDensity={canvasDensity}
        onSetCanvasDensity={onSetCanvasDensity}
        showCanvasTypeBadge={showCanvasTypeBadge}
        onToggleCanvasTypeBadge={onToggleCanvasTypeBadge}
        subtleCanvasTreeLines={subtleCanvasTreeLines}
        onToggleSubtleCanvasTreeLines={onToggleSubtleCanvasTreeLines}
        onResetCanvasDisplaySettings={onResetCanvasDisplaySettings}
      />
    </div>
  )
}
