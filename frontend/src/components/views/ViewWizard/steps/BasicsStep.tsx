/**
 * BasicsStep - First wizard step for view name, description, icon
 * 
 * Clean, focused input with smart defaults and suggestions
 */

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { motion } from 'framer-motion'
import { Layout, Network, Layers, BarChart3, GitBranch, Workflow, Database, Box, Sparkles, X, Plus, AlertTriangle, Check, Loader2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { useWorkspacesStore } from '@/store/workspaces'
import { useSchemaStore } from '@/store/schema'
import { checkBlankGraphName } from '@/services/versioningApiService'
import { GRAPH_NAME_RE, slugifyGraphName } from '../blankModel'
import { buildNameSuggestions } from '../nameSuggestions'
import type { WizardFormData, ScopeContext } from '../ViewWizard'
import { VISIBILITY_META, VISIBILITY_ORDER } from '@/types/viewVisibility'

// ============================================
// Types
// ============================================

interface BasicsStepProps {
    formData: WizardFormData
    updateFormData: (updates: Partial<WizardFormData>) => void
    mode: 'create' | 'edit'
    /** Resolved scope context (create: from ScopeStep, edit: from view metadata). */
    scopeContext?: ScopeContext
    /** Callback to go back to ScopeStep (create mode only). */
    onChangeScope?: () => void
    /** Blank models only: scope for the physical graph-name picker + live check. */
    blankNaming?: { workspaceId: string; providerId: string }
}

const ICON_OPTIONS = [
    { id: 'Layout', icon: Layout, label: 'Layout' },
    { id: 'Network', icon: Network, label: 'Network' },
    { id: 'Layers', icon: Layers, label: 'Layers' },
    { id: 'BarChart3', icon: BarChart3, label: 'Chart' },
    { id: 'GitBranch', icon: GitBranch, label: 'Branch' },
    { id: 'Workflow', icon: Workflow, label: 'Workflow' },
    { id: 'Database', icon: Database, label: 'Database' },
    { id: 'Box', icon: Box, label: 'Box' }
]

// Name suggestions are context-catered — built from the resolved scope
// (workspace / data source / ontology) + the schema's root entity types
// via buildNameSuggestions (../nameSuggestions).

// ============================================
// Component
// ============================================

const VISIBILITY_OPTIONS = VISIBILITY_ORDER.map(id => ({
    id,
    label: VISIBILITY_META[id].label,
    description: VISIBILITY_META[id].description,
    icon: VISIBILITY_META[id].icon,
}))

export function BasicsStep({ formData, updateFormData, mode, scopeContext, onChangeScope, blankNaming }: BasicsStepProps) {
    const [showSuggestions, setShowSuggestions] = useState(false)
    const [tagInput, setTagInput] = useState('')
    const navigate = useNavigate()
    const activeWorkspace = useWorkspacesStore(s => s.getActiveWorkspace())
    const activeDataSource = useWorkspacesStore(s => s.getActiveDataSource())
    // Use scopeContext if available (create mode), fall back to globals (edit mode compat)
    const missingOntology = scopeContext ? !scopeContext.hasOntology : !activeDataSource?.ontologyId
    const displayWorkspaceName = scopeContext?.workspaceName ?? activeWorkspace?.name
    const displayDataSourceLabel = scopeContext?.dataSourceLabel ?? activeDataSource?.label ?? activeDataSource?.catalogItemId

    // Context-catered suggestions: scope (workspace / data source / ontology)
    // + root entity types from the schema store — hydrated in BOTH journeys
    // (the blank journey mounts without a SchemaScope/provider, so this must
    // not read useDataSourceSchema/useGraphProvider).
    const schemaEntityTypes = useSchemaStore(s => s.schema?.entityTypes)
    const nameSuggestions = useMemo(() => {
        const scope = scopeContext ?? (displayWorkspaceName || displayDataSourceLabel
            ? { workspaceName: displayWorkspaceName, dataSourceLabel: displayDataSourceLabel ?? undefined }
            : undefined)
        return buildNameSuggestions(scope, schemaEntityTypes ?? [])
    }, [scopeContext, displayWorkspaceName, displayDataSourceLabel, schemaEntityTypes])

    const handleAddTag = useCallback(() => {
        const tag = tagInput.trim()
        if (tag && !formData.tags.includes(tag)) {
            updateFormData({ tags: [...formData.tags, tag] })
        }
        setTagInput('')
    }, [tagInput, formData.tags, updateFormData])

    const handleRemoveTag = useCallback((tag: string) => {
        updateFormData({ tags: formData.tags.filter(t => t !== tag) })
    }, [formData.tags, updateFormData])

    // ── Physical graph name (blank models) ──────────────────────────────────
    //
    // This name IS the FalkorDB key the model is stored under, and a projection
    // seed WIPES that key — so a collision is destructive, not cosmetic. The
    // server refuses to provision onto an existing key (validated under a
    // per-(provider, name) advisory lock, across every workspace, plus a live
    // GRAPH.LIST check), so someone else's data can never be overwritten.
    //
    // What we owe the user on top of that guarantee is not making them solve it:
    // the name is derived from the view name, so two people naming a view "Data
    // Lineage" collide by construction. When the derived name is taken we adopt
    // the server's free alternative (data_lineage → data_lineage_2) automatically
    // and say so. A name the user typed themselves is never silently changed —
    // they get the same alternative as a one-click fix instead.
    const isAutoName = formData.graphNameIsAuto !== false
    const derivedGraphName = slugifyGraphName(formData.name)
    const effectiveGraphName = formData.graphName ?? derivedGraphName

    const [nameCheck, setNameCheck] = useState<
        | { state: 'idle' | 'checking' | 'available' }
        | { state: 'unavailable'; reason: string; suggestion: string | null }
    >({ state: 'idle' })
    /** Set when we auto-moved off a taken name, so the UI can explain itself. */
    const [autoUniquifiedFrom, setAutoUniquifiedFrom] = useState<string | null>(null)
    const checkSeq = useRef(0)

    // Keep the auto-derived name in step with the view name (until the user takes
    // the wheel). Writing it into formData — rather than deriving it at submit —
    // is what lets the uniquified name actually be the one we provision.
    useEffect(() => {
        if (!blankNaming || !isAutoName) return
        if (autoUniquifiedFrom === derivedGraphName) return   // already handled this base
        if (formData.graphName === derivedGraphName) return
        setAutoUniquifiedFrom(null)
        updateFormData({ graphName: derivedGraphName, graphNameAvailable: undefined })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [blankNaming, isAutoName, derivedGraphName])

    useEffect(() => {
        if (!blankNaming) return
        const name = effectiveGraphName
        if (!name || !GRAPH_NAME_RE.test(name)) {
            setNameCheck(name
                ? { state: 'unavailable', reason: "Use 3–64 characters: lowercase letters, numbers, '-' or '_'.", suggestion: null }
                : { state: 'idle' })
            updateFormData({ graphNameAvailable: name ? false : undefined })
            return
        }
        const seq = ++checkSeq.current
        setNameCheck({ state: 'checking' })
        const t = setTimeout(() => {
            checkBlankGraphName(blankNaming.workspaceId, blankNaming.providerId, name)
                .then((res) => {
                    if (checkSeq.current !== seq) return
                    if (res.available) {
                        setNameCheck({ state: 'available' })
                        updateFormData({ graphNameAvailable: true })
                        return
                    }
                    // Taken. If WE picked this name, pick a better one — don't hand
                    // the user an error they didn't cause.
                    if (isAutoName && res.suggestion) {
                        setAutoUniquifiedFrom(name)
                        setNameCheck({ state: 'checking' })
                        updateFormData({ graphName: res.suggestion, graphNameAvailable: undefined })
                        return
                    }
                    setNameCheck({
                        state: 'unavailable',
                        reason: res.reason ?? 'This name is taken.',
                        suggestion: res.suggestion ?? null,
                    })
                    updateFormData({ graphNameAvailable: false })
                })
                .catch(() => {
                    // Check unavailable (offline, transient) — don't block; the
                    // provisioning endpoint re-validates authoritatively.
                    if (checkSeq.current !== seq) return
                    setNameCheck({ state: 'idle' })
                    updateFormData({ graphNameAvailable: undefined })
                })
        }, 400)
        return () => clearTimeout(t)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [blankNaming?.workspaceId, blankNaming?.providerId, effectiveGraphName, isAutoName])

    return (
        <div className="max-w-xl mx-auto space-y-8">
            {/* Introduction */}
            <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.12, ease: 'easeOut' }}
                className="text-center"
            >
                <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 text-sm font-medium mb-4">
                    <Sparkles className="w-4 h-4" />
                    {mode === 'create' ? "Let's create something amazing" : 'Update your view'}
                </div>
                <h3 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">
                    {mode === 'create' ? 'Name your view' : 'Edit view details'}
                </h3>
                <p className="text-slate-500 dark:text-slate-400">
                    Give your view a descriptive name that helps you find it later
                </p>
            </motion.div>

            {/* Scope breadcrumb (shows selected workspace/data source) */}
            {displayWorkspaceName && displayDataSourceLabel && (
                <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.12, ease: 'easeOut' }}
                    className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700"
                >
                    <Database className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                        <span className="font-semibold text-slate-700 dark:text-slate-300">{displayWorkspaceName}</span>
                        {' / '}
                        <span className="font-semibold text-slate-700 dark:text-slate-300">{displayDataSourceLabel}</span>
                    </span>
                    {onChangeScope && (
                        <button
                            type="button"
                            onClick={onChangeScope}
                            className="ml-auto text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
                        >
                            Change
                        </button>
                    )}
                </motion.div>
            )}

            {/* Ontology Warning */}
            {missingOntology && (
                <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.12, ease: 'easeOut' }}
                    className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 flex items-start gap-3"
                >
                    <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                    <div className="flex-1">
                        <p className="text-sm font-medium text-amber-400">Semantic layer not configured</p>
                        <p className="text-xs text-ink-muted mt-1 leading-relaxed">
                            This data source has no ontology assigned. Views created without a semantic
                            layer may have limited entity types and relationship filtering.
                        </p>
                        <button
                            type="button"
                            onClick={() => {
                                const wsId = scopeContext?.workspaceId || activeWorkspace?.id
                                navigate(wsId ? `/workspaces/${wsId}` : '/workspaces')
                            }}
                            className="mt-2 text-xs font-medium text-amber-400 hover:text-amber-300 transition-colors"
                        >
                            Configure Ontology &rarr;
                        </button>
                    </div>
                </motion.div>
            )}

            {/* Name Input */}
            <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.12, ease: 'easeOut' }}
                className="space-y-2"
            >
                <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300">
                    View Name <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                    <input
                        type="text"
                        value={formData.name}
                        onChange={(e) => updateFormData({ name: e.target.value })}
                        onFocus={() => setShowSuggestions(formData.name.length === 0)}
                        onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                        placeholder="e.g., Finance Data Lineage"
                        className="w-full px-4 py-4 text-lg rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-colors duration-150 outline-none"
                        autoFocus
                    />

                    {/* Suggestions Dropdown */}
                    {showSuggestions && (
                        <motion.div
                            initial={{ opacity: 0, y: -10 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="absolute z-10 w-full mt-2 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 shadow-xl overflow-hidden"
                        >
                            <div className="px-4 py-2 text-xs font-medium text-slate-500 uppercase tracking-wide border-b border-slate-100 dark:border-slate-700">
                                Suggestions
                            </div>
                            {nameSuggestions
                                .filter(s => s.toLowerCase() !== formData.name.trim().toLowerCase())
                                .map(suggestion => (
                                <button
                                    key={suggestion}
                                    onClick={() => {
                                        updateFormData({ name: suggestion })
                                        setShowSuggestions(false)
                                    }}
                                    className="w-full px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors text-slate-700 dark:text-slate-300"
                                >
                                    {suggestion}
                                </button>
                            ))}
                        </motion.div>
                    )}
                </div>
                <p className="text-xs text-slate-400">
                    Choose a name that describes what this view shows
                </p>
            </motion.div>

            {/* Description */}
            <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.12, ease: 'easeOut' }}
                className="space-y-2"
            >
                <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300">
                    Description
                </label>
                <textarea
                    value={formData.description}
                    onChange={(e) => updateFormData({ description: e.target.value })}
                    placeholder="Optional: Describe what this view is for..."
                    rows={3}
                    className="w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-colors duration-150 outline-none resize-none"
                />
            </motion.div>

            {/* Storage — blank models pick the PHYSICAL graph name their model lives
                under on the chosen connection. Auto-derived from the model name,
                editable, live-checked for availability. */}
            {blankNaming && (
                <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.12, ease: 'easeOut' }}
                    className="space-y-2"
                >
                    <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300">
                        Graph name
                        {scopeContext?.providerName && (
                            <span className="ml-2 text-xs font-normal text-slate-400">
                                on {scopeContext.providerName}
                            </span>
                        )}
                    </label>
                    <div className={cn(
                        'flex items-center rounded-xl border-2 bg-white dark:bg-slate-800 transition-colors duration-150 overflow-hidden',
                        nameCheck.state === 'unavailable'
                            ? 'border-rose-400 dark:border-rose-500/70'
                            : nameCheck.state === 'available'
                                ? 'border-emerald-400 dark:border-emerald-500/60'
                                : 'border-slate-200 dark:border-slate-700 focus-within:border-blue-500',
                    )}>
                        <Database className="w-4 h-4 ml-4 shrink-0 text-slate-400" />
                        <input
                            type="text"
                            value={effectiveGraphName}
                            onChange={(e) => {
                                setAutoUniquifiedFrom(null)
                                updateFormData({
                                    graphName: e.target.value.toLowerCase(),
                                    graphNameIsAuto: false,
                                    graphNameAvailable: undefined,
                                })
                            }}
                            spellCheck={false}
                            className="flex-1 px-3 py-3 bg-transparent font-mono text-sm outline-none"
                            placeholder="my_lineage_model"
                        />
                        <span className="mr-3 shrink-0">
                            {nameCheck.state === 'checking' && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
                            {nameCheck.state === 'available' && <Check className="w-4 h-4 text-emerald-500" />}
                            {nameCheck.state === 'unavailable' && <AlertTriangle className="w-4 h-4 text-rose-500" />}
                        </span>
                    </div>

                    {nameCheck.state === 'unavailable' ? (
                        <div className="flex items-start gap-1.5 text-xs text-rose-500">
                            <span className="flex-1">{nameCheck.reason}</span>
                            {nameCheck.suggestion && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        setAutoUniquifiedFrom(null)
                                        updateFormData({
                                            graphName: nameCheck.suggestion!,
                                            graphNameIsAuto: false,
                                            graphNameAvailable: undefined,
                                        })
                                    }}
                                    className="shrink-0 font-medium text-blue-500 hover:underline"
                                >
                                    Use {nameCheck.suggestion}
                                </button>
                            )}
                        </div>
                    ) : autoUniquifiedFrom && nameCheck.state === 'available' ? (
                        <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                            <Sparkles className="w-3 h-3 mt-0.5 shrink-0" />
                            <span>
                                <span className="font-mono">{autoUniquifiedFrom}</span> is already taken on this
                                connection, so we picked <span className="font-mono">{effectiveGraphName}</span>.
                                Nothing existing is touched — edit it if you&apos;d rather.
                            </span>
                        </p>
                    ) : (
                        <p className="text-xs text-slate-400 dark:text-slate-500">
                            The graph key your model is stored under — used by anything that
                            queries the graph directly. Pick it once; it can&apos;t be renamed later.
                            {formData.graphNameIsAuto === false && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        setAutoUniquifiedFrom(null)
                                        updateFormData({
                                            graphName: derivedGraphName,
                                            graphNameIsAuto: true,
                                            graphNameAvailable: undefined,
                                        })
                                    }}
                                    className="ml-1.5 text-blue-500 hover:underline"
                                >
                                    Reset to suggestion
                                </button>
                            )}
                        </p>
                    )}
                </motion.div>
            )}

            {/* Icon Selection */}
            <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.12, ease: 'easeOut' }}
                className="space-y-3"
            >
                <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300">
                    Icon
                </label>
                <div className="flex flex-wrap gap-2">
                    {ICON_OPTIONS.map(({ id, icon: Icon, label }) => (
                        <button
                            key={id}
                            onClick={() => updateFormData({ icon: id })}
                            className={cn(
                                'flex items-center gap-2 px-4 py-2.5 rounded-xl border-2 transition-colors duration-150',
                                formData.icon === id
                                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                                    : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 text-slate-600 dark:text-slate-400'
                            )}
                        >
                            <Icon className="w-5 h-5" />
                            <span className="text-sm font-medium">{label}</span>
                        </button>
                    ))}
                </div>
            </motion.div>

            {/* Visibility Selector */}
            <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.12, ease: 'easeOut' }}
                className="space-y-3"
            >
                <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300">
                    Visibility
                </label>
                <div className="grid grid-cols-3 gap-3">
                    {VISIBILITY_OPTIONS.map(({ id, label, description, icon: Icon }) => (
                        <button
                            key={id}
                            onClick={() => updateFormData({ visibility: id })}
                            className={cn(
                                'flex flex-col items-center gap-2 px-4 py-4 rounded-xl border-2 transition-colors duration-150 text-center',
                                formData.visibility === id
                                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                                    : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 text-slate-600 dark:text-slate-400'
                            )}
                        >
                            <Icon className="w-5 h-5" />
                            <span className="text-sm font-medium">{label}</span>
                            <span className="text-2xs text-slate-400">{description}</span>
                        </button>
                    ))}
                </div>
            </motion.div>

            {/* Tags Input */}
            <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.12, ease: 'easeOut' }}
                className="space-y-2"
            >
                <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300">
                    Tags
                </label>
                <div className="flex flex-wrap gap-2 mb-2">
                    {formData.tags.map(tag => (
                        <span
                            key={tag}
                            className="inline-flex items-center gap-1 px-3 py-1 rounded-full bg-slate-100 dark:bg-slate-800 text-sm text-slate-700 dark:text-slate-300"
                        >
                            {tag}
                            <button
                                onClick={() => handleRemoveTag(tag)}
                                className="ml-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </span>
                    ))}
                </div>
                <div className="flex gap-2">
                    <input
                        type="text"
                        value={tagInput}
                        onChange={(e) => setTagInput(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault()
                                handleAddTag()
                            }
                        }}
                        placeholder="Add a tag..."
                        className="flex-1 px-4 py-2.5 rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-colors duration-150 outline-none text-sm"
                    />
                    <button
                        onClick={handleAddTag}
                        disabled={!tagInput.trim()}
                        className={cn(
                            'px-3 py-2.5 rounded-xl border-2 transition-colors duration-150',
                            tagInput.trim()
                                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 hover:bg-blue-100'
                                : 'border-slate-200 dark:border-slate-700 text-slate-400 cursor-not-allowed'
                        )}
                    >
                        <Plus className="w-4 h-4" />
                    </button>
                </div>
                <p className="text-xs text-slate-400">
                    Press Enter to add tags for categorization and discovery
                </p>
            </motion.div>

            {/* Workspace/DataSource context is now shown as a breadcrumb at the top */}

            {/* Validation Message */}
            {formData.name.trim().length === 0 && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="flex items-center gap-2 text-amber-600 dark:text-amber-400 text-sm"
                >
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                    Please enter a name to continue
                </motion.div>
            )}
        </div>
    )
}

export default BasicsStep
