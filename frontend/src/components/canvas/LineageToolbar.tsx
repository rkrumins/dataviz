/**
 * LineageToolbar - Controls for lineage exploration
 * 
 * Provides:
 * - View name badge
 * - Mode toggle (Overview / Technical Deep Dive)
 * - Granularity selector (Column / Table / Schema / Domain)
 * - Depth controls (Upstream / Downstream)
 * - Include child lineage toggle
 * - Preset buttons (Overview, Impact, Technical)
 */

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Layers,
  Target,
  ArrowUpFromLine,
  ArrowDownFromLine,
  Settings2,
  ChevronDown,
  Minus,
  Plus,
  Columns,
  Table2,
  Database,
  Globe,
  X,
  Sparkles,
  GitBranch,
  Eye,
  EyeOff,
  Network,
} from 'lucide-react'
import { useLineageExploration } from '@/hooks/useLineageExploration'
import { useSchemaStore } from '@/store/schema'
import type { LineageGranularity, LineageExplorationMode } from '@/types/schema'
import { cn } from '@/lib/utils'

interface LineageToolbarProps {
  className?: string
}

export function LineageToolbar({ className }: LineageToolbarProps) {
  const [showSettings, setShowSettings] = useState(false)
  const activeView = useSchemaStore((s) => s.getActiveView())

  const {
    config,
    mode,
    granularity,
    focusEntityId,
    upstreamCount,
    downstreamCount,
    setMode,
    setGranularity,
    setFocus,
    setUpstreamDepth,
    setDownstreamDepth,
    toggleIncludeChildLineage,
    resetToDefault,
  } = useLineageExploration()

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {/* Main Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* View Name Badge */}
        <div className="glass-panel-subtle rounded-lg px-3 py-1.5 flex items-center gap-2 mr-2">
          <Network className="w-4 h-4 text-accent-lineage" />
          <span className="text-sm font-semibold text-ink">{activeView?.name ?? 'Data Lineage'}</span>
          <span className="px-1.5 py-0.5 rounded text-2xs font-medium bg-accent-lineage/10 text-accent-lineage">
            Graph
          </span>
        </div>

        {/* Separator */}
        <div className="w-px h-6 bg-glass-border" />

        {/* Mode Toggle */}
        <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-black/5 dark:bg-white/5">
          <ModeButton
            mode="overview"
            label="Overview"
            icon={<Layers className="w-3.5 h-3.5" />}
            currentMode={mode}
            onClick={() => setMode('overview')}
          />
          <ModeButton
            mode="focused"
            label="Focused"
            icon={<Target className="w-3.5 h-3.5" />}
            currentMode={mode}
            onClick={() => setMode('focused')}
          />
        </div>

        {/* Granularity Selector */}
        <GranularitySelector
          value={granularity}
          onChange={setGranularity}
        />

        {/* Depth Controls - only active in focused mode with a focus entity */}
        <div
          className={cn(
            "flex items-center gap-2 px-2 py-1 rounded-lg bg-black/5 dark:bg-white/5",
            !(mode === 'focused' && focusEntityId) && "opacity-50"
          )}
          title={!(mode === 'focused' && focusEntityId)
            ? "Depth controls only work when tracing a specific entity. Double-click a node to start a trace."
            : "Control how many levels up/down to trace"
          }
        >
          <DepthControl
            icon={<ArrowUpFromLine className="w-3.5 h-3.5" />}
            label="Upstream"
            value={config.trace.upstreamDepth}
            onChange={setUpstreamDepth}
            count={upstreamCount}
            disabled={!(mode === 'focused' && focusEntityId)}
          />

          <div className="w-px h-5 bg-glass-border" />

          <DepthControl
            icon={<ArrowDownFromLine className="w-3.5 h-3.5" />}
            label="Downstream"
            value={config.trace.downstreamDepth}
            onChange={setDownstreamDepth}
            count={downstreamCount}
            disabled={!(mode === 'focused' && focusEntityId)}
          />
        </div>

        {/* Include Child Lineage Toggle */}
        <button
          onClick={toggleIncludeChildLineage}
          className={cn(
            "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all",
            config.trace.includeChildLineage
              ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
              : "bg-black/5 dark:bg-white/5 text-ink-muted hover:text-ink"
          )}
          title={config.trace.includeChildLineage
            ? "Child lineage included (table shows all column lineage)"
            : "Child lineage excluded (only direct edges)"
          }
        >
          <GitBranch className="w-3.5 h-3.5" />
          <span>
            {config.trace.includeChildLineage ? 'Inherited' : 'Direct'}
          </span>
        </button>

        {/* Settings */}
        <button
          onClick={() => setShowSettings(!showSettings)}
          className={cn(
            "p-2 rounded-lg transition-colors",
            showSettings
              ? "bg-accent-lineage/10 text-accent-lineage"
              : "text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5"
          )}
          title="Exploration Settings"
        >
          <Settings2 className="w-4 h-4" />
        </button>

        {/* Focus indicator */}
        {focusEntityId && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">
            <Target className="w-3.5 h-3.5 animate-pulse" />
            <span className="text-xs font-medium truncate max-w-[150px]">
              Tracing: {focusEntityId}
            </span>
            <button
              onClick={() => setFocus(null)}
              className="p-0.5 rounded hover:bg-purple-500/20"
              title="Clear focus"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>

      {/* Extended Settings Panel */}
      <AnimatePresence>
        {showSettings && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="p-3 rounded-xl glass-panel-subtle space-y-4">
              {/* Preset Buttons */}
              <div>
                <label className="text-2xs font-medium text-ink-muted uppercase tracking-wider mb-2 block">
                  Quick Presets
                </label>
                <div className="flex gap-2">
                  <PresetButton
                    label="Overview"
                    description="High-level, aggregated view"
                    icon={<Layers className="w-4 h-4" />}
                    onClick={() => resetToDefault('overview')}
                  />
                  <PresetButton
                    label="Impact"
                    description="Table-level with inheritance"
                    icon={<Sparkles className="w-4 h-4" />}
                    onClick={() => resetToDefault('impact')}
                  />
                  <PresetButton
                    label="Technical"
                    description="Column-level deep dive"
                    icon={<Target className="w-4 h-4" />}
                    onClick={() => resetToDefault('technical')}
                  />
                </div>
              </div>

              {/* Display Options */}
              <div>
                <label className="text-2xs font-medium text-ink-muted uppercase tracking-wider mb-2 block">
                  Display Options
                </label>
                <div className="flex flex-wrap gap-2">
                  <ToggleChip
                    label="Confidence Scores"
                    enabled={config.display.showConfidence}
                    icon={<Eye className="w-3.5 h-3.5" />}
                  // Would need to wire up display toggle
                  />
                  <ToggleChip
                    label="Child Counts"
                    enabled={config.display.showCounts}
                    icon={<Eye className="w-3.5 h-3.5" />}
                  />
                  <ToggleChip
                    label="Highlight Path"
                    enabled={config.display.highlightPath}
                    icon={<Eye className="w-3.5 h-3.5" />}
                  />
                </div>
              </div>

              {/* Aggregation Settings */}
              <div>
                <label className="text-2xs font-medium text-ink-muted uppercase tracking-wider mb-2 block">
                  Aggregation
                </label>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-ink-muted">Min Confidence:</span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.1"
                      value={config.aggregation.minConfidence}
                      className="w-24 accent-accent-lineage"
                    />
                    <span className="text-xs font-mono text-ink">
                      {Math.round(config.aggregation.minConfidence * 100)}%
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// Mode button component
function ModeButton({
  mode,
  label,
  icon,
  currentMode,
  onClick,
}: {
  mode: LineageExplorationMode
  label: string
  icon: React.ReactNode
  currentMode: LineageExplorationMode
  onClick: () => void
}) {
  const isActive = mode === currentMode

  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all",
        isActive
          ? "bg-accent-lineage text-white shadow-sm"
          : "text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5"
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

// Granularity selector component
function GranularitySelector({
  value,
  onChange,
}: {
  value: LineageGranularity
  onChange: (granularity: LineageGranularity) => void
}) {
  const [isOpen, setIsOpen] = useState(false)

  const options: { value: LineageGranularity; label: string; icon: React.ReactNode; description: string }[] = [
    { value: 'column', label: 'Column', icon: <Columns className="w-3.5 h-3.5" />, description: 'Most detailed view' },
    { value: 'table', label: 'Table', icon: <Table2 className="w-3.5 h-3.5" />, description: 'Aggregate columns' },
    { value: 'schema', label: 'Schema', icon: <Database className="w-3.5 h-3.5" />, description: 'Aggregate tables' },
    { value: 'domain', label: 'Domain', icon: <Globe className="w-3.5 h-3.5" />, description: 'Highest level' },
  ]

  const current = options.find(o => o.value === value) ?? options[1]

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "flex items-center gap-2 px-3 py-1.5 rounded-lg",
          "bg-black/5 dark:bg-white/5 text-sm font-medium",
          "hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
        )}
      >
        {current.icon}
        <span>{current.label}</span>
        <ChevronDown className={cn(
          "w-3.5 h-3.5 transition-transform",
          isOpen && "rotate-180"
        )} />
      </button>

      <AnimatePresence>
        {isOpen && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setIsOpen(false)}
            />
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className={cn(
                "absolute top-full left-0 mt-1 z-50",
                "w-48 p-1 rounded-xl glass-panel shadow-lg"
              )}
            >
              {options.map((option) => (
                <button
                  key={option.value}
                  onClick={() => {
                    onChange(option.value)
                    setIsOpen(false)
                  }}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left",
                    "transition-colors",
                    value === option.value
                      ? "bg-accent-lineage/10 text-accent-lineage"
                      : "text-ink hover:bg-black/5 dark:hover:bg-white/5"
                  )}
                >
                  {option.icon}
                  <div>
                    <div className="text-sm font-medium">{option.label}</div>
                    <div className="text-2xs text-ink-muted">{option.description}</div>
                  </div>
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}

// Depth control component
function DepthControl({
  icon,
  label,
  value,
  onChange,
  count,
  disabled = false,
}: {
  icon: React.ReactNode
  label: string
  value: number
  onChange: (value: number) => void
  count?: number
  disabled?: boolean
}) {
  return (
    <div className={cn("flex items-center gap-2", disabled && "pointer-events-none")}>
      <div className="text-ink-muted" title={label}>
        {icon}
      </div>
      <button
        onClick={() => onChange(value - 1)}
        disabled={disabled || value <= 0}
        className={cn(
          "w-5 h-5 rounded flex items-center justify-center",
          "text-ink-muted hover:text-ink hover:bg-black/10 dark:hover:bg-white/10",
          "disabled:opacity-30 disabled:cursor-not-allowed",
          "transition-colors"
        )}
      >
        <Minus className="w-3 h-3" />
      </button>
      <span className="w-4 text-center text-xs font-medium">{value}</span>
      <button
        onClick={() => onChange(value + 1)}
        disabled={disabled || value >= 20}
        className={cn(
          "w-5 h-5 rounded flex items-center justify-center",
          "text-ink-muted hover:text-ink hover:bg-black/10 dark:hover:bg-white/10",
          "disabled:opacity-30 disabled:cursor-not-allowed",
          "transition-colors"
        )}
      >
        <Plus className="w-3 h-3" />
      </button>
      {count !== undefined && count > 0 && (
        <span className="ml-1 px-1.5 py-0.5 rounded bg-accent-lineage/10 text-accent-lineage text-2xs font-medium">
          {count}
        </span>
      )}
    </div>
  )
}

// Preset button component
function PresetButton({
  label,
  description,
  icon,
  onClick,
}: {
  label: string
  description: string
  icon: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex-1 flex flex-col items-center gap-1 p-3 rounded-xl",
        "border border-glass-border hover:border-accent-lineage/50",
        "hover:bg-accent-lineage/5 transition-all text-center"
      )}
    >
      <div className="text-accent-lineage">{icon}</div>
      <div className="text-xs font-medium">{label}</div>
      <div className="text-2xs text-ink-muted">{description}</div>
    </button>
  )
}

// Toggle chip component
function ToggleChip({
  label,
  enabled,
  icon: _icon, // Reserved for future custom icons
  onClick,
}: {
  label: string
  enabled: boolean
  icon: React.ReactNode
  onClick?: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-2xs font-medium transition-all",
        enabled
          ? "bg-accent-lineage/10 text-accent-lineage"
          : "bg-black/5 dark:bg-white/5 text-ink-muted"
      )}
    >
      {enabled ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
      {label}
    </button>
  )
}

export default LineageToolbar

