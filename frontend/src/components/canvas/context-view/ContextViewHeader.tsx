/**
 * ContextViewHeader - Toolbar, search, and trace controls for Context View
 *
 * Receives all state as props from ContextViewCanvas — no store access here.
 * Keeps the orchestrator lean and makes the header independently testable.
 */

import { useRef, useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'
import { TraceToolbar } from '../TraceToolbar'
import type { UseUnifiedTraceResult } from '@/hooks/useUnifiedTrace'
import type { HierarchyNode } from './types'

export interface ContextViewHeaderProps {
  // Search
  searchQuery: string
  onSearchChange: (q: string) => void
  searchResults: HierarchyNode[]
  onSearchResultClick: (node: HierarchyNode) => void

  // Lineage flow
  showLineageFlow: boolean
  onToggleLineageFlow: () => void
  lineageGranularity: string
  onGranularityChange: (g: string) => void

  // Expand/collapse
  onExpandAll: () => void
  onCollapseAll: () => void

  // Add entity
  onAddEntity: () => void

  // Load blueprint dropdown
  activeWorkspaceId: string | null
  onOpenLoadDropdown: () => void
  savedModels: Array<{ id: string; name: string }>
  isLoadingModels: boolean
  loadingModelId: string | null
  activeContextModelName: string | null
  onLoadModel: (id: string) => void
  onRefreshModels: () => void

  // Templates dropdown
  onOpenTemplatesDropdown: () => void
  templates: Array<{ id: string; name: string; category?: string }>
  isLoadingTemplates: boolean
  loadingTemplateId: string | null
  onLoadTemplate: (id: string, name: string) => void

  // Save blueprint
  syncStatus: 'idle' | 'dirty' | 'saving' | 'synced' | 'error'
  onSave: () => void

  // Trace toolbar
  trace: UseUnifiedTraceResult
  focusNodeName: string
  lineageEdgeTypes: string[]
  onExitTrace: () => void
}

export function ContextViewHeader({
  searchQuery,
  onSearchChange,
  searchResults,
  onSearchResultClick,
  showLineageFlow,
  onToggleLineageFlow,
  lineageGranularity,
  onGranularityChange,
  onExpandAll,
  onCollapseAll,
  onAddEntity,
  activeWorkspaceId,
  onOpenLoadDropdown,
  savedModels,
  isLoadingModels,
  loadingModelId,
  activeContextModelName,
  onLoadModel,
  onRefreshModels,
  onOpenTemplatesDropdown,
  templates,
  isLoadingTemplates,
  loadingTemplateId,
  onLoadTemplate,
  syncStatus,
  onSave,
  trace,
  focusNodeName,
  lineageEdgeTypes,
  onExitTrace,
}: ContextViewHeaderProps) {
  const searchInputRef = useRef<HTMLInputElement>(null)

  return (
    <div className="flex-shrink-0 bg-gradient-to-r from-canvas-elevated/90 via-canvas-elevated/95 to-canvas-elevated/90 backdrop-blur-xl border-b border-white/[0.06] px-6 py-3 relative">
      {/* Subtle gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-r from-accent-lineage/[0.02] via-transparent to-purple-500/[0.02] pointer-events-none" />

      <div className="flex items-center gap-4 relative">
        {/* Title */}
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-accent-lineage/20 to-purple-500/20 flex items-center justify-center shadow-lg shadow-accent-lineage/10">
            <LucideIcons.Network className="w-5 h-5 text-accent-lineage" />
          </div>
          <div>
            <h2 className="text-base font-display font-semibold text-ink tracking-tight">Context View</h2>
            <p className="text-[10px] text-ink-muted/60 flex items-center gap-1.5">
              <LucideIcons.ArrowRight className="w-3 h-3" />
              Data Flow Blueprint
            </p>
          </div>
        </div>

        <div className="flex-1" />

        {/* Search */}
        <div className="relative group">
          <div className="absolute inset-0 bg-gradient-to-r from-accent-lineage/10 to-purple-500/10 rounded-xl opacity-0 group-focus-within:opacity-100 blur-xl transition-opacity" />
          <div className="relative">
            <LucideIcons.Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted/50 group-focus-within:text-accent-lineage transition-colors" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search entities..."
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className="w-52 pl-9 pr-8 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-sm text-ink placeholder:text-ink-muted/40 focus:outline-none focus:border-accent-lineage/40 focus:bg-white/[0.06] transition-all"
            />
            {searchQuery && (
              <button
                onClick={() => onSearchChange('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-lg hover:bg-white/10 text-ink-muted hover:text-ink transition-all"
              >
                <LucideIcons.X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="w-px h-6 bg-gradient-to-b from-transparent via-white/10 to-transparent" />

        {/* Lineage Flow Toggle */}
        <button
          onClick={onToggleLineageFlow}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all duration-300",
            showLineageFlow
              ? "bg-gradient-to-r from-accent-lineage/20 to-accent-lineage/10 text-accent-lineage shadow-lg shadow-accent-lineage/20 border border-accent-lineage/30"
              : "bg-white/[0.04] border border-white/[0.08] text-ink-muted hover:bg-white/[0.08] hover:text-ink"
          )}
        >
          <motion.div animate={{ rotate: showLineageFlow ? 0 : -180 }} transition={{ duration: 0.3 }}>
            <LucideIcons.GitBranch className="w-4 h-4" />
          </motion.div>
          <span>{showLineageFlow ? 'Flow Active' : 'Show Flow'}</span>
          <div className={cn(
            "w-2 h-2 rounded-full transition-colors duration-300",
            showLineageFlow ? "bg-green-400 shadow-lg shadow-green-400/50" : "bg-ink-muted/30"
          )} />
        </button>

        {/* Granularity Selector */}
        <AnimatePresence>
          {showLineageFlow && (
            <motion.div
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: 'auto' }}
              exit={{ opacity: 0, width: 0 }}
              className="overflow-hidden"
            >
              <select
                value={lineageGranularity}
                onChange={(e) => onGranularityChange(e.target.value)}
                className="px-3 py-2 rounded-xl text-xs font-medium bg-white/[0.04] border border-white/[0.08] text-ink cursor-pointer hover:bg-white/[0.08] focus:outline-none focus:border-accent-lineage/40 transition-all appearance-none pr-8 bg-no-repeat bg-right"
                style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%239ca3af'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'%3E%3C/path%3E%3C/svg%3E")`, backgroundSize: '16px', backgroundPosition: 'right 8px center' }}
              >
                <option value="column">Column Level</option>
                <option value="table">Table Level</option>
                <option value="schema">Schema Level</option>
                <option value="system">System Level</option>
                <option value="domain">Domain Level</option>
              </select>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="w-px h-6 bg-gradient-to-b from-transparent via-white/10 to-transparent" />

        {/* Add Entity */}
        <button
          onClick={onAddEntity}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium bg-gradient-to-r from-green-500/20 to-emerald-500/10 text-green-400 border border-green-500/30 hover:from-green-500/30 hover:to-emerald-500/20 hover:shadow-lg hover:shadow-green-500/20 transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
        >
          <LucideIcons.Plus className="w-4 h-4" />
          <span>Add Entity</span>
        </button>

        {/* Expand / Collapse All */}
        <div className="flex items-center gap-1 p-1 rounded-xl bg-white/[0.03] border border-white/[0.06]">
          <button
            onClick={onExpandAll}
            className="p-1.5 rounded-lg hover:bg-white/[0.08] text-ink-muted hover:text-ink transition-all"
            title="Expand All"
          >
            <LucideIcons.ChevronsDownUp className="w-4 h-4 rotate-180" />
          </button>
          <div className="w-px h-4 bg-white/[0.08]" />
          <button
            onClick={onCollapseAll}
            className="p-1.5 rounded-lg hover:bg-white/[0.08] text-ink-muted hover:text-ink transition-all"
            title="Collapse All"
          >
            <LucideIcons.ChevronsDownUp className="w-4 h-4" />
          </button>
        </div>

        <div className="w-px h-6 bg-gradient-to-b from-transparent via-white/10 to-transparent" />

        {/* Overflow: Load Blueprint + Templates in a single "···" menu */}
        <OverflowMenu
          activeWorkspaceId={activeWorkspaceId}
          onOpenLoadDropdown={onOpenLoadDropdown}
          savedModels={savedModels}
          isLoadingModels={isLoadingModels}
          loadingModelId={loadingModelId}
          activeContextModelName={activeContextModelName}
          onLoadModel={onLoadModel}
          onRefreshModels={onRefreshModels}
          onOpenTemplatesDropdown={onOpenTemplatesDropdown}
          templates={templates}
          isLoadingTemplates={isLoadingTemplates}
          loadingTemplateId={loadingTemplateId}
          onLoadTemplate={onLoadTemplate}
        />

        <div className="w-px h-6 bg-gradient-to-b from-transparent via-white/10 to-transparent" />

        {/* Save Blueprint */}
        <div className="flex items-center gap-2">
          {activeContextModelName && (
            <span className="text-xs text-ink-muted truncate max-w-[120px]" title={activeContextModelName}>
              {activeContextModelName}
            </span>
          )}
          <button
            onClick={onSave}
            disabled={(syncStatus !== 'dirty' && syncStatus !== 'error') || !activeWorkspaceId}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all duration-300",
              syncStatus === 'dirty'
                ? "bg-gradient-to-r from-blue-500/20 to-cyan-500/10 text-blue-400 border border-blue-500/30 hover:from-blue-500/30 hover:to-cyan-500/20 hover:shadow-lg hover:shadow-blue-500/20 hover:scale-[1.02] active:scale-[0.98]"
                : syncStatus === 'error'
                  ? "bg-gradient-to-r from-red-500/20 to-red-500/10 text-red-400 border border-red-500/30"
                  : "bg-white/[0.03] border border-white/[0.06] text-ink-muted/50 cursor-not-allowed"
            )}
            title={
              !activeWorkspaceId ? 'No workspace selected'
                : syncStatus === 'dirty' ? 'Save changes to backend'
                  : syncStatus === 'error' ? 'Save failed — click to retry'
                    : 'All changes saved'
            }
          >
            {syncStatus === 'saving'
              ? <LucideIcons.Loader2 className="w-4 h-4 animate-spin" />
              : syncStatus === 'error'
                ? <LucideIcons.AlertCircle className="w-4 h-4" />
                : syncStatus === 'synced'
                  ? <LucideIcons.CheckCircle className="w-4 h-4" />
                  : <LucideIcons.Save className="w-4 h-4" />
            }
            <span>
              {syncStatus === 'saving' ? 'Saving...'
                : syncStatus === 'error' ? 'Retry Save'
                  : syncStatus === 'synced' ? 'Saved'
                    : 'Save Blueprint'}
            </span>
            {syncStatus === 'dirty' && (
              <div className="w-2 h-2 rounded-full bg-blue-400 shadow-lg shadow-blue-400/50" />
            )}
          </button>
        </div>
      </div>

      {/* Search Results */}
      <AnimatePresence>
        {searchResults.length > 0 && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-3 flex items-center gap-2 flex-wrap relative"
          >
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-amber-500/10 border border-amber-500/20">
              <LucideIcons.Search className="w-3.5 h-3.5 text-amber-500" />
              <span className="text-xs font-medium text-amber-500">{searchResults.length} found</span>
            </div>
            {searchResults.slice(0, 5).map((node, idx) => (
              <motion.button
                key={node.id}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: idx * 0.05 }}
                onClick={() => onSearchResultClick(node)}
                className="px-3 py-1.5 rounded-xl bg-white/[0.04] border border-white/[0.08] text-ink text-xs font-medium hover:bg-accent-lineage/15 hover:border-accent-lineage/30 hover:text-accent-lineage transition-all duration-200 hover:shadow-lg hover:shadow-accent-lineage/10"
              >
                {node.name}
              </motion.button>
            ))}
            {searchResults.length > 5 && (
              <span className="px-2 py-1 text-xs text-ink-muted/60">+{searchResults.length - 5} more</span>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Trace Toolbar */}
      <AnimatePresence>
        {trace.isTracing && (
          <TraceToolbar
            focusNodeName={focusNodeName}
            upstreamCount={trace.upstreamCount}
            downstreamCount={trace.downstreamCount}
            showUpstream={trace.showUpstream}
            showDownstream={trace.showDownstream}
            onToggleUpstream={() => trace.setShowUpstream(!trace.showUpstream)}
            onToggleDownstream={() => trace.setShowDownstream(!trace.showDownstream)}
            onExitTrace={onExitTrace}
            onRetrace={trace.retrace}
            onTraceUpstream={() => trace.focusId && trace.traceUpstream(trace.focusId)}
            onTraceDownstream={() => trace.focusId && trace.traceDownstream(trace.focusId)}
            onTraceFullLineage={() => trace.focusId && trace.traceFullLineage(trace.focusId)}
            config={trace.config}
            onConfigChange={trace.setConfig}
            traceResult={trace.result}
            statistics={trace.statistics}
            isLoading={trace.isLoading}
            availableLineageEdgeTypes={lineageEdgeTypes}
            position="floating"
          />
        )}
      </AnimatePresence>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// OverflowMenu — collects Load Blueprint + Templates behind a single "···" button
// Keeps ContextViewHeader's toolbar row tight: ~7 items instead of ~12
// ─────────────────────────────────────────────────────────────────────────────

interface OverflowMenuProps {
  activeWorkspaceId: string | null
  onOpenLoadDropdown: () => void
  savedModels: Array<{ id: string; name: string }>
  isLoadingModels: boolean
  loadingModelId: string | null
  activeContextModelName: string | null
  onLoadModel: (id: string) => void
  onRefreshModels: () => void
  onOpenTemplatesDropdown: () => void
  templates: Array<{ id: string; name: string; category?: string }>
  isLoadingTemplates: boolean
  loadingTemplateId: string | null
  onLoadTemplate: (id: string, name: string) => void
}

function OverflowMenu({
  activeWorkspaceId,
  onOpenLoadDropdown,
  savedModels,
  isLoadingModels,
  loadingModelId,
  activeContextModelName,
  onLoadModel,
  onRefreshModels,
  onOpenTemplatesDropdown,
  templates,
  isLoadingTemplates,
  loadingTemplateId,
  onLoadTemplate,
}: OverflowMenuProps) {
  const [open, setOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<'load' | 'templates'>('load')
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [dropdownPos, setDropdownPos] = useState<{ top: number; right: number } | null>(null)

  const toggle = () => {
    if (!open) {
      // Compute fixed position from button rect — escapes backdrop-blur stacking context
      if (buttonRef.current) {
        const rect = buttonRef.current.getBoundingClientRect()
        setDropdownPos({ top: rect.bottom + 8, right: window.innerWidth - rect.right })
      }
      if (activeTab === 'load') onOpenLoadDropdown()
      else onOpenTemplatesDropdown()
    }
    setOpen(v => !v)
  }

  const close = () => setOpen(false)

  const handleTabChange = (tab: 'load' | 'templates') => {
    setActiveTab(tab)
    if (tab === 'load' && savedModels.length === 0) onOpenLoadDropdown()
    if (tab === 'templates' && templates.length === 0) onOpenTemplatesDropdown()
  }

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
        close()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={toggle}
        className={cn(
          "p-2 rounded-xl text-sm font-medium transition-all duration-200",
          open
            ? "bg-white/[0.1] text-ink border border-white/[0.12]"
            : "bg-white/[0.04] border border-white/[0.08] text-ink-muted hover:bg-white/[0.08] hover:text-ink"
        )}
        title="Load blueprint or apply template"
      >
        <LucideIcons.MoreHorizontal className="w-4 h-4" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.96 }}
            transition={{ duration: 0.15, ease: [0.25, 0.46, 0.45, 0.94] }}
            // Use fixed positioning to escape the backdrop-blur stacking context
            style={dropdownPos ? { position: 'fixed', top: dropdownPos.top, right: dropdownPos.right } : {}}
            className="w-80 z-[9999] rounded-xl bg-canvas-elevated/98 backdrop-blur-xl border border-white/[0.1] shadow-2xl shadow-black/50 overflow-hidden"
          >
            {/* Tab strip */}
            <div className="flex border-b border-white/[0.06]">
              <button
                onClick={() => handleTabChange('load')}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-medium transition-all",
                  activeTab === 'load'
                    ? "text-purple-400 border-b-2 border-purple-400 bg-purple-500/[0.06]"
                    : "text-ink-muted hover:text-ink hover:bg-white/[0.04]"
                )}
              >
                <LucideIcons.FolderOpen className="w-3.5 h-3.5" />
                Saved Blueprints
              </button>
              <button
                onClick={() => handleTabChange('templates')}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 px-3 py-2.5 text-xs font-medium transition-all",
                  activeTab === 'templates'
                    ? "text-amber-400 border-b-2 border-amber-400 bg-amber-500/[0.06]"
                    : "text-ink-muted hover:text-ink hover:bg-white/[0.04]"
                )}
              >
                <LucideIcons.Wand2 className="w-3.5 h-3.5" />
                Templates
              </button>
            </div>

            {/* Load Blueprint panel */}
            <AnimatePresence mode="wait">
              {activeTab === 'load' && (
                <motion.div
                  key="load"
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -8 }}
                  transition={{ duration: 0.15 }}
                >
                  <div className="max-h-64 overflow-y-auto py-1">
                    {isLoadingModels ? (
                      <div className="flex items-center justify-center py-8">
                        <LucideIcons.Loader2 className="w-4 h-4 animate-spin text-ink-muted" />
                      </div>
                    ) : savedModels.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
                        <LucideIcons.FolderOpen className="w-8 h-8 text-ink-muted/30 mb-2" />
                        <p className="text-xs text-ink-muted/60">No saved blueprints yet</p>
                        <p className="text-[10px] text-ink-muted/40 mt-1">Save your current layout first</p>
                      </div>
                    ) : (
                      savedModels.map(model => (
                        <button
                          key={model.id}
                          onClick={() => { onLoadModel(model.id); setOpen(false) }}
                          disabled={loadingModelId === model.id}
                          className={cn(
                            "w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors",
                            activeContextModelName === model.name
                              ? "bg-purple-500/10 text-purple-400"
                              : "text-ink hover:bg-white/[0.05]"
                          )}
                        >
                          {loadingModelId === model.id
                            ? <LucideIcons.Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
                            : activeContextModelName === model.name
                              ? <LucideIcons.CheckCircle className="w-3.5 h-3.5 flex-shrink-0 text-purple-400" />
                              : <LucideIcons.FileCode2 className="w-3.5 h-3.5 flex-shrink-0 text-ink-muted/60" />
                          }
                          <span className="truncate">{model.name}</span>
                        </button>
                      ))
                    )}
                  </div>
                  <div className="border-t border-white/[0.06] px-4 py-2 flex items-center justify-between">
                    <span className="text-[11px] text-ink-muted/50">
                      {!activeWorkspaceId ? 'No workspace selected' : `${savedModels.length} blueprint${savedModels.length !== 1 ? 's' : ''}`}
                    </span>
                    <button
                      onClick={onRefreshModels}
                      className="flex items-center gap-1.5 text-[11px] text-ink-muted/60 hover:text-ink-muted transition-colors"
                    >
                      <LucideIcons.RefreshCw className="w-3 h-3" />
                      Refresh
                    </button>
                  </div>
                </motion.div>
              )}

              {/* Templates panel */}
              {activeTab === 'templates' && (
                <motion.div
                  key="templates"
                  initial={{ opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 8 }}
                  transition={{ duration: 0.15 }}
                >
                  <div className="px-4 py-2 border-b border-white/[0.04]">
                    <p className="text-[10px] text-ink-muted/50">Replaces current layers — save first if needed</p>
                  </div>
                  <div className="max-h-60 overflow-y-auto py-1">
                    {isLoadingTemplates ? (
                      <div className="flex items-center justify-center py-8">
                        <LucideIcons.Loader2 className="w-4 h-4 animate-spin text-ink-muted" />
                      </div>
                    ) : templates.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
                        <LucideIcons.Wand2 className="w-8 h-8 text-ink-muted/30 mb-2" />
                        <p className="text-xs text-ink-muted/60">No templates available</p>
                        <p className="text-[10px] text-ink-muted/40 mt-1">Ask your admin to seed templates</p>
                      </div>
                    ) : (
                      templates.map(tmpl => (
                        <button
                          key={tmpl.id}
                          onClick={() => { onLoadTemplate(tmpl.id, tmpl.name); setOpen(false) }}
                          disabled={loadingTemplateId === tmpl.id || !activeWorkspaceId}
                          className="w-full flex items-start gap-3 px-4 py-2.5 text-left text-sm text-ink hover:bg-white/[0.05] transition-colors disabled:opacity-40"
                        >
                          {loadingTemplateId === tmpl.id
                            ? <LucideIcons.Loader2 className="w-4 h-4 animate-spin flex-shrink-0 mt-0.5 text-amber-400" />
                            : <LucideIcons.LayoutTemplate className="w-4 h-4 flex-shrink-0 mt-0.5 text-amber-400" />
                          }
                          <div className="min-w-0">
                            <p className="font-medium truncate">{tmpl.name}</p>
                            {tmpl.category && (
                              <p className="text-[10px] text-ink-muted/60 mt-0.5 capitalize">{tmpl.category.replace(/-/g, ' ')}</p>
                            )}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
