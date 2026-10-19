/**
 * "Save as template": a Context View's layer arrangement, kept for reuse in one
 * step. The structure travels — names, colours, entity types, rules, logical
 * groups — and the entities this view placed stay behind.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, Save, X } from 'lucide-react'
import { Backdrop } from '@/components/ui/Backdrop'
import { useAppNotifications } from '@/components/ui/notifications'
import { useInvalidateLayoutTemplates } from '@/hooks/useLayoutTemplates'
import { useModalA11y } from '@/hooks/useModalA11y'
import { layoutTemplateService, type TemplateVisibility } from '@/services/layoutTemplateService'
import type { ViewLayerConfig } from '@/types/schema'
import { AudiencePicker } from './AudiencePicker'
import { TemplatePreview } from './TemplatePreview'
import { templateLayers } from './fromView'

export function SaveAsTemplateDialog({ sourceName, description, layers, onClose }: {
    /** The view (or draft) the layers come from — names the new template. */
    sourceName: string
    description?: string | null
    layers: readonly ViewLayerConfig[]
    onClose: () => void
}) {
    const ref = useModalA11y(true, onClose)
    const navigate = useNavigate()
    const { notify } = useAppNotifications()
    const invalidate = useInvalidateLayoutTemplates()
    const kept = useMemo(() => templateLayers(layers), [layers])
    const [name, setName] = useState(`${sourceName} layout`.slice(0, 80))
    const [about, setAbout] = useState(description ?? '')
    const [audience, setAudience] = useState<{ visibility: TemplateVisibility; workspaceId: string | null }>({
        visibility: 'private', workspaceId: null,
    })
    const [saving, setSaving] = useState(false)
    const valid = name.trim().length > 0 && kept.length > 0
        && kept.every(l => l.name?.trim())
        && (audience.visibility !== 'workspace' || !!audience.workspaceId)

    const save = async () => {
        setSaving(true)
        try {
            const created = await layoutTemplateService.create({
                name: name.trim(),
                description: about.trim() || null,
                layers: kept.map((l, i) => ({ ...l, order: i })),
                ...audience,
            })
            void invalidate()
            notify('success', `Saved "${created.name}" to your templates`, {
                label: 'Open', onClick: () => navigate(`/templates/${created.id}`),
            })
            onClose()
        } catch (err) {
            notify('error', (err as Error).message)
        } finally {
            setSaving(false)
        }
    }

    return (
        <>
            <Backdrop open onClick={onClose} zClassName="z-[60]" className="bg-black/50" />
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 pointer-events-none">
                <div
                    ref={ref}
                    role="dialog"
                    aria-modal="true"
                    aria-label="Save layers as a template"
                    tabIndex={-1}
                    className="pointer-events-auto w-full max-w-2xl max-h-[88vh] flex flex-col rounded-2xl bg-canvas-elevated border border-slate-200 dark:border-slate-700 shadow-2xl focus:outline-none"
                >
                    <div className="h-1 rounded-t-2xl bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-500" />
                    <header className="flex items-start gap-3 px-6 pt-5 pb-4 border-b border-slate-200 dark:border-slate-700">
                        <div className="flex-1 min-w-0">
                            <h2 className="text-lg font-bold text-ink">Save as a layout template</h2>
                            <p className="text-xs text-ink-muted mt-0.5">
                                Reuse these {kept.length} layers for new Context Views — yours, your team's, or everyone's.
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label="Close"
                            className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </header>

                    <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
                        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 p-4 bg-black/[0.015] dark:bg-white/[0.02]">
                            <TemplatePreview layers={kept} />
                            <p className="text-[11px] text-ink-muted mt-3">
                                Layer names, colours, entity types, rules and groups come along. The entities placed in this view stay behind.
                            </p>
                        </div>
                        <label className="block">
                            <span className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Name</span>
                            <input
                                autoFocus
                                type="text"
                                value={name}
                                maxLength={80}
                                onChange={e => setName(e.target.value)}
                                className="input border-slate-200 dark:border-slate-700 mt-1.5 h-10 w-full bg-glass-base/40"
                            />
                        </label>
                        <label className="block">
                            <span className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Description</span>
                            <textarea
                                value={about}
                                maxLength={500}
                                rows={2}
                                onChange={e => setAbout(e.target.value)}
                                placeholder="When to use it, and what each layer is for"
                                className="input border-slate-200 dark:border-slate-700 mt-1.5 w-full py-2 bg-glass-base/40 resize-none"
                            />
                        </label>
                        <div>
                            <span className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Who can use it</span>
                            <div className="mt-2">
                                <AudiencePicker visibility={audience.visibility} workspaceId={audience.workspaceId} onChange={setAudience} />
                            </div>
                        </div>
                    </div>

                    <footer className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-200 dark:border-slate-700">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 rounded-xl text-sm font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            disabled={!valid || saving}
                            onClick={() => void save()}
                            className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold bg-gradient-to-r from-indigo-500 to-violet-600 text-white shadow-md disabled:opacity-50 disabled:shadow-none"
                        >
                            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                            Save template
                        </button>
                    </footer>
                </div>
            </div>
        </>
    )
}
