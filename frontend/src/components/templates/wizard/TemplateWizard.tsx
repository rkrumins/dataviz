/**
 * TemplateWizard — multi-step authoring flow for new templates.
 *
 * Step 1: Metadata (name, description, icon, color, etc.)
 * Step 2: Layers (pick preset, then customise)
 * Step 3: Preview & save
 *
 * The wizard intentionally does NOT handle entity-type assignment —
 * templates are workspace-agnostic; assignment happens at instantiation
 * time when the workspace's ontology is available.
 */
import { useState, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { X, ChevronRight, ChevronLeft, Loader2, Check } from 'lucide-react'
import type { ViewLayerConfig } from '@/types/schema'
import type { ContextModel } from '@/services/contextModelService'
import { useCreateTemplate, useUpdateTemplate } from '@/hooks/useTemplates'
import { useToast } from '@/components/ui/toast'
import {
    TemplateMetadataForm,
    EMPTY_METADATA,
    metadataFromTemplate,
    metadataToCreateRequest,
    type TemplateMetadataValue,
} from '../TemplateMetadataForm'
import { TemplateLayerEditor } from './TemplateLayerEditor'
import { TemplateCard } from '../TemplateCard'
import { cn } from '@/lib/utils'

type WizardStep = 'metadata' | 'layers' | 'preview'

const STEPS: { id: WizardStep; label: string }[] = [
    { id: 'metadata', label: 'Details' },
    { id: 'layers',   label: 'Layers' },
    { id: 'preview',  label: 'Review' },
]

interface TemplateWizardProps {
    isOpen: boolean
    onClose: () => void
    /** Optional: when set, the wizard is in "edit" mode for an existing template. */
    editing?: ContextModel | null
    /** Used to scope new templates to a workspace (null = global). */
    activeWorkspaceId: string | null
    onSaved?: (template: ContextModel) => void
}

export function TemplateWizard({
    isOpen, onClose, editing, activeWorkspaceId, onSaved,
}: TemplateWizardProps) {
    const [step, setStep] = useState<WizardStep>('metadata')
    const [metadata, setMetadata] = useState<TemplateMetadataValue>(EMPTY_METADATA)
    const [layers, setLayers] = useState<ViewLayerConfig[]>([])
    const [scope, setScope] = useState<'global' | 'workspace'>(
        activeWorkspaceId ? 'workspace' : 'global',
    )
    const [error, setError] = useState<string | null>(null)

    const createMutation = useCreateTemplate()
    const updateMutation = useUpdateTemplate()
    const { showToast } = useToast()

    // Reset/hydrate state when the wizard opens.
    useEffect(() => {
        if (!isOpen) return
        if (editing) {
            setMetadata(metadataFromTemplate(editing))
            setLayers(editing.layersConfig)
            setScope(editing.workspaceId ? 'workspace' : 'global')
        } else {
            setMetadata(EMPTY_METADATA)
            setLayers([])
            setScope(activeWorkspaceId ? 'workspace' : 'global')
        }
        setStep('metadata')
        setError(null)
    }, [isOpen, editing, activeWorkspaceId])

    const validateStep = useCallback((s: WizardStep): string | null => {
        if (s === 'metadata' && !metadata.name.trim()) return 'Name is required.'
        if (s === 'layers' && layers.length === 0) return 'Add at least one layer.'
        return null
    }, [metadata, layers])

    const goNext = () => {
        const err = validateStep(step)
        if (err) { setError(err); return }
        setError(null)
        const idx = STEPS.findIndex(s => s.id === step)
        if (idx < STEPS.length - 1) setStep(STEPS[idx + 1].id)
    }

    const goBack = () => {
        setError(null)
        const idx = STEPS.findIndex(s => s.id === step)
        if (idx > 0) setStep(STEPS[idx - 1].id)
    }

    const submitting = createMutation.isPending || updateMutation.isPending

    const handleSubmit = async () => {
        // Validate all steps before submitting.
        for (const s of STEPS) {
            const err = validateStep(s.id)
            if (err) { setStep(s.id); setError(err); return }
        }
        try {
            if (editing) {
                const updated = await updateMutation.mutateAsync({
                    id: editing.id,
                    data: {
                        name: metadata.name.trim(),
                        description: metadata.description.trim(),
                        category: metadata.category.trim(),
                        icon: metadata.icon,
                        accentColor: metadata.accentColor,
                        maintainer: metadata.maintainer.trim(),
                        aboutMarkdown: metadata.aboutMarkdown.trim(),
                        tags: metadata.tags,
                        visibility: metadata.visibility,
                        layersConfig: layers,
                    },
                })
                showToast('success', `Saved "${updated.name}".`)
                onSaved?.(updated)
            } else {
                const payload = metadataToCreateRequest(metadata, layers)
                payload.workspaceId = scope === 'workspace' ? activeWorkspaceId : null
                const created = await createMutation.mutateAsync(payload)
                showToast('success', `Created "${created.name}".`)
                onSaved?.(created)
            }
            onClose()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Save failed')
        }
    }

    if (!isOpen) return null

    const stepIdx = STEPS.findIndex(s => s.id === step)
    const previewModel: ContextModel = {
        id: editing?.id ?? 'preview',
        name: metadata.name || 'Untitled template',
        description: metadata.description,
        workspaceId: scope === 'workspace' ? activeWorkspaceId ?? undefined : undefined,
        isTemplate: true,
        category: metadata.category,
        layersConfig: layers,
        instanceAssignments: {},
        isActive: true,
        icon: metadata.icon,
        accentColor: metadata.accentColor,
        maintainer: metadata.maintainer,
        aboutMarkdown: metadata.aboutMarkdown,
        tags: metadata.tags,
        visibility: metadata.visibility,
        isPinned: false,
        instantiationCount: editing?.instantiationCount ?? 0,
        createdAt: editing?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }

    const node = (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/60"
                onClick={() => !submitting && onClose()}
            >
                <motion.div
                    initial={{ scale: 0.96, opacity: 0, y: 8 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    exit={{ scale: 0.96, opacity: 0, y: 8 }}
                    transition={{ type: 'spring', damping: 25, stiffness: 350 }}
                    onClick={(e) => e.stopPropagation()}
                    className="w-full max-w-3xl max-h-[90vh] bg-white dark:bg-slate-900 rounded-2xl shadow-lg shadow-black/20 overflow-hidden flex flex-col"
                >
                    {/* Header */}
                    <div className="px-5 py-4 border-b border-glass-border flex items-center justify-between">
                        <div>
                            <h2 className="text-base font-semibold text-ink">
                                {editing ? 'Edit template' : 'New template'}
                            </h2>
                            <p className="text-xs text-ink-muted mt-0.5">
                                Step {stepIdx + 1} of {STEPS.length} — {STEPS[stepIdx].label}
                            </p>
                        </div>
                        <button
                            onClick={onClose}
                            disabled={submitting}
                            className="w-8 h-8 rounded-md flex items-center justify-center text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink transition-colors disabled:opacity-50"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    {/* Step indicator */}
                    <div className="px-5 pt-4 pb-3">
                        <div className="flex items-center">
                            {STEPS.map((s, i) => {
                                const isDone = i < stepIdx
                                const isCurrent = i === stepIdx
                                return (
                                    <div key={s.id} className="flex items-center flex-1 last:flex-none">
                                        <button
                                            type="button"
                                            onClick={() => i <= stepIdx && setStep(s.id)}
                                            className={cn(
                                                'inline-flex items-center gap-1.5 text-xs font-medium transition-colors',
                                                isCurrent && 'text-accent-lineage',
                                                isDone && 'text-ink hover:text-accent-lineage cursor-pointer',
                                                !isCurrent && !isDone && 'text-ink-muted',
                                            )}
                                        >
                                            <span
                                                className={cn(
                                                    'w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold transition-colors',
                                                    isCurrent && 'bg-accent-lineage text-white',
                                                    isDone && 'bg-accent-lineage/10 text-accent-lineage',
                                                    !isCurrent && !isDone && 'bg-black/5 dark:bg-white/5 text-ink-muted',
                                                )}
                                            >
                                                {isDone ? <Check className="w-2.5 h-2.5" /> : i + 1}
                                            </span>
                                            {s.label}
                                        </button>
                                        {i < STEPS.length - 1 && (
                                            <div className={cn(
                                                'flex-1 h-px mx-3 transition-colors',
                                                isDone ? 'bg-accent-lineage/30' : 'bg-glass-border',
                                            )} />
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    </div>

                    {/* Body */}
                    <div className="flex-1 overflow-y-auto custom-scrollbar px-5 py-4">
                        {step === 'metadata' && (
                            <TemplateMetadataForm
                                value={metadata}
                                onChange={setMetadata}
                                nameError={error && step === 'metadata' && !metadata.name.trim() ? error : null}
                            />
                        )}
                        {step === 'layers' && (
                            <TemplateLayerEditor layers={layers} onChange={setLayers} />
                        )}
                        {step === 'preview' && (
                            <PreviewStep
                                template={previewModel}
                                scope={scope}
                                onScopeChange={setScope}
                                isEdit={!!editing}
                                workspaceAvailable={!!activeWorkspaceId}
                            />
                        )}
                    </div>

                    {/* Footer */}
                    <div className="px-5 py-3 border-t border-glass-border flex items-center justify-between bg-canvas-elevated/30">
                        <div>
                            {error && (
                                <p className="text-xs text-red-500">{error}</p>
                            )}
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={goBack}
                                disabled={stepIdx === 0 || submitting}
                                className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-30"
                            >
                                <ChevronLeft className="w-3.5 h-3.5" />
                                Back
                            </button>
                            {step === 'preview' ? (
                                <button
                                    type="button"
                                    onClick={handleSubmit}
                                    disabled={submitting}
                                    className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-lg bg-accent-lineage text-white hover:bg-accent-lineage/90 transition-colors disabled:opacity-50"
                                >
                                    {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                                    {editing ? 'Save changes' : 'Create template'}
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={goNext}
                                    className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded-lg bg-accent-lineage text-white hover:bg-accent-lineage/90 transition-colors"
                                >
                                    Next
                                    <ChevronRight className="w-3.5 h-3.5" />
                                </button>
                            )}
                        </div>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    )

    return createPortal(node, document.body)
}

function PreviewStep({
    template, scope, onScopeChange, isEdit, workspaceAvailable,
}: {
    template: ContextModel
    scope: 'global' | 'workspace'
    onScopeChange: (s: 'global' | 'workspace') => void
    isEdit: boolean
    workspaceAvailable: boolean
}) {
    return (
        <div className="space-y-4">
            <div>
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-ink-muted mb-2">
                    Card preview
                </h4>
                <div className="max-w-sm">
                    <TemplateCard
                        template={template}
                        onMenuAction={() => { /* no-op in preview */ }}
                        onOpen={() => { /* no-op in preview */ }}
                    />
                </div>
            </div>

            <div>
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-ink-muted mb-2">
                    Layers ({template.layersConfig.length})
                </h4>
                <div className="space-y-1">
                    {template.layersConfig.map(layer => (
                        <div
                            key={layer.id}
                            className="flex items-center gap-2 px-3 py-1.5 rounded border border-glass-border bg-canvas"
                        >
                            <div
                                className="w-2 h-2 rounded-full"
                                style={{ backgroundColor: layer.color ?? '#6366f1' }}
                            />
                            <span className="text-sm text-ink flex-1">{layer.name}</span>
                            {layer.description && (
                                <span className="text-[11px] text-ink-muted truncate">{layer.description}</span>
                            )}
                        </div>
                    ))}
                </div>
            </div>

            {!isEdit && (
                <div>
                    <h4 className="text-[10px] font-bold uppercase tracking-wider text-ink-muted mb-2">
                        Save as
                    </h4>
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            type="button"
                            onClick={() => onScopeChange('workspace')}
                            disabled={!workspaceAvailable}
                            className={cn(
                                'p-3 rounded-lg border text-sm text-left transition-all',
                                scope === 'workspace'
                                    ? 'border-accent-lineage bg-accent-lineage/5 text-ink'
                                    : 'border-glass-border text-ink-secondary hover:border-accent-lineage/40',
                                !workspaceAvailable && 'opacity-40 cursor-not-allowed',
                            )}
                        >
                            <div className="font-medium">Workspace template</div>
                            <div className="text-[11px] text-ink-muted mt-0.5">
                                {workspaceAvailable
                                    ? 'Visible only in the current workspace'
                                    : 'Select a workspace first'}
                            </div>
                        </button>
                        <button
                            type="button"
                            onClick={() => onScopeChange('global')}
                            className={cn(
                                'p-3 rounded-lg border text-sm text-left transition-all',
                                scope === 'global'
                                    ? 'border-accent-lineage bg-accent-lineage/5 text-ink'
                                    : 'border-glass-border text-ink-secondary hover:border-accent-lineage/40',
                            )}
                        >
                            <div className="font-medium">Global template</div>
                            <div className="text-[11px] text-ink-muted mt-0.5">
                                Visible across all workspaces
                            </div>
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}
