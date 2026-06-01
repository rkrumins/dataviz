/**
 * ImportTemplateDialog — paste or drop a JSON file to create a template.
 *
 * Validates the payload shape client-side before hitting the API.
 * Accepts both the full `ContextModel` shape (an exported template) and the
 * `ContextModelCreateRequest` shape (a hand-authored payload) by mapping
 * the relevant subset.
 */
import { useState, useRef } from 'react'
import { Upload, FileJson, Loader2, AlertCircle, Globe2, Building2 } from 'lucide-react'
import { TemplateDialogShell } from './TemplateDialogShell'
import { useImportTemplate } from '@/hooks/useTemplates'
import { useToast } from '@/components/ui/toast'
import type { ContextModel, ContextModelCreateRequest } from '@/services/contextModelService'
import { cn } from '@/lib/utils'

interface ImportTemplateDialogProps {
    isOpen: boolean
    onClose: () => void
    activeWorkspaceId: string | null
    onImported?: (created: ContextModel) => void
}

function parsePayload(text: string): ContextModelCreateRequest {
    const raw = JSON.parse(text)
    if (typeof raw !== 'object' || raw == null) {
        throw new Error('Payload must be a JSON object.')
    }
    if (typeof raw.name !== 'string' || raw.name.trim() === '') {
        throw new Error('Template payload is missing a "name".')
    }
    if (!Array.isArray(raw.layersConfig)) {
        throw new Error('Template payload is missing "layersConfig" array.')
    }
    return {
        name: String(raw.name),
        description: raw.description ?? undefined,
        category: raw.category ?? undefined,
        layersConfig: raw.layersConfig,
        scopeFilter: raw.scopeFilter ?? undefined,
        scopeEdgeConfig: raw.scopeEdgeConfig ?? undefined,
        instanceAssignments: raw.instanceAssignments ?? {},
        icon: raw.icon ?? undefined,
        accentColor: raw.accentColor ?? undefined,
        maintainer: raw.maintainer ?? undefined,
        aboutMarkdown: raw.aboutMarkdown ?? undefined,
        tags: Array.isArray(raw.tags) ? raw.tags : undefined,
        visibility: raw.visibility ?? undefined,
        isTemplate: true,
    }
}

