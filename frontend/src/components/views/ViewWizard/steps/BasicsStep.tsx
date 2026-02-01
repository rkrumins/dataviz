/**
 * BasicsStep - First wizard step for view name, description, icon
 * 
 * Clean, focused input with smart defaults and suggestions
 */

import { useState } from 'react'
import { motion } from 'framer-motion'
import {
    Layout,
    Network,
    Layers,
    BarChart3,
    GitBranch,
    Workflow,
    Database,
    Box,
    Sparkles
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WizardFormData } from '../ViewWizard'

// ============================================
// Types
// ============================================

interface BasicsStepProps {
    formData: WizardFormData
    updateFormData: (updates: Partial<WizardFormData>) => void
    mode: 'create' | 'edit'
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

const NAME_SUGGESTIONS = [
    'Data Lineage',
    'Impact Analysis',
    'Data Pipeline',
    'Domain Overview',
    'Source to Target',
    'Medallion Architecture'
]

// ============================================
// Component
// ============================================

export function BasicsStep({ formData, updateFormData, mode }: BasicsStepProps) {
    const [showSuggestions, setShowSuggestions] = useState(false)

    return (
        <div className="max-w-xl mx-auto space-y-8">
            {/* Introduction */}
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
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

            {/* Name Input */}
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
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
                        className="w-full px-4 py-4 text-lg rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all outline-none"
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
                            {NAME_SUGGESTIONS.map(suggestion => (
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
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
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
                    className="w-full px-4 py-3 rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all outline-none resize-none"
                />
            </motion.div>

            {/* Icon Selection */}
            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.4 }}
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
                                'flex items-center gap-2 px-4 py-2.5 rounded-xl border-2 transition-all',
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
