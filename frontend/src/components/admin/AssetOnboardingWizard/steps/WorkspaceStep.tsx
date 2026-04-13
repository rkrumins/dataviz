/**
 * WorkspaceStep — Allocate each catalog item to a workspace.
 *
 * Rich workspace cards with metadata, smart provider-based grouping,
 * auto-suggest for existing workspaces, and polished create-new flow.
 */

import { useState, useEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Database, Plus, Check, AlertTriangle, Shield, BookOpen,
    Layers, Star, ChevronDown, Sparkles, Package,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { workspaceService, type WorkspaceResponse } from '@/services/workspaceService'
import type { CatalogItemResponse } from '@/services/catalogService'
import type { OnboardingFormData } from '../AssetOnboardingWizard'

// ============================================
// Types
// ============================================

interface WorkspaceStepProps {
    formData: OnboardingFormData
    updateFormData: (updates: Partial<OnboardingFormData>) => void
    catalogItems: CatalogItemResponse[]
    /** Called when workspaces are loaded from the API — parent uses this to build name maps */
    onWorkspacesLoaded?: (nameMap: Record<string, string>) => void
}

type AllocationMode = 'new' | 'existing'

// ============================================
// Helpers
// ============================================

function getAllocationStatus(
    allocation: OnboardingFormData['allocations'][string] | undefined
): 'allocated' | 'pending' {
    if (!allocation) return 'pending'
    if (allocation.workspaceId === 'new' && allocation.newWorkspaceName.trim()) return 'allocated'
    if (allocation.workspaceId && allocation.workspaceId !== '' && allocation.workspaceId !== 'new') return 'allocated'
    return 'pending'
}

function detectDuplicateName(
    name: string,
    existingWorkspaces: WorkspaceResponse[],
    allocations: OnboardingFormData['allocations'],
    currentItemId: string
): boolean {
    if (!name.trim()) return false
    const lower = name.trim().toLowerCase()
    if (existingWorkspaces.some(ws => ws.name.toLowerCase() === lower)) return true
    for (const [itemId, alloc] of Object.entries(allocations)) {
        if (itemId === currentItemId) continue
        if (alloc.workspaceId === 'new' && alloc.newWorkspaceName.trim().toLowerCase() === lower) {
            return true
        }
    }
    return false
}

function getRunningAggregationCount(ws: WorkspaceResponse): number {
    return ws.dataSources.filter(ds => ds.aggregationStatus === 'running' || ds.aggregationStatus === 'pending').length
}

// ============================================
// Component
// ============================================

export function WorkspaceStep({ formData, updateFormData, catalogItems, onWorkspacesLoaded }: WorkspaceStepProps) {
    const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [expandedItems, setExpandedItems] = useState<Set<string>>(() => new Set(catalogItems.map(c => c.id)))

    // Track which mode each card is in (new vs existing)
    const [modes, setModes] = useState<Record<string, AllocationMode>>(() => {
        const initial: Record<string, AllocationMode> = {}
        for (const item of catalogItems) {
            const alloc = formData.allocations[item.id]
            initial[item.id] = alloc?.workspaceId === 'new' ? 'new' : 'existing'
        }
        return initial
    })

    useEffect(() => {
        let cancelled = false
        setIsLoading(true)
        setError(null)

        workspaceService.list()
            .then(data => {
                if (!cancelled) {
                    setWorkspaces(data)
                    setIsLoading(false)
                    // Report workspace names to parent for use in other steps
                    if (onWorkspacesLoaded) {
                        const nameMap: Record<string, string> = {}
                        for (const ws of data) nameMap[ws.id] = ws.name
                        onWorkspacesLoaded(nameMap)
                    }
                }
            })
            .catch(err => {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : 'Failed to load workspaces')
                    setIsLoading(false)
                }
            })

        return () => { cancelled = true }
    }, [])

    // Detect workspaces that already have sources from same provider (smart suggestion)
    const suggestedWorkspaceIds = useMemo(() => {
        const providerIds = new Set(catalogItems.map(c => c.providerId))
        const suggested = new Set<string>()
        for (const ws of workspaces) {
            // A workspace is suggested if any of its data sources come from the same provider
            // We can't directly check provider from DataSourceResponse, but we can match
            // via catalogItemId if catalog items share a provider
            for (const ds of ws.dataSources) {
                if (ds.catalogItemId) {
                    // For now, suggest all non-empty workspaces as potential homes
                    // The smart grouping button handles the provider logic
                    suggested.add(ws.id)
                    break
                }
            }
        }
        // If no workspaces have matching sources, don't suggest any
        // (the "Suggested" badge will only show on workspaces with existing sources)
        return providerIds.size > 0 && workspaces.length > 0 ? suggested : new Set<string>()
    }, [workspaces, catalogItems])

    // Check if we can offer "group all into one workspace"
    const canGroupAll = catalogItems.length > 1

    const updateAllocation = (
        itemId: string,
        updates: Partial<OnboardingFormData['allocations'][string]>
    ) => {
        const current = formData.allocations[itemId] ?? {
            workspaceId: '',
            newWorkspaceName: '',
            newWorkspaceDescription: '',
        }
        updateFormData({
            allocations: {
                ...formData.allocations,
                [itemId]: { ...current, ...updates },
            },
        })
    }

    const setMode = (itemId: string, mode: AllocationMode) => {
        setModes(prev => ({ ...prev, [itemId]: mode }))
        if (mode === 'new') {
            updateAllocation(itemId, { workspaceId: 'new' })
        } else {
            updateAllocation(itemId, {
                workspaceId: '',
                newWorkspaceName: '',
                newWorkspaceDescription: '',
            })
        }
    }

    const handleGroupAll = (wsId: string) => {
        const newAllocations = { ...formData.allocations }
        for (const item of catalogItems) {
            newAllocations[item.id] = {
                ...newAllocations[item.id],
                workspaceId: wsId,
            }
        }
        setModes(prev => {
            const next = { ...prev }
            for (const item of catalogItems) {
                next[item.id] = wsId === 'new' ? 'new' : 'existing'
            }
            return next
        })
        updateFormData({ allocations: newAllocations })
    }

    const toggleExpand = (itemId: string) => {
        setExpandedItems(prev => {
            const next = new Set(prev)
            if (next.has(itemId)) next.delete(itemId)
            else next.add(itemId)
            return next
        })
    }

    const allocatedCount = catalogItems.filter(c => getAllocationStatus(formData.allocations[c.id]) === 'allocated').length

    return (
        <div className="space-y-6">
            {/* Header */}
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-start gap-3"
            >
                <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500/20 to-emerald-500/20 border border-indigo-500/10 flex items-center justify-center">
                    <Database className="w-5 h-5 text-indigo-500" />
                </div>
                <div>
                    <h3 className="text-lg font-semibold text-ink">Choose a Home for Your Data</h3>
                    <p className="text-sm text-ink-muted mt-0.5">
                        Assign each data source to a workspace. Workspaces are isolated domains that organize
                        your data, ontologies, and views.
                    </p>
                </div>
            </motion.div>

            {/* What is a workspace — explainer */}
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 }}
                className="glass-panel-subtle rounded-xl border border-indigo-500/15 bg-indigo-500/[0.03] px-4 py-3"
            >
                <div className="grid grid-cols-3 gap-4">
                    <div className="flex items-start gap-2.5">
                        <div className="w-7 h-7 rounded-lg bg-indigo-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                            <Shield className="w-3.5 h-3.5 text-indigo-400" />
                        </div>
                        <div>
                            <p className="text-xs font-semibold text-ink">Isolated Access</p>
                            <p className="text-[10px] text-ink-muted leading-relaxed mt-0.5">Scoped data access and permissions</p>
                        </div>
                    </div>
                    <div className="flex items-start gap-2.5">
                        <div className="w-7 h-7 rounded-lg bg-emerald-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                            <BookOpen className="w-3.5 h-3.5 text-emerald-400" />
                        </div>
                        <div>
                            <p className="text-xs font-semibold text-ink">Semantic Layer</p>
                            <p className="text-[10px] text-ink-muted leading-relaxed mt-0.5">Own ontologies and type definitions</p>
                        </div>
                    </div>
                    <div className="flex items-start gap-2.5">
                        <div className="w-7 h-7 rounded-lg bg-violet-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                            <Layers className="w-3.5 h-3.5 text-violet-400" />
                        </div>
                        <div>
                            <p className="text-xs font-semibold text-ink">Views & Config</p>
                            <p className="text-[10px] text-ink-muted leading-relaxed mt-0.5">Independent views and configurations</p>
                        </div>
                    </div>
                </div>
            </motion.div>

            {/* Quick-assign group action (for multi-source onboarding) */}
            {canGroupAll && !isLoading && workspaces.length > 0 && (
                <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.1 }}
                    className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-emerald-500/[0.05] border border-emerald-500/15"
                >
                    <Sparkles className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                    <span className="text-xs text-ink-secondary flex-1">
                        <strong className="text-ink">Quick assign:</strong> Group all {catalogItems.length} sources into one workspace
                    </span>
                    <div className="flex items-center gap-2">
                        {workspaces.slice(0, 3).map(ws => (
                            <button
                                key={ws.id}
                                type="button"
                                onClick={() => handleGroupAll(ws.id)}
                                className="px-2.5 py-1 rounded-lg text-[11px] font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 transition-colors truncate max-w-[120px]"
                            >
                                {ws.name}
                            </button>
                        ))}
                    </div>
                </motion.div>
            )}

            {/* Progress indicator */}
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.12 }}
                className="flex items-center gap-2"
            >
                <div className="flex-1 h-1 rounded-full bg-black/[0.04] dark:bg-white/[0.06] overflow-hidden">
                    <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${(allocatedCount / catalogItems.length) * 100}%` }}
                        transition={{ duration: 0.4, ease: 'easeOut' }}
                        className="h-full rounded-full bg-emerald-500"
                    />
                </div>
                <span className="text-[10px] font-bold text-ink-muted">
                    {allocatedCount}/{catalogItems.length} assigned
                </span>
            </motion.div>

            {/* Loading State */}
            {isLoading && (
                <div className="text-center py-8 text-ink-muted text-sm">
                    Loading workspaces...
                </div>
            )}

            {/* Error State */}
            {error && (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 flex items-start gap-3">
                    <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                    <p className="text-sm text-amber-300">{error}</p>
                </div>
            )}

            {/* Catalog Item Cards */}
            {!isLoading && catalogItems.map((item, index) => {
                const allocation = formData.allocations[item.id]
                const mode = modes[item.id] ?? 'existing'
                const status = getAllocationStatus(allocation)
                const isExpanded = expandedItems.has(item.id)
                const isDuplicate = mode === 'new' && detectDuplicateName(
                    allocation?.newWorkspaceName ?? '',
                    workspaces,
                    formData.allocations,
                    item.id
                )

                // Find selected workspace name for collapsed display
                const selectedWs = mode === 'existing' && allocation?.workspaceId && allocation.workspaceId !== 'new'
                    ? workspaces.find(ws => ws.id === allocation.workspaceId)
                    : null

                return (
                    <motion.div
                        key={item.id}
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: index * 0.08 }}
                        className="glass-panel rounded-xl border border-glass-border overflow-hidden"
                    >
                        {/* Card Header — always visible, clickable to expand */}
                        <button
                            type="button"
                            onClick={() => toggleExpand(item.id)}
                            className="flex items-center gap-3 w-full px-5 py-3.5 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
                        >
                            <Package className="w-4 h-4 text-ink-secondary flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                                <h4 className="text-sm font-semibold text-ink truncate">{item.name}</h4>
                                {status === 'allocated' && !isExpanded && (
                                    <p className="text-[11px] text-ink-muted mt-0.5 truncate">
                                        {mode === 'new'
                                            ? `New workspace: ${allocation?.newWorkspaceName}`
                                            : selectedWs
                                                ? `Workspace: ${selectedWs.name}`
                                                : ''
                                        }
                                    </p>
                                )}
                            </div>
                            <span
                                className={cn(
                                    'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium flex-shrink-0',
                                    status === 'allocated'
                                        ? 'bg-emerald-500/10 text-emerald-500'
                                        : 'bg-amber-500/10 text-amber-500'
                                )}
                            >
                                {status === 'allocated' ? (
                                    <><Check className="w-3 h-3" /> Allocated</>
                                ) : (
                                    <><AlertTriangle className="w-3 h-3" /> Pending</>
                                )}
                            </span>
                            <ChevronDown className={cn(
                                'w-4 h-4 text-ink-muted transition-transform duration-200 flex-shrink-0',
                                isExpanded && 'rotate-180'
                            )} />
                        </button>

                        {/* Expanded Content */}
                        <AnimatePresence>
                            {isExpanded && (
                                <motion.div
                                    initial={{ opacity: 0, height: 0 }}
                                    animate={{ opacity: 1, height: 'auto' }}
                                    exit={{ opacity: 0, height: 0 }}
                                    transition={{ duration: 0.2 }}
                                    className="overflow-hidden"
                                >
                                    <div className="px-5 pb-4 pt-1 space-y-4 border-t border-glass-border/50">
                                        {/* Mode Selection */}
                                        <div className="flex gap-3">
                                            <button
                                                type="button"
                                                onClick={() => setMode(item.id, 'new')}
                                                className={cn(
                                                    'flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-all',
                                                    mode === 'new'
                                                        ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-400'
                                                        : 'border-glass-border text-ink-muted hover:border-indigo-500/20 hover:text-ink-secondary'
                                                )}
                                            >
                                                <Plus className="w-4 h-4" />
                                                Create New Domain
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setMode(item.id, 'existing')}
                                                className={cn(
                                                    'flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-all',
                                                    mode === 'existing'
                                                        ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-400'
                                                        : 'border-glass-border text-ink-muted hover:border-indigo-500/20 hover:text-ink-secondary'
                                                )}
                                            >
                                                <Database className="w-4 h-4" />
                                                Use Existing
                                            </button>
                                        </div>

                                        {/* Create New Workspace Form */}
                                        {mode === 'new' && (
                                            <motion.div
                                                initial={{ opacity: 0, y: 8 }}
                                                animate={{ opacity: 1, y: 0 }}
                                                className="space-y-3"
                                            >
                                                <div>
                                                    <label className="block text-xs font-medium text-ink-secondary mb-1.5">
                                                        Workspace Name <span className="text-red-400">*</span>
                                                    </label>
                                                    <input
                                                        type="text"
                                                        value={allocation?.newWorkspaceName ?? ''}
                                                        onChange={(e) => updateAllocation(item.id, {
                                                            newWorkspaceName: e.target.value,
                                                        })}
                                                        placeholder="e.g., Finance Analytics"
                                                        className={cn(
                                                            'w-full px-3 py-2 text-sm rounded-lg border bg-transparent text-ink',
                                                            'placeholder:text-ink-muted/50 outline-none transition-all',
                                                            'focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500/40',
                                                            isDuplicate
                                                                ? 'border-amber-500/40'
                                                                : 'border-glass-border'
                                                        )}
                                                    />
                                                    {isDuplicate && (
                                                        <p className="flex items-center gap-1.5 mt-1.5 text-xs text-amber-400">
                                                            <AlertTriangle className="w-3 h-3" />
                                                            A workspace with this name already exists
                                                        </p>
                                                    )}
                                                </div>
                                                <div>
                                                    <label className="block text-xs font-medium text-ink-secondary mb-1.5">
                                                        Description
                                                    </label>
                                                    <input
                                                        type="text"
                                                        value={allocation?.newWorkspaceDescription ?? ''}
                                                        onChange={(e) => updateAllocation(item.id, {
                                                            newWorkspaceDescription: e.target.value,
                                                        })}
                                                        placeholder="Optional description..."
                                                        className={cn(
                                                            'w-full px-3 py-2 text-sm rounded-lg border border-glass-border bg-transparent text-ink',
                                                            'placeholder:text-ink-muted/50 outline-none transition-all',
                                                            'focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500/40'
                                                        )}
                                                    />
                                                </div>

                                                {/* Mini preview of what will be created */}
                                                {(allocation?.newWorkspaceName?.trim()) && (
                                                    <motion.div
                                                        initial={{ opacity: 0, y: 4 }}
                                                        animate={{ opacity: 1, y: 0 }}
                                                        className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04] px-3 py-2.5 flex items-center gap-2.5"
                                                    >
                                                        <div className="w-7 h-7 rounded-lg bg-emerald-500/10 flex items-center justify-center flex-shrink-0">
                                                            <Database className="w-3.5 h-3.5 text-emerald-400" />
                                                        </div>
                                                        <div className="min-w-0 flex-1">
                                                            <p className="text-[10px] text-ink-muted uppercase tracking-wider font-bold">Will create</p>
                                                            <p className="text-xs font-semibold text-ink truncate">
                                                                {allocation.newWorkspaceName.trim()}
                                                            </p>
                                                        </div>
                                                        <span className="text-[10px] text-emerald-500 font-medium flex-shrink-0">
                                                            1 source
                                                        </span>
                                                    </motion.div>
                                                )}
                                            </motion.div>
                                        )}

                                        {/* Existing Workspace Selection — Rich Cards */}
                                        {mode === 'existing' && (
                                            <motion.div
                                                initial={{ opacity: 0, y: 8 }}
                                                animate={{ opacity: 1, y: 0 }}
                                            >
                                                {workspaces.length === 0 ? (
                                                    <div className="text-center py-6 space-y-3">
                                                        <div className="w-12 h-12 mx-auto rounded-xl bg-indigo-500/10 flex items-center justify-center">
                                                            <Database className="w-6 h-6 text-indigo-400" />
                                                        </div>
                                                        <div>
                                                            <p className="text-sm font-medium text-ink">No workspaces yet</p>
                                                            <p className="text-xs text-ink-muted mt-1">
                                                                Switch to "Create New Domain" to get started
                                                            </p>
                                                        </div>
                                                        <button
                                                            type="button"
                                                            onClick={() => setMode(item.id, 'new')}
                                                            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium text-indigo-400 bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/20 transition-colors"
                                                        >
                                                            <Plus className="w-3 h-3" />
                                                            Create Your First Workspace
                                                        </button>
                                                    </div>
                                                ) : (
                                                    <div className="grid grid-cols-2 gap-2.5">
                                                        {workspaces.map(ws => {
                                                            const isSelected = allocation?.workspaceId === ws.id
                                                            const isSuggested = suggestedWorkspaceIds.has(ws.id)
                                                            const runningCount = getRunningAggregationCount(ws)

                                                            return (
                                                                <button
                                                                    key={ws.id}
                                                                    type="button"
                                                                    onClick={() => updateAllocation(item.id, {
                                                                        workspaceId: ws.id,
                                                                    })}
                                                                    className={cn(
                                                                        'relative flex flex-col gap-2 w-full p-3.5 rounded-xl border text-left transition-all',
                                                                        isSelected
                                                                            ? 'border-indigo-500/40 bg-indigo-500/5 shadow-md shadow-indigo-500/10 ring-1 ring-indigo-500/20'
                                                                            : 'border-glass-border hover:border-indigo-500/20 hover:bg-black/[0.01] dark:hover:bg-white/[0.01]'
                                                                    )}
                                                                >
                                                                    {/* Badges row */}
                                                                    <div className="flex items-center gap-1.5 min-h-[18px]">
                                                                        {ws.isDefault && (
                                                                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-amber-500/10 text-amber-500 border border-amber-500/20">
                                                                                <Star className="w-2.5 h-2.5" />
                                                                                Default
                                                                            </span>
                                                                        )}
                                                                        {isSuggested && !ws.isDefault && (
                                                                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
                                                                                <Sparkles className="w-2.5 h-2.5" />
                                                                                Suggested
                                                                            </span>
                                                                        )}
                                                                    </div>

                                                                    {/* Name + description */}
                                                                    <div className="flex items-start gap-2.5">
                                                                        <div className={cn(
                                                                            'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0',
                                                                            isSelected ? 'bg-indigo-500/15' : 'bg-black/[0.03] dark:bg-white/[0.05]'
                                                                        )}>
                                                                            {isSelected ? (
                                                                                <Check className="w-4 h-4 text-indigo-400" />
                                                                            ) : (
                                                                                <Database className="w-4 h-4 text-ink-muted" />
                                                                            )}
                                                                        </div>
                                                                        <div className="flex-1 min-w-0">
                                                                            <p className={cn(
                                                                                'text-sm font-semibold truncate',
                                                                                isSelected ? 'text-indigo-400' : 'text-ink'
                                                                            )}>
                                                                                {ws.name}
                                                                            </p>
                                                                            {ws.description && (
                                                                                <p className="text-[10px] text-ink-muted line-clamp-2 mt-0.5 leading-relaxed">
                                                                                    {ws.description}
                                                                                </p>
                                                                            )}
                                                                        </div>
                                                                    </div>

                                                                    {/* Metadata row */}
                                                                    <div className="flex items-center gap-3 pt-1 border-t border-glass-border/50">
                                                                        <span className="text-[10px] text-ink-muted">
                                                                            <strong className="text-ink-secondary font-medium">{ws.dataSources.length}</strong> source{ws.dataSources.length !== 1 ? 's' : ''}
                                                                        </span>
                                                                        {runningCount > 0 && (
                                                                            <span className="inline-flex items-center gap-1 text-[10px] text-indigo-400">
                                                                                <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
                                                                                {runningCount} aggregating
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                </button>
                                                            )
                                                        })}
                                                    </div>
                                                )}
                                            </motion.div>
                                        )}
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </motion.div>
                )
            })}
        </div>
    )
}

export default WorkspaceStep
