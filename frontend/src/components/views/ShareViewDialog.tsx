/**
 * ShareViewDialog - Share a view via URL and control visibility.
 */

import { useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Link2, Check, Lock, Users, Globe } from 'lucide-react'
import { cn } from '@/lib/utils'
import { updateViewVisibility } from '@/services/viewApiService'

interface ShareViewDialogProps {
    viewId: string
    viewName: string
    currentVisibility: 'private' | 'workspace' | 'enterprise'
    isOpen: boolean
    onClose: () => void
    onVisibilityChange?: (visibility: 'private' | 'workspace' | 'enterprise') => void
}

const VISIBILITY_OPTIONS = [
    {
        id: 'private' as const,
        label: 'Private',
        description: 'Only you can see this view',
        icon: Lock,
    },
    {
        id: 'workspace' as const,
        label: 'Workspace',
        description: 'All members of this workspace can access',
        icon: Users,
    },
    {
        id: 'enterprise' as const,
        label: 'Enterprise',
        description: 'Anyone in the organization can access',
        icon: Globe,
    },
]

export function ShareViewDialog({
    viewId,
    viewName,
    currentVisibility,
    isOpen,
    onClose,
    onVisibilityChange,
}: ShareViewDialogProps) {
    const [visibility, setVisibility] = useState(currentVisibility)
    const [copied, setCopied] = useState(false)
    const [saving, setSaving] = useState(false)

    const shareUrl = `${window.location.origin}/views/${viewId}`

    const handleCopy = useCallback(async () => {
        await navigator.clipboard.writeText(shareUrl)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }, [shareUrl])

    const handleVisibilityChange = useCallback(async (newVisibility: typeof visibility) => {
        setVisibility(newVisibility)
        setSaving(true)
        try {
            await updateViewVisibility(viewId, newVisibility)
            onVisibilityChange?.(newVisibility)
        } catch {
            // Revert on error
            setVisibility(currentVisibility)
        } finally {
            setSaving(false)
        }
    }, [viewId, currentVisibility, onVisibilityChange])

    if (!isOpen) return null

    return (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50"
                onClick={onClose}
            >
                <motion.div
                    initial={{ scale: 0.95, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.95, opacity: 0 }}
                    onClick={(e) => e.stopPropagation()}
                    className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl shadow-lg overflow-hidden"
                >
                    {/* Header */}
                    <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-700">
                        <div>
                            <h3 className="text-lg font-bold text-slate-900 dark:text-white">Share View</h3>
                            <p className="text-sm text-slate-500 truncate">{viewName}</p>
                        </div>
                        <button
                            onClick={onClose}
                            className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                        >
                            <X className="w-5 h-5 text-slate-500" />
                        </button>
                    </div>

                    {/* Share URL */}
                    <div className="px-6 py-4 space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                                Shareable Link
                            </label>
                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    value={shareUrl}
                                    readOnly
                                    className="flex-1 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm text-slate-700 dark:text-slate-300 truncate"
                                />
                                <button
                                    onClick={handleCopy}
                                    className={cn(
                                        'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors duration-150',
                                        copied
                                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                                            : 'bg-blue-600 text-white hover:bg-blue-700'
                                    )}
                                >
                                    {copied ? (
                                        <>
                                            <Check className="w-4 h-4" />
                                            Copied
                                        </>
                                    ) : (
                                        <>
                                            <Link2 className="w-4 h-4" />
                                            Copy
                                        </>
                                    )}
                                </button>
                            </div>
                        </div>

                        {/* Visibility */}
                        <div>
                            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                                Visibility
                            </label>
                            <div className="space-y-2">
                                {VISIBILITY_OPTIONS.map(({ id, label, description, icon: Icon }) => (
                                    <button
                                        key={id}
                                        onClick={() => handleVisibilityChange(id)}
                                        disabled={saving}
                                        className={cn(
                                            'w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 transition-colors duration-150 text-left',
                                            visibility === id
                                                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                                                : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
                                        )}
                                    >
                                        <Icon className={cn(
                                            'w-5 h-5',
                                            visibility === id ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400'
                                        )} />
                                        <div className="flex-1">
                                            <span className={cn(
                                                'text-sm font-medium block',
                                                visibility === id ? 'text-blue-600 dark:text-blue-400' : 'text-slate-700 dark:text-slate-300'
                                            )}>
                                                {label}
                                            </span>
                                            <span className="text-xs text-slate-400">{description}</span>
                                        </div>
                                        {visibility === id && <Check className="w-4 h-4 text-blue-600 dark:text-blue-400" />}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* Footer */}
                    <div className="px-6 py-3 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
                        <p className="text-xs text-slate-400 text-center">
                            {visibility === 'private' && 'Only you can access this view via the link'}
                            {visibility === 'workspace' && 'Workspace members can access this view via the link'}
                            {visibility === 'enterprise' && 'Anyone in your organization can access this view via the link'}
                        </p>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    )
}
