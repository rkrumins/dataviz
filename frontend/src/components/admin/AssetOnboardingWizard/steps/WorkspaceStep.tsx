/**
 * WorkspaceStep - Allocate each catalog item to a workspace
 *
 * Users can create a new workspace or select an existing one for each
 * catalog item being onboarded. Includes duplicate name detection and
 * staggered card animations.
 */

import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Database, Plus, Check, AlertTriangle, Info } from 'lucide-react'
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

    // Check against existing workspaces
    if (existingWorkspaces.some(ws => ws.name.toLowerCase() === lower)) return true

    // Check against other allocations that are creating new workspaces
    for (const [itemId, alloc] of Object.entries(allocations)) {
        if (itemId === currentItemId) continue
        if (alloc.workspaceId === 'new' && alloc.newWorkspaceName.trim().toLowerCase() === lower) {
            return true
        }
    }

    return false
}

// ============================================
// Component
// ============================================

export function WorkspaceStep({ formData, updateFormData, catalogItems }: WorkspaceStepProps) {
    const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

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

    return (
        <div className="space-y-6">
            {/* Header */}
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-start gap-3"
            >
                <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center">
                    <Database className="w-5 h-5 text-indigo-500" />
                </div>
                <div>
                    <h3 className="text-lg font-semibold text-ink">Allocate to Workspace</h3>
                    <p className="text-sm text-ink-muted mt-0.5">
                        Assign each data source to a workspace. You can create new workspaces or use existing ones.
                    </p>
                </div>
            </motion.div>

            {/* Tip Banner */}
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 }}
                className="glass-panel-subtle rounded-xl border border-indigo-500/20 bg-indigo-500/5 px-4 py-3 flex items-start gap-3"
            >
                <Info className="w-4 h-4 text-indigo-400 mt-0.5 flex-shrink-0" />
                <p className="text-sm text-ink-secondary leading-relaxed">
                    Workspaces are isolated domains that scope data access, ontologies, and views.
                    Assets within the same workspace can reference each other, while cross-workspace
                    access requires explicit linking.
                </p>
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
                const isDuplicate = mode === 'new' && detectDuplicateName(
                    allocation?.newWorkspaceName ?? '',
                    workspaces,
                    formData.allocations,
                    item.id
                )

                return (
                    <motion.div
                        key={item.id}
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: index * 0.1 }}
                        className="glass-panel rounded-xl border border-glass-border p-5 space-y-4"
                    >
                        {/* Card Header */}
                        <div className="flex items-center justify-between">
                            <div>
                                <h4 className="text-sm font-semibold text-ink">{item.name}</h4>
                                <p className="text-xs font-mono text-ink-muted mt-0.5">{item.id}</p>
                            </div>
                            <span
                                className={cn(
                                    'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium',
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
                        </div>

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
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                exit={{ opacity: 0, height: 0 }}
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
                            </motion.div>
                        )}

                        {/* Existing Workspace Selection */}
                        {mode === 'existing' && (
                            <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                exit={{ opacity: 0, height: 0 }}
                            >
                                {workspaces.length === 0 ? (
                                    <p className="text-sm text-ink-muted py-2">
                                        No existing workspaces found. Switch to "Create New Domain" to get started.
                                    </p>
                                ) : (
                                    <div className="grid gap-2">
                                        {workspaces.map(ws => {
                                            const isSelected = allocation?.workspaceId === ws.id
                                            return (
                                                <button
                                                    key={ws.id}
                                                    type="button"
                                                    onClick={() => updateAllocation(item.id, {
                                                        workspaceId: ws.id,
                                                    })}
                                                    className={cn(
                                                        'flex items-center gap-3 w-full px-3 py-2.5 rounded-lg border text-left transition-all',
                                                        isSelected
                                                            ? 'border-indigo-500/40 bg-indigo-500/5 shadow-sm shadow-indigo-500/10'
                                                            : 'border-glass-border hover:border-indigo-500/20 hover:bg-indigo-500/[0.02]'
                                                    )}
                                                >
                                                    <div className={cn(
                                                        'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0',
                                                        isSelected ? 'bg-indigo-500/10' : 'bg-white/5'
                                                    )}>
                                                        {isSelected ? (
                                                            <Check className="w-4 h-4 text-indigo-400" />
                                                        ) : (
                                                            <Database className="w-4 h-4 text-ink-muted" />
                                                        )}
                                                    </div>
                                                    <div className="flex-1 min-w-0">
                                                        <p className={cn(
                                                            'text-sm font-medium truncate',
                                                            isSelected ? 'text-indigo-400' : 'text-ink'
                                                        )}>
                                                            {ws.name}
                                                        </p>
                                                        {ws.description && (
                                                            <p className="text-xs text-ink-muted truncate mt-0.5">
                                                                {ws.description}
                                                            </p>
                                                        )}
                                                    </div>
                                                    <span className="text-xs text-ink-muted flex-shrink-0">
                                                        {ws.dataSources.length} source{ws.dataSources.length !== 1 ? 's' : ''}
                                                    </span>
                                                </button>
                                            )
                                        })}
                                    </div>
                                )}
                            </motion.div>
                        )}
                    </motion.div>
                )
            })}
        </div>
    )
}

export default WorkspaceStep
