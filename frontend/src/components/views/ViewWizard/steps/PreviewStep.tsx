/**
 * PreviewStep - Fourth wizard step showing view configuration summary
 * 
 * Beautiful visual summary of what the user has configured
 */


import { motion } from 'framer-motion'
import {
    Layout,
    Layers,
    Network,
    ListTree,
    LayoutTemplate,
    Box,
    GitBranch,
    Check,
    Sparkles,
    Lock,
    Users,
    Globe,
    Tag
} from 'lucide-react'
import { useSchemaStore } from '@/store/schema'
import { useWorkspacesStore } from '@/store/workspaces'
import type { WizardFormData, ScopeContext } from '../ViewWizard'

// ============================================
// Types
// ============================================

interface PreviewStepProps {
    formData: WizardFormData
    /** Resolved scope context — used for workspace/data source display. */
    scopeContext?: ScopeContext
}

// ============================================
// Component
// ============================================

const VISIBILITY_META = {
    private: { label: 'Private', icon: Lock, color: 'slate' },
    workspace: { label: 'Workspace', icon: Users, color: 'blue' },
    enterprise: { label: 'Enterprise', icon: Globe, color: 'green' },
} as const

export function PreviewStep({ formData, scopeContext }: PreviewStepProps) {
    const schema = useSchemaStore(s => s.schema)
    const activeWorkspace = useWorkspacesStore(s => s.getActiveWorkspace())
    const activeDataSource = useWorkspacesStore(s => s.getActiveDataSource())

    // Use scopeContext when provided (create mode), fall back to globals (edit mode)
    const workspaceName = scopeContext?.workspaceName ?? activeWorkspace?.name
    const dataSourceLabel = scopeContext?.dataSourceLabel ?? activeDataSource?.label ?? activeDataSource?.catalogItemId ?? 'Data Source'

    // Get entity type info
    const selectedEntityTypes = formData.visibleEntityTypes
        .map(id => schema?.entityTypes.find(e => e.id === id))
        .filter(Boolean)

    // Get edge type info
    const selectedEdgeTypes = formData.visibleRelationshipTypes
        .map(id => schema?.relationshipTypes.find(r => r.id === id))
        .filter(Boolean)

    const layoutIcon = {
        graph: <Network className="w-6 h-6" />,
        hierarchy: <ListTree className="w-6 h-6" />,
        reference: <LayoutTemplate className="w-6 h-6" />
    }[formData.layoutType]

    const layoutLabel = {
        graph: 'Graph Layout',
        hierarchy: 'Hierarchy Layout',
        reference: 'Reference Model Layout'
    }[formData.layoutType]

    return (
        <div className="max-w-2xl mx-auto space-y-8">
            {/* Header */}
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-center"
            >
                <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 text-sm font-medium mb-4">
                    <Sparkles className="w-4 h-4" />
                    Ready to create
                </div>
                <h3 className="text-2xl font-bold text-slate-900 dark:text-white mb-2">
                    Review your view
                </h3>
                <p className="text-slate-500">
                    Here's a summary of your view configuration
                </p>
            </motion.div>

            {/* Preview Card */}
            <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="bg-gradient-to-br from-slate-50 to-white dark:from-slate-800 dark:to-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden"
            >
                {/* View Header Preview */}
                <div className="p-6 border-b border-slate-200 dark:border-slate-700 bg-gradient-to-r from-blue-500/5 to-indigo-500/5">
                    <div className="flex items-start gap-4">
                        <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white shadow-lg shadow-blue-500/25">
                            <Layout className="w-7 h-7" />
                        </div>
                        <div className="flex-1">
                            <h4 className="text-xl font-bold text-slate-900 dark:text-white">
                                {formData.name || 'Untitled View'}
                            </h4>
                            <p className="text-sm text-slate-500 mt-1">
                                {formData.description || 'No description provided'}
                            </p>
                        </div>
                    </div>
                </div>

                {/* Configuration Sections */}
                <div className="divide-y divide-slate-200 dark:divide-slate-700">
                    {/* Layout Type */}
                    <div className="p-5 flex items-center gap-4">
                        <div className="w-10 h-10 rounded-lg bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center text-purple-600 dark:text-purple-400">
                            {layoutIcon}
                        </div>
                        <div className="flex-1">
                            <p className="text-sm font-medium text-slate-500 uppercase tracking-wide">Layout Type</p>
                            <p className="font-semibold text-slate-800 dark:text-slate-200">{layoutLabel}</p>
                        </div>
                        <Check className="w-5 h-5 text-green-500" />
                    </div>

                    {/* Layers (for Reference Model) */}
                    {formData.layoutType === 'reference' && formData.layers.length > 0 && (
                        <div className="p-5">
                            <div className="flex items-center gap-3 mb-4">
                                <div className="w-10 h-10 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center text-amber-600 dark:text-amber-400">
                                    <Layers className="w-5 h-5" />
                                </div>
                                <div className="flex-1">
                                    <p className="text-sm font-medium text-slate-500 uppercase tracking-wide">Layers</p>
                                    <p className="font-semibold text-slate-800 dark:text-slate-200">{formData.layers.length} layers configured</p>
                                </div>
                            </div>
                            <div className="flex gap-2 flex-wrap">
                                {formData.layers.map(layer => (
                                    <span
                                        key={layer.id}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-full text-sm"
                                    >
                                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: layer.color }} />
                                        {layer.name}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Entity Types */}
                    <div className="p-5">
                        <div className="flex items-center gap-3 mb-4">
                            <div className="w-10 h-10 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-blue-600 dark:text-blue-400">
                                <Box className="w-5 h-5" />
                            </div>
                            <div className="flex-1">
                                <p className="text-sm font-medium text-slate-500 uppercase tracking-wide">Entity Types</p>
                                <p className="font-semibold text-slate-800 dark:text-slate-200">{selectedEntityTypes.length} types included</p>
                            </div>
                        </div>
                        <div className="flex gap-2 flex-wrap">
                            {selectedEntityTypes.slice(0, 8).map(type => (
                                <span
                                    key={type?.id}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-full text-sm"
                                    style={{ borderColor: type?.visual.color + '40' }}
                                >
                                    <Box className="w-3 h-3" style={{ color: type?.visual.color }} />
                                    {type?.name}
                                </span>
                            ))}
                            {selectedEntityTypes.length > 8 && (
                                <span className="px-3 py-1.5 text-sm text-slate-400">
                                    +{selectedEntityTypes.length - 8} more
                                </span>
                            )}
                        </div>
                    </div>

                    {/* Edge Types */}
                    <div className="p-5">
                        <div className="flex items-center gap-3 mb-4">
                            <div className="w-10 h-10 rounded-lg bg-green-100 dark:bg-green-900/30 flex items-center justify-center text-green-600 dark:text-green-400">
                                <GitBranch className="w-5 h-5" />
                            </div>
                            <div className="flex-1">
                                <p className="text-sm font-medium text-slate-500 uppercase tracking-wide">Edge Types</p>
                                <p className="font-semibold text-slate-800 dark:text-slate-200">{selectedEdgeTypes.length} relationship types</p>
                            </div>
                        </div>
                        <div className="flex gap-2 flex-wrap">
                            {selectedEdgeTypes.slice(0, 6).map(type => (
                                <span
                                    key={type?.id}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-full text-sm"
                                >
                                    {type?.name}
                                </span>
                            ))}
                            {selectedEdgeTypes.length > 6 && (
                                <span className="px-3 py-1.5 text-sm text-slate-400">
                                    +{selectedEdgeTypes.length - 6} more
                                </span>
                            )}
                        </div>
                    </div>
                    {/* Sharing & Metadata */}
                    <div className="p-5">
                        <div className="flex items-center gap-3 mb-4">
                            <div className="w-10 h-10 rounded-lg bg-indigo-100 dark:bg-indigo-900/30 flex items-center justify-center text-indigo-600 dark:text-indigo-400">
                                {(() => {
                                    const V = VISIBILITY_META[formData.visibility]
                                    return <V.icon className="w-5 h-5" />
                                })()}
                            </div>
                            <div className="flex-1">
                                <p className="text-sm font-medium text-slate-500 uppercase tracking-wide">Sharing</p>
                                <p className="font-semibold text-slate-800 dark:text-slate-200">
                                    {VISIBILITY_META[formData.visibility].label}
                                </p>
                            </div>
                            <Check className="w-5 h-5 text-green-500" />
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {workspaceName && (
                                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-full text-sm">
                                    <Box className="w-3 h-3 text-slate-400" />
                                    {workspaceName}
                                </span>
                            )}
                            {dataSourceLabel && (
                                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-slate-800 border border-emerald-200 dark:border-emerald-700/50 rounded-full text-sm">
                                    <Box className="w-3 h-3 text-emerald-400" />
                                    {dataSourceLabel}
                                </span>
                            )}
                            {formData.tags.map(tag => (
                                <span
                                    key={tag}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-full text-sm"
                                >
                                    <Tag className="w-3 h-3 text-slate-400" />
                                    {tag}
                                </span>
                            ))}
                        </div>
                    </div>
                </div>
            </motion.div>

            {/* Success Message */}
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
                className="text-center text-slate-500 text-sm"
            >
                Click <strong className="text-slate-700 dark:text-slate-300">"Create View"</strong> to save your new view
            </motion.div>
        </div>
    )
}

export default PreviewStep
