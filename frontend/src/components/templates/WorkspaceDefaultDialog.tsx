/**
 * Make a template the layout new views start from in a workspace — for the
 * workspaces this person administers and every member there can use it in
 * (`canBeWorkspaceDefault`). One default per workspace: choosing this replaces
 * whatever started new views there before; switching it off clears it.
 */
import { useState } from 'react'
import { Home, Loader2, X } from 'lucide-react'
import { Backdrop } from '@/components/ui/Backdrop'
import { useAppNotifications } from '@/components/ui/notifications'
import { useInvalidateLayoutTemplates } from '@/hooks/useLayoutTemplates'
import { useModalA11y } from '@/hooks/useModalA11y'
import { cn } from '@/lib/utils'
import type { LayoutTemplate } from '@/services/layoutTemplateService'
import { workspaceService, type WorkspaceResponse } from '@/services/workspaceService'
import { useWorkspacesStore } from '@/store/workspaces'

export function WorkspaceDefaultDialog({ template, workspaces, onClose }: {
    template: LayoutTemplate
    /** The workspaces the caller may set it for. */
    workspaces: readonly WorkspaceResponse[]
    onClose: () => void
}) {
    const ref = useModalA11y(true, onClose)
    const { notify } = useAppNotifications()
    const invalidate = useInvalidateLayoutTemplates()
    const updateWorkspace = useWorkspacesStore(s => s.updateWorkspace)
    const [busy, setBusy] = useState<string | null>(null)

    const toggle = async (ws: WorkspaceResponse, on: boolean) => {
        setBusy(ws.id)
        try {
            const saved = await workspaceService.update(ws.id, { defaultLayoutTemplateId: on ? template.id : '' })
            // The update answers without member counts: keep the store's, change only this.
            updateWorkspace({ ...ws, defaultLayoutTemplateId: saved.defaultLayoutTemplateId ?? null })
            notify('success', on
                ? `New views in ${ws.name} start from "${template.name}"`
                : `New views in ${ws.name} start from the suggestions again`)
            void invalidate()
        } catch (err) {
            notify('error', (err as Error).message)
        } finally {
            setBusy(null)
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
                    aria-label={`Workspace default: ${template.name}`}
                    tabIndex={-1}
                    className="pointer-events-auto w-full max-w-md rounded-2xl bg-canvas-elevated border border-slate-200 dark:border-slate-700 shadow-2xl focus:outline-none"
                >
                    <div className="h-1 rounded-t-2xl bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500" />
                    <header className="flex items-start gap-3 px-6 pt-5 pb-3">
                        <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 flex items-center justify-center shrink-0">
                            <Home className="w-5 h-5" aria-hidden />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h2 className="text-lg font-bold text-ink">Start new views from “{template.name}”</h2>
                            <p className="text-xs text-ink-muted mt-0.5">
                                The view wizard opens with its layers in these workspaces. People can still choose another.
                            </p>
                        </div>
                        <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5">
                            <X className="w-4 h-4" />
                        </button>
                    </header>
                    <ul className="px-6 pb-5 space-y-2">
                        {workspaces.map(ws => {
                            const on = ws.defaultLayoutTemplateId === template.id
                            const replaces = !on && !!ws.defaultLayoutTemplateId
                            return (
                                <li key={ws.id} className="flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700 px-3.5 py-2.5">
                                    <span className="flex-1 min-w-0">
                                        <span className="block text-sm font-semibold text-ink truncate">{ws.name}</span>
                                        <span className="block text-[11px] text-ink-muted">
                                            {on ? 'New views start from it' : replaces ? 'Replaces its current default' : 'No default yet'}
                                        </span>
                                    </span>
                                    {busy === ws.id && <Loader2 className="w-4 h-4 animate-spin text-ink-muted" />}
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={on}
                                        aria-label={`Default in ${ws.name}`}
                                        disabled={busy !== null}
                                        onClick={() => void toggle(ws, !on)}
                                        className={cn(
                                            'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50',
                                            on ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600',
                                        )}
                                    >
                                        <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform', on ? 'translate-x-4' : 'translate-x-0.5')} />
                                    </button>
                                </li>
                            )
                        })}
                    </ul>
                </div>
            </div>
        </>
    )
}
