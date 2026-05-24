/**
 * DuplicateTemplateDialog — clones a template into a new one,
 * optionally scoping the copy to the active workspace.
 */
import { useState, useEffect } from 'react'
import { Copy, Loader2, Globe2, Building2 } from 'lucide-react'
import { TemplateDialogShell } from './TemplateDialogShell'
import type { ContextModel } from '@/services/contextModelService'
import { useDuplicateTemplate } from '@/hooks/useTemplates'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'

interface DuplicateTemplateDialogProps {
    template: ContextModel | null
    isOpen: boolean
    onClose: () => void
    activeWorkspaceId: string | null
    onDuplicated?: (created: ContextModel) => void
}

export function DuplicateTemplateDialog({
    template, isOpen, onClose, activeWorkspaceId, onDuplicated,
}: DuplicateTemplateDialogProps) {
    const [name, setName] = useState('')
    const [scope, setScope] = useState<'global' | 'workspace'>('workspace')
    const [error, setError] = useState<string | null>(null)
    const mutation = useDuplicateTemplate()
    const { showToast } = useToast()

    useEffect(() => {
        if (template) {
            setName(`${template.name} (Copy)`)
            setScope(activeWorkspaceId ? 'workspace' : 'global')
            setError(null)
        }
    }, [template, activeWorkspaceId])

    if (!template) return null

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!name.trim() || mutation.isPending) return
        setError(null)
        try {
            const workspaceId = scope === 'workspace' ? activeWorkspaceId : null
            const created = await mutation.mutateAsync({
                id: template.id,
                name: name.trim(),
                workspaceId,
            })
            showToast('success', `Duplicated "${template.name}".`)
            onDuplicated?.(created)
            onClose()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Duplicate failed')
        }
    }

    return (
        <TemplateDialogShell
            isOpen={isOpen}
            onClose={onClose}
            title="Duplicate template"
            subtitle={`Cloning "${template.name}"`}
            icon={<Copy className="w-4 h-4" />}
            accentColor={template.accentColor ?? '#6366f1'}
            busy={mutation.isPending}
            footer={
                <div className="flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={mutation.isPending}
                        className="px-3 py-1.5 text-sm rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        form="dup-tpl-form"
                        disabled={!name.trim() || mutation.isPending}
                        className={cn(
                            'px-3 py-1.5 text-sm font-medium rounded-lg transition-colors inline-flex items-center gap-1.5',
                            name.trim() && !mutation.isPending
                                ? 'bg-accent-lineage text-white hover:bg-accent-lineage/90'
                                : 'bg-accent-lineage/40 text-white/70 cursor-not-allowed',
                        )}
                    >
                        {mutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        Duplicate
                    </button>
                </div>
            }
        >
            <form id="dup-tpl-form" onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-1.5">
                    <label className="text-xs font-medium text-ink-secondary">Name</label>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        autoFocus
                        className="w-full px-3 py-2 text-sm rounded-lg bg-canvas border border-glass-border text-ink focus:outline-none focus:border-accent-lineage/50 focus:ring-1 focus:ring-accent-lineage/30"
                    />
                </div>

                <div className="space-y-1.5">
                    <label className="text-xs font-medium text-ink-secondary">Scope</label>
                    <div className="grid grid-cols-2 gap-2">
                        <ScopeOption
                            active={scope === 'workspace'}
                            disabled={!activeWorkspaceId}
                            onClick={() => setScope('workspace')}
                            icon={Building2}
                            title="Workspace"
                            description={activeWorkspaceId
                                ? 'Visible only in the current workspace'
                                : 'Select a workspace first'}
                        />
                        <ScopeOption
                            active={scope === 'global'}
                            onClick={() => setScope('global')}
                            icon={Globe2}
                            title="Global"
                            description="Visible across all workspaces"
                        />
                    </div>
                </div>

                {error && <p className="text-xs text-red-500">{error}</p>}
            </form>
        </TemplateDialogShell>
    )
}

function ScopeOption({
    active, disabled, onClick, icon: Icon, title, description,
}: {
    active: boolean
    disabled?: boolean
    onClick: () => void
    icon: React.ComponentType<{ className?: string }>
    title: string
    description: string
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={cn(
                'flex items-start gap-2.5 p-3 rounded-lg border transition-all text-left',
                active
                    ? 'border-accent-lineage bg-accent-lineage/5'
                    : 'border-glass-border hover:border-accent-lineage/40',
                disabled && 'opacity-40 cursor-not-allowed',
            )}
        >
            <Icon className={cn(
                'w-4 h-4 mt-0.5 shrink-0',
                active ? 'text-accent-lineage' : 'text-ink-muted',
            )} />
            <div>
                <div className="text-sm font-medium text-ink">{title}</div>
                <div className="text-[11px] text-ink-muted leading-snug mt-0.5">{description}</div>
            </div>
        </button>
    )
}
