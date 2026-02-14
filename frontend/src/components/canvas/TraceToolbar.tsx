/**
 * TraceToolbar - Reusable trace controls component
 * 
 * Provides a floating toolbar for trace operations including:
 * - Depth slider (1-99 hops)
 * - Direction toggles with counts
 * - Path-only mode toggle
 * - Quick actions (copy URNs, export, pin)
 */

import React, { useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { 
    useTraceStore, 
    type TraceConfig, 
    type TraceResult 
} from '@/hooks/useUnifiedTrace'

// ============================================
// Types
// ============================================

interface TraceToolbarProps {
    /** Name of the focused node */
    focusNodeName?: string
    /** Upstream node count */
    upstreamCount: number
    /** Downstream node count */
    downstreamCount: number
    /** Whether upstream is visible */
    showUpstream: boolean
    /** Whether downstream is visible */
    showDownstream: boolean
    /** Toggle upstream visibility */
    onToggleUpstream: () => void
    /** Toggle downstream visibility */
    onToggleDownstream: () => void
    /** Exit/clear trace */
    onExitTrace: () => void
    /** Current configuration */
    config: TraceConfig
    /** Update configuration */
    onConfigChange: (config: Partial<TraceConfig>) => void
    /** Trace result for export functionality */
    traceResult?: TraceResult | null
    /** Additional className */
    className?: string
    /** Position variant */
    position?: 'top' | 'bottom' | 'floating'
}

// ============================================
// Component
// ============================================

export function TraceToolbar({
    focusNodeName = 'Unknown Node',
    upstreamCount,
    downstreamCount,
    showUpstream,
    showDownstream,
    onToggleUpstream,
    onToggleDownstream,
    onExitTrace,
    config,
    onConfigChange,
    traceResult,
    className,
    position = 'floating',
}: TraceToolbarProps) {
    const [isExpanded, setIsExpanded] = useState(false)
    const [copiedMessage, setCopiedMessage] = useState<string | null>(null)
    
    // Copy URNs to clipboard
    const handleCopyUrns = useCallback(async () => {
        if (!traceResult) return
        
        const urns = Array.from(traceResult.traceNodes).join('\n')
        try {
            await navigator.clipboard.writeText(urns)
            setCopiedMessage('URNs copied!')
            setTimeout(() => setCopiedMessage(null), 2000)
        } catch {
            setCopiedMessage('Failed to copy')
            setTimeout(() => setCopiedMessage(null), 2000)
        }
    }, [traceResult])
    
    // Export trace as JSON
    const handleExport = useCallback(() => {
        if (!traceResult || !traceResult.lineageResult) return
        
        const exportData = {
            focusId: traceResult.focusId,
            timestamp: new Date().toISOString(),
            config,
            nodes: traceResult.lineageResult.nodes,
            edges: traceResult.lineageResult.edges,
            upstream: Array.from(traceResult.upstreamNodes),
            downstream: Array.from(traceResult.downstreamNodes),
        }
        
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `trace-${traceResult.focusId.replace(/[^a-zA-Z0-9]/g, '_')}.json`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
    }, [traceResult, config])
    
    // Position styles
    const positionClasses = {
        top: 'absolute top-4 left-1/2 -translate-x-1/2',
        bottom: 'absolute bottom-4 left-1/2 -translate-x-1/2',
        floating: 'fixed top-16 left-1/2 -translate-x-1/2',
    }
    
    return (
        <motion.div
            initial={{ y: -20, opacity: 0, scale: 0.95 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -20, opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className={cn(
                "z-50 glass-panel border border-accent-lineage/30 shadow-lg shadow-accent-lineage/10 rounded-2xl",
                positionClasses[position],
                className
            )}
        >
            {/* Main Toolbar Row */}
            <div className="flex items-center gap-3 px-4 py-2">
                {/* Focus Indicator */}
                <div className="flex items-center gap-2 text-sm font-medium text-ink">
                    <motion.span 
                        className="w-2 h-2 rounded-full bg-accent-lineage"
                        animate={{ scale: [1, 1.2, 1] }}
                        transition={{ duration: 1.5, repeat: Infinity }}
                    />
                    <span>Tracing:</span>
                    <span className="font-bold text-accent-lineage max-w-[200px] truncate">
                        {focusNodeName}
                    </span>
                </div>
                
                {/* Divider */}
                <div className="h-4 w-[1px] bg-glass-border" />
                
                {/* Direction Toggles */}
                <div className="flex items-center gap-1 bg-black/5 dark:bg-white/5 rounded-lg p-0.5">
                    <button
                        onClick={onToggleUpstream}
                        className={cn(
                            "p-1.5 rounded-md transition-all text-xs font-medium flex items-center gap-1",
                            showUpstream 
                                ? "bg-accent-lineage text-white shadow-sm" 
                                : "hover:bg-black/5 dark:hover:bg-white/10 text-ink-muted"
                        )}
                        title={`${showUpstream ? 'Hide' : 'Show'} upstream (${upstreamCount})`}
                    >
                        <LucideIcons.ArrowLeft className="w-3.5 h-3.5" />
                        <span className="min-w-[16px]">{upstreamCount}</span>
                    </button>
                    <button
                        onClick={onToggleDownstream}
                        className={cn(
                            "p-1.5 rounded-md transition-all text-xs font-medium flex items-center gap-1",
                            showDownstream 
                                ? "bg-accent-lineage text-white shadow-sm" 
                                : "hover:bg-black/5 dark:hover:bg-white/10 text-ink-muted"
                        )}
                        title={`${showDownstream ? 'Hide' : 'Show'} downstream (${downstreamCount})`}
                    >
                        <span className="min-w-[16px]">{downstreamCount}</span>
                        <LucideIcons.ArrowRight className="w-3.5 h-3.5" />
                    </button>
                </div>
                
                {/* Divider */}
                <div className="h-4 w-[1px] bg-glass-border" />
                
                {/* Expand/Settings Button */}
                <button
                    onClick={() => setIsExpanded(!isExpanded)}
                    className={cn(
                        "p-1.5 rounded-md transition-all",
                        isExpanded 
                            ? "bg-accent-lineage/10 text-accent-lineage" 
                            : "hover:bg-black/5 dark:hover:bg-white/10 text-ink-muted"
                    )}
                    title="Trace settings"
                >
                    <LucideIcons.Settings className="w-4 h-4" />
                </button>
                
                {/* Quick Actions */}
                <div className="flex items-center gap-1">
                    <button
                        onClick={handleCopyUrns}
                        className="p-1.5 rounded-md hover:bg-black/5 dark:hover:bg-white/10 text-ink-muted transition-all"
                        title="Copy URNs"
                    >
                        <LucideIcons.Copy className="w-4 h-4" />
                    </button>
                    <button
                        onClick={handleExport}
                        className="p-1.5 rounded-md hover:bg-black/5 dark:hover:bg-white/10 text-ink-muted transition-all"
                        title="Export trace"
                    >
                        <LucideIcons.Download className="w-4 h-4" />
                    </button>
                </div>
                
                {/* Divider */}
                <div className="h-4 w-[1px] bg-glass-border" />
                
                {/* Exit Button */}
                <button
                    onClick={onExitTrace}
                    className="text-xs font-semibold text-ink-muted hover:text-ink flex items-center gap-1 transition-colors"
                >
                    <LucideIcons.X className="w-3.5 h-3.5" />
                    Exit
                </button>
            </div>
            
            {/* Expanded Settings Panel */}
            <AnimatePresence>
                {isExpanded && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden border-t border-glass-border"
                    >
                        <div className="p-4 space-y-4">
                            {/* Depth Controls */}
                            <div className="grid grid-cols-2 gap-4">
                                {/* Upstream Depth */}
                                <div className="space-y-2">
                                    <div className="flex items-center justify-between">
                                        <label className="text-xs font-medium text-ink-muted">
                                            Upstream Depth
                                        </label>
                                        <span className="text-xs font-bold text-accent-lineage">
                                            {config.upstreamDepth}
                                        </span>
                                    </div>
                                    <input
                                        type="range"
                                        min={1}
                                        max={99}
                                        value={config.upstreamDepth}
                                        onChange={(e) => onConfigChange({ upstreamDepth: parseInt(e.target.value) })}
                                        className="w-full h-1.5 rounded-full bg-black/10 dark:bg-white/10 appearance-none cursor-pointer accent-accent-lineage"
                                    />
                                    <div className="flex justify-between text-2xs text-ink-muted">
                                        <span>1</span>
                                        <span>99</span>
                                    </div>
                                </div>
                                
                                {/* Downstream Depth */}
                                <div className="space-y-2">
                                    <div className="flex items-center justify-between">
                                        <label className="text-xs font-medium text-ink-muted">
                                            Downstream Depth
                                        </label>
                                        <span className="text-xs font-bold text-accent-lineage">
                                            {config.downstreamDepth}
                                        </span>
                                    </div>
                                    <input
                                        type="range"
                                        min={1}
                                        max={99}
                                        value={config.downstreamDepth}
                                        onChange={(e) => onConfigChange({ downstreamDepth: parseInt(e.target.value) })}
                                        className="w-full h-1.5 rounded-full bg-black/10 dark:bg-white/10 appearance-none cursor-pointer accent-accent-lineage"
                                    />
                                    <div className="flex justify-between text-2xs text-ink-muted">
                                        <span>1</span>
                                        <span>99</span>
                                    </div>
                                </div>
                            </div>
                            
                            {/* Toggle Options */}
                            <div className="flex items-center gap-4">
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={config.includeColumnLineage}
                                        onChange={(e) => onConfigChange({ includeColumnLineage: e.target.checked })}
                                        className="rounded text-accent-lineage"
                                    />
                                    <span className="text-xs text-ink">Include column lineage</span>
                                </label>
                                
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={config.pathOnly}
                                        onChange={(e) => onConfigChange({ pathOnly: e.target.checked })}
                                        className="rounded text-accent-lineage"
                                    />
                                    <span className="text-xs text-ink">Path only (hide context)</span>
                                </label>
                                
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={config.autoExpandAncestors}
                                        onChange={(e) => onConfigChange({ autoExpandAncestors: e.target.checked })}
                                        className="rounded text-accent-lineage"
                                    />
                                    <span className="text-xs text-ink">Auto-expand ancestors</span>
                                </label>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
            
            {/* Copy Notification */}
            <AnimatePresence>
                {copiedMessage && (
                    <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 10 }}
                        className="absolute -bottom-10 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg bg-green-500 text-white text-xs font-medium shadow-lg"
                    >
                        {copiedMessage}
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    )
}

// ============================================
// Compact Variant
// ============================================

interface CompactTraceToolbarProps {
    focusNodeName?: string
    onExitTrace: () => void
    upstreamCount: number
    downstreamCount: number
    className?: string
}

export function CompactTraceToolbar({
    focusNodeName = 'Unknown',
    onExitTrace,
    upstreamCount,
    downstreamCount,
    className,
}: CompactTraceToolbarProps) {
    return (
        <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className={cn(
                "inline-flex items-center gap-2 px-3 py-1.5 rounded-full glass-panel border border-accent-lineage/30 shadow-md",
                className
            )}
        >
            <motion.span 
                className="w-1.5 h-1.5 rounded-full bg-accent-lineage"
                animate={{ opacity: [1, 0.5, 1] }}
                transition={{ duration: 1.5, repeat: Infinity }}
            />
            <span className="text-xs font-medium text-ink truncate max-w-[120px]">
                {focusNodeName}
            </span>
            <span className="text-2xs text-ink-muted">
                ↑{upstreamCount} ↓{downstreamCount}
            </span>
            <button
                onClick={onExitTrace}
                className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-ink-muted"
            >
                <LucideIcons.X className="w-3 h-3" />
            </button>
        </motion.div>
    )
}

export default TraceToolbar