export function ImportTemplateDialog({
    isOpen, onClose, activeWorkspaceId, onImported,
}: ImportTemplateDialogProps) {
    const [text, setText] = useState('')
    const [scope, setScope] = useState<'global' | 'workspace'>(
        activeWorkspaceId ? 'workspace' : 'global',
    )
    const [error, setError] = useState<string | null>(null)
    const [isDragging, setIsDragging] = useState(false)
    const fileRef = useRef<HTMLInputElement>(null)
    const mutation = useImportTemplate()
    const { showToast } = useToast()

    const reset = () => {
        setText('')
        setError(null)
        setIsDragging(false)
    }

    const handleClose = () => {
        if (mutation.isPending) return
        reset()
        onClose()
    }

    const handleFile = async (file: File) => {
        setError(null)
        if (!file.name.toLowerCase().endsWith('.json')) {
            setError('Please drop a .json file.')
            return
        }
        try {
            const content = await file.text()
            setText(content)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to read file')
        }
    }

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (mutation.isPending) return
        setError(null)
        try {
            const payload = parsePayload(text)
            if (scope === 'workspace' && activeWorkspaceId) {
                payload.workspaceId = activeWorkspaceId
            } else {
                payload.workspaceId = null
            }
            const created = await mutation.mutateAsync(payload)
            showToast('success', `Imported "${created.name}".`)
            onImported?.(created)
            reset()
            onClose()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Invalid JSON payload')
        }
    }

    return (
        <TemplateDialogShell
            isOpen={isOpen}
            onClose={handleClose}
            title="Import template"
            subtitle="Paste a JSON payload or drop an exported file"
            icon={<Upload className="w-4 h-4" />}
            accentColor="#6366f1"
            busy={mutation.isPending}
            size="lg"
            footer={
                <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-1.5 text-xs text-ink-muted">
                        {scope === 'global' ? <Globe2 className="w-3 h-3" /> : <Building2 className="w-3 h-3" />}
                        <span>Will create a {scope} template</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={handleClose}
                            disabled={mutation.isPending}
                            className="px-3 py-1.5 text-sm rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            form="import-tpl-form"
                            disabled={!text.trim() || mutation.isPending}
                            className={cn(
                                'px-3 py-1.5 text-sm font-medium rounded-lg transition-colors inline-flex items-center gap-1.5',
                                text.trim() && !mutation.isPending
                                    ? 'bg-accent-lineage text-white hover:bg-accent-lineage/90'
                                    : 'bg-accent-lineage/40 text-white/70 cursor-not-allowed',
                            )}
                        >
                            {mutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                            Import
                        </button>
                    </div>
                </div>
            }
        >
            <form id="import-tpl-form" onSubmit={handleSubmit} className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                    <button
                        type="button"
                        onClick={() => setScope('workspace')}
                        disabled={!activeWorkspaceId}
                        className={cn(
                            'flex items-center gap-2 p-2.5 rounded-lg border text-sm transition-all',
                            scope === 'workspace'
                                ? 'border-accent-lineage bg-accent-lineage/5 text-accent-lineage'
                                : 'border-glass-border text-ink-muted hover:text-ink',
                            !activeWorkspaceId && 'opacity-40 cursor-not-allowed',
                        )}
                    >
                        <Building2 className="w-4 h-4" />
                        Workspace
                    </button>
                    <button
                        type="button"
                        onClick={() => setScope('global')}
                        className={cn(
                            'flex items-center gap-2 p-2.5 rounded-lg border text-sm transition-all',
                            scope === 'global'
                                ? 'border-accent-lineage bg-accent-lineage/5 text-accent-lineage'
                                : 'border-glass-border text-ink-muted hover:text-ink',
                        )}
                    >
                        <Globe2 className="w-4 h-4" />
                        Global
                    </button>
                </div>

                <div
                    onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={(e) => {
                        e.preventDefault()
                        setIsDragging(false)
                        const file = e.dataTransfer.files?.[0]
                        if (file) void handleFile(file)
                    }}
                    onClick={() => fileRef.current?.click()}
                    className={cn(
                        'flex items-center justify-center gap-2 p-4 rounded-lg border-2 border-dashed cursor-pointer transition-all',
                        isDragging
                            ? 'border-accent-lineage bg-accent-lineage/5'
                            : 'border-glass-border hover:border-accent-lineage/40',
                    )}
                >
                    <FileJson className="w-4 h-4 text-ink-muted" />
                    <span className="text-sm text-ink-secondary">
                        Drop a .json file here or click to browse
                    </span>
                    <input
                        ref={fileRef}
                        type="file"
                        accept=".json,application/json"
                        className="hidden"
                        onChange={(e) => {
                            const file = e.target.files?.[0]
                            if (file) void handleFile(file)
                            e.target.value = ''
                        }}
                    />
                </div>

                <div className="space-y-1.5">
                    <label className="text-xs font-medium text-ink-secondary">
                        JSON payload
                    </label>
                    <textarea
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        rows={10}
                        placeholder='{ "name": "...", "layersConfig": [...] }'
                        className="w-full px-3 py-2 text-xs font-mono rounded-lg bg-canvas border border-glass-border text-ink focus:outline-none focus:border-accent-lineage/50 focus:ring-1 focus:ring-accent-lineage/30 resize-none custom-scrollbar"
                    />
                </div>

                {error && (
                    <div className="flex items-start gap-2 p-2.5 rounded-lg bg-red-500/10 border border-red-500/20">
                        <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                        <p className="text-xs text-red-500">{error}</p>
                    </div>
                )}
            </form>
        </TemplateDialogShell>
    )
}
