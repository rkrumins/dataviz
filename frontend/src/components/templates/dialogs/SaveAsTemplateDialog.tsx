/**
 * SaveAsTemplateDialog — capture the current canvas state as a new template.
 *
 * Surfaced from the canvas header and from the gallery's "Save current
 * canvas" create-menu flow. Pre-fills the layer configuration from the
 * caller and only asks for identity (name, scope, icon, color).
 */
import { useState, useEffect } from 'react'
import { LayoutTemplate, Loader2, Globe2, Building2 } from 'lucide-react'
import { TemplateDialogShell } from './TemplateDialogShell'
import { IconPicker } from '../IconPicker'
import { ColorPicker } from '../ColorPicker'
import type { ViewLayerConfig } from '@/types/schema'
import { useCreateTemplate } from '@/hooks/useTemplates'
import { useToast } from '@/components/ui/toast'
import type { ContextModel } from '@/services/contextModelService'
import { cn } from '@/lib/utils'

interface SaveAsTemplateDialogProps {
    isOpen: boolean
    onClose: () => void
    layers: ViewLayerConfig[]
    activeWorkspaceId: string | null
    /** Pre-fill the name (e.g. "<canvas name> Template"). */
    defaultName?: string
    /** Pre-fill the description from the source canvas. */
    defaultDescription?: string
    onSaved?: (created: ContextModel) => void
}

export function SaveAsTemplateDialog({
    isOpen, onClose, layers, activeWorkspaceId,
    defaultName = '', defaultDescription = '', onSaved,
}: SaveAsTemplateDialogProps) {
    const [name, setName] = useState(defaultName)
    const [description, setDescription] = useState(defaultDescription)
    const [scope, setScope] = useState<'global' | 'workspace'>(
        activeWorkspaceId ? 'workspace' : 'global'
    )
    const [icon, setIcon] = useState('LayoutTemplate')
    const [accentColor, setAccentColor] = useState('#a855f7')
    const [error, setError] = useState<string | null>(null)
    const mutation = useCreateTemplate()
    const { showToast } = useToast()

    useEffect(() => {
        if (isOpen) {
            setName(defaultName)
            setDescription(defaultDescription)
            setScope(activeWorkspaceId ? 'workspace' : 'global')
            setIcon('LayoutTemplate')
            setAccentColor('#a855f7')
            setError(null)
        }
    }, [isOpen, defaultName, defaultDescription, activeWorkspaceId])

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!name.trim() || mutation.isPending) return
        if (!layers.length) {
            setError('Add at least one layer before saving as a template.')
            return
        }
        setError(null)
        try {
            const created = await mutation.mutateAsync({
                name: name.trim(),
                description: description.trim() || undefined,
                isTemplate: true,
                icon,
                accentColor,
                layersConfig: layers,
                workspaceId: scope === 'workspace' ? activeWorkspaceId : null,
                visibility: scope === 'workspace' ? 'workspace' : 'enterprise',
            })
            showToast('success', `Saved "${created.name}" as a template.`)
            onSaved?.(created)
            onClose()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Save failed')
        }
    }

    return (
        <TemplateDialogShell
            isOpen={isOpen}
            onClose={onClose}
            title="Save as Template"
            subtitle="Reuse this canvas as a starting point for new workspaces."
            icon={<LayoutTemplate className="w-4 h-4" />}
            accentColor={accentColor}
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
                        form="save-as-tpl-form"
                        disabled={!name.trim() || mutation.isPending}
                        className={cn(
                            'px-3 py-1.5 text-sm font-medium rounded-lg transition-colors inline-flex items-center gap-1.5 text-white',
                            name.trim() && !mutation.isPending
                                ? 'hover:opacity-90'
                                : 'opacity-50 cursor-not-allowed',
                        )}
                        style={{ backgroundColor: accentColor }}
                    >
                        {mutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        Save template
                    </button>
                </div>
            }
        >
            <form id="save-as-tpl-form" onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-1.5">
                    <label className="text-xs font-medium text-ink-secondary">Name</label>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        autoFocus
                        placeholder="e.g. Customer 360 Blueprint"
                        className="w-full px-3 py-2 text-sm rounded-lg bg-canvas border border-glass-border text-ink focus:outline-none focus:border-accent-lineage/50 focus:ring-1 focus:ring-accent-lineage/30"
                    />
                </div>

                <div className="space-y-1.5">
                    <label className="text-xs font-medium text-ink-secondary">Description</label>
                    <input
                        type="text"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="One-line summary shown on the gallery card"
                        className="w-full px-3 py-2 text-sm rounded-lg bg-canvas border border-glass-border text-ink focus:outline-none focus:border-accent-lineage/50 focus:ring-1 focus:ring-accent-lineage/30"
                    />
                </div>

                <div className="grid grid-cols-[1fr,auto] gap-3 items-start">
                    <div className="space-y-1.5">
                        <label className="text-xs font-medium text-ink-secondary">Icon</label>
                        <IconPicker value={icon} onChange={setIcon} accentColor={accentColor} />
                    </div>
                    <div className="space-y-1.5">
                        <label className="text-xs font-medium text-ink-secondary">Accent</label>
                        <ColorPicker value={accentColor} onChange={setAccentColor} />
                    </div>
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
                                : 'Switch into a workspace first'}
                        />
                        <ScopeOption
                            active={scope === 'global'}
                            onClick={() => setScope('global')}
                            icon={Globe2}
                            title="Global"
                            description="Available across all workspaces"
                        />
                    </div>
                </div>

                <div className="text-[11px] text-ink-muted px-1">
                    Capturing <span className="font-semibold text-ink">{layers.length}</span> layer{layers.length === 1 ? '' : 's'} from the active canvas.
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
