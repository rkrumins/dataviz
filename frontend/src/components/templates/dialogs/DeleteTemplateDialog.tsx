/**
 * DeleteTemplateDialog — soft-delete by default; "permanent" toggle
 * surfaces only after the user confirms once. Workspace-instance counts
 * are explicitly called out so users don't fear orphaning live work
 * (instances are unaffected — they're independent copies after instantiation).
 */
import { useState, useEffect } from 'react'
import { Trash2, AlertTriangle, Loader2 } from 'lucide-react'
import { TemplateDialogShell } from './TemplateDialogShell'
import type { ContextModel } from '@/services/contextModelService'
import { useDeleteTemplate, useTemplateUsage } from '@/hooks/useTemplates'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'

interface DeleteTemplateDialogProps {
    template: ContextModel | null
    isOpen: boolean
    onClose: () => void
    onDeleted?: () => void
}

export function DeleteTemplateDialog({
    template, isOpen, onClose, onDeleted,
}: DeleteTemplateDialogProps) {
    const [confirmText, setConfirmText] = useState('')
    const [permanent, setPermanent] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const deleteMutation = useDeleteTemplate()
    const { showToast } = useToast()
    const usage = useTemplateUsage(template?.id ?? null)

    // Reset form whenever a fresh template is loaded.
    useEffect(() => {
        if (template) {
            setConfirmText('')
            setPermanent(false)
            setError(null)
        }
    }, [template])

    if (!template) return null

    const needsTypeToConfirm = permanent || template.workspaceId == null
    const canDelete = !needsTypeToConfirm || confirmText === template.name
    const instanceCount = usage.data?.instantiationCount ?? template.instantiationCount

    const handleDelete = async () => {
        if (!canDelete || deleteMutation.isPending) return
        setError(null)
        try {
            await deleteMutation.mutateAsync({ id: template.id, permanent })
            showToast('success', permanent
                ? `"${template.name}" permanently deleted.`
                : `"${template.name}" deleted.`)
            onDeleted?.()
            onClose()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Delete failed')
        }
    }

    return (
        <TemplateDialogShell
            isOpen={isOpen}
            onClose={onClose}
            title={permanent ? 'Permanently delete template' : 'Delete template'}
            subtitle={template.name}
            icon={<Trash2 className="w-4 h-4" />}
            accentColor="#ef4444"
            busy={deleteMutation.isPending}
            footer={
                <div className="flex items-center justify-between gap-3">
                    <label className="inline-flex items-center gap-2 text-xs text-ink-muted cursor-pointer">
                        <input
                            type="checkbox"
                            checked={permanent}
                            onChange={(e) => setPermanent(e.target.checked)}
                            disabled={deleteMutation.isPending}
                            className="rounded border-glass-border"
                        />
                        Permanently delete (cannot be restored)
                    </label>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={onClose}
                            disabled={deleteMutation.isPending}
                            className="px-3 py-1.5 text-sm rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleDelete}
                            disabled={!canDelete || deleteMutation.isPending}
                            className={cn(
                                'px-3 py-1.5 text-sm font-medium rounded-lg transition-colors inline-flex items-center gap-1.5',
                                canDelete && !deleteMutation.isPending
                                    ? 'bg-red-500 text-white hover:bg-red-600'
                                    : 'bg-red-500/40 text-white/70 cursor-not-allowed',
                            )}
                        >
                            {deleteMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                            {permanent ? 'Permanently delete' : 'Delete'}
                        </button>
                    </div>
                </div>
            }
        >
            <div className="space-y-3">
                {instanceCount > 0 && (
                    <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                        <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                        <p className="text-xs text-ink leading-relaxed">
                            This template has been used <strong>{instanceCount}</strong> time{instanceCount === 1 ? '' : 's'}.
                            Existing workspace instances are independent copies and will not be affected.
                        </p>
                    </div>
                )}

                <p className="text-sm text-ink-secondary leading-relaxed">
                    {permanent
                        ? 'This will permanently remove the template from the database. This action cannot be undone.'
                        : 'The template will be hidden from the gallery but can be recovered via the API.'}
                </p>

                {needsTypeToConfirm && (
                    <div className="space-y-1.5">
                        <label className="text-xs font-medium text-ink-secondary">
                            Type <span className="font-mono text-ink">{template.name}</span> to confirm
                        </label>
                        <input
                            type="text"
                            value={confirmText}
                            onChange={(e) => setConfirmText(e.target.value)}
                            disabled={deleteMutation.isPending}
                            autoFocus
                            className="w-full px-3 py-2 text-sm rounded-lg bg-canvas border border-glass-border text-ink focus:outline-none focus:border-red-500/50 focus:ring-1 focus:ring-red-500/30"
                            placeholder={template.name}
                        />
                    </div>
                )}

                {error && (
                    <p className="text-xs text-red-500">{error}</p>
                )}
            </div>
        </TemplateDialogShell>
    )
}
