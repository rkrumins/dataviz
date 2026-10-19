/**
 * Who can use a template: its audience (saved on every choice) and the people
 * and teams it is shared with. A share to a group is how a team gets its own
 * templates — every member finds it under "Shared with me", and is told.
 *
 * Organization templates are everyone's already, so they take no shares; a
 * template manager can still move one to a narrower audience.
 */
import { useCallback, useEffect, useState } from 'react'
import { Eye, Loader2, Pencil, Trash2, UserPlus, Users2, X } from 'lucide-react'
import { Backdrop } from '@/components/ui/Backdrop'
import { HoverTip } from '@/components/ui/HoverTip'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { useAppNotifications } from '@/components/ui/notifications'
import { AddGrantPicker } from '@/components/views/ShareViewDialog'
import { useInvalidateLayoutTemplates } from '@/hooks/useLayoutTemplates'
import { useModalA11y } from '@/hooks/useModalA11y'
import { cn } from '@/lib/utils'
import { layoutTemplateService, type LayoutTemplate, type TemplateVisibility } from '@/services/layoutTemplateService'
import type { ViewGrantResponse } from '@/services/viewGrantsService'
import { AudiencePicker } from './AudiencePicker'

/** The picker's words (`AddGrantPicker`), so a share reads the same before and after it is made. */
const ROLES = [
    { id: 'viewer', label: 'Viewer', icon: Eye },
    { id: 'editor', label: 'Editor', icon: Pencil },
] as const

export function ShareTemplateDialog({ template, onClose, onChanged }: {
    template: LayoutTemplate
    onClose: () => void
    onChanged?: (template: LayoutTemplate) => void
}) {
    const ref = useModalA11y(true, onClose)
    const { notify } = useAppNotifications()
    const invalidate = useInvalidateLayoutTemplates()
    const [current, setCurrent] = useState(template)
    const [moving, setMoving] = useState(false)
    const [grants, setGrants] = useState<ViewGrantResponse[] | null>(null)
    const [busyGrant, setBusyGrant] = useState<string | null>(null)
    const [adding, setAdding] = useState(false)
    const takesShares = current.visibility !== 'enterprise' && current.access.canShare

    useEffect(() => {
        if (!takesShares) return
        let cancelled = false
        layoutTemplateService.grants.list(current.id)
            .then(rows => { if (!cancelled) setGrants(rows) })
            .catch(() => { if (!cancelled) setGrants([]) })
        return () => { cancelled = true }
    }, [current.id, takesShares])

    const changed = useCallback((next: LayoutTemplate) => {
        setCurrent(next)
        onChanged?.(next)
        void invalidate()
    }, [onChanged, invalidate])

    const move = async (next: { visibility: TemplateVisibility; workspaceId: string | null }) => {
        if (next.visibility === current.visibility && next.workspaceId === (current.workspaceId ?? null)) return
        setMoving(true)
        try {
            changed(await layoutTemplateService.update(current.id, next))
        } catch (err) {
            notify('error', (err as Error).message)
        } finally {
            setMoving(false)
        }
    }

    const add = async (subjectType: 'user' | 'group', subjectId: string, role: 'editor' | 'viewer', label: string) => {
        setAdding(true)
        try {
            const grant = await layoutTemplateService.grants.create(current.id, { subjectType, subjectId, role })
            setGrants(g => [...(g ?? []), grant])
            notify('success', `Shared with ${label}`)
            void invalidate()
        } catch (err) {
            notify('error', (err as Error).message)
        } finally {
            setAdding(false)
        }
    }

    const setRole = async (grant: ViewGrantResponse, role: 'editor' | 'viewer') => {
        if (grant.role === role) return
        setBusyGrant(grant.grantId)
        try {
            const updated = await layoutTemplateService.grants.update(current.id, grant.grantId, role)
            setGrants(g => (g ?? []).map(x => (x.grantId === grant.grantId ? updated : x)))
        } catch (err) {
            notify('error', (err as Error).message)
        } finally {
            setBusyGrant(null)
        }
    }

    const remove = async (grant: ViewGrantResponse) => {
        setBusyGrant(grant.grantId)
        try {
            await layoutTemplateService.grants.delete(current.id, grant.grantId)
            setGrants(g => (g ?? []).filter(x => x.grantId !== grant.grantId))
            void invalidate()
        } catch (err) {
            notify('error', (err as Error).message)
        } finally {
            setBusyGrant(null)
        }
    }

    return (
        <>
            <Backdrop open onClick={onClose} zClassName="z-50" className="bg-black/50" />
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
                <div
                    ref={ref}
                    role="dialog"
                    aria-modal="true"
                    aria-label={`Share ${current.name}`}
                    tabIndex={-1}
                    className="pointer-events-auto w-full max-w-2xl max-h-[88vh] flex flex-col rounded-2xl bg-canvas-elevated border border-slate-200 dark:border-slate-700 shadow-2xl focus:outline-none"
                >
                    <div className="h-1 rounded-t-2xl bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-500" />
                    <header className="flex items-start gap-3 px-6 pt-5 pb-4 border-b border-slate-200 dark:border-slate-700">
                        <div className="flex-1 min-w-0">
                            <h2 className="text-lg font-bold text-ink truncate">Share "{current.name}"</h2>
                            <p className="text-xs text-ink-muted mt-0.5">
                                Changes apply at once. Views already built from it are never affected.
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

                    <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
                        <section>
                            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-3 flex items-center gap-2">
                                Who can use it {moving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                            </h3>
                            <AudiencePicker
                                visibility={current.visibility}
                                workspaceId={current.workspaceId ?? null}
                                onChange={next => void move(next)}
                                disabled={moving}
                            />
                        </section>

                        <section>
                            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">People and teams</h3>
                            <p className="text-[11px] text-ink-muted mt-0.5 mb-3">
                                On top of the audience above. Viewers can use it; editors can also change it.
                            </p>
                            {!takesShares ? (
                                <p className="rounded-xl border border-dashed border-slate-200 dark:border-slate-700 px-4 py-4 text-xs text-ink-muted">
                                    {current.visibility === 'enterprise'
                                        ? 'An organization template is open to everyone signed in, so there is no one to add.'
                                        : 'Only its owner or a workspace admin can share this template.'}
                                </p>
                            ) : (
                                <>
                                    <AddGrantPicker disabled={adding} onAdd={add} />
                                    <div className="mt-3">
                                        {grants === null ? (
                                            <div className="flex items-center justify-center py-5 text-xs text-ink-muted">
                                                <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading shares…
                                            </div>
                                        ) : grants.length === 0 ? (
                                            <div className="rounded-xl border border-dashed border-slate-200 dark:border-slate-700 px-4 py-5 text-center">
                                                <UserPlus className="w-6 h-6 text-ink-muted/60 mx-auto mb-2" />
                                                <p className="text-xs text-ink-muted">
                                                    Not shared with anyone yet. Add a group above to give a whole team this template.
                                                </p>
                                            </div>
                                        ) : (
                                            <ul className="rounded-xl border border-slate-200 dark:border-slate-700 divide-y divide-slate-200 dark:divide-slate-700">
                                                {grants.map(g => {
                                                    const name = g.subject.displayName ?? g.subject.id
                                                    const busy = busyGrant === g.grantId
                                                    return (
                                                        <li key={g.grantId} className="flex items-center gap-2.5 px-3 py-2">
                                                            {g.subject.type === 'user' ? (
                                                                <UserAvatar userId={g.subject.id} name={name} shape="gradient" className="w-8 h-8 text-[10px] font-bold" />
                                                            ) : (
                                                                <div className="w-8 h-8 rounded-full bg-violet-500/10 border border-violet-500/20 flex items-center justify-center text-violet-600 dark:text-violet-400 shrink-0">
                                                                    <Users2 className="w-3.5 h-3.5" />
                                                                </div>
                                                            )}
                                                            <div className="min-w-0 flex-1">
                                                                <p className="text-sm text-ink truncate">{name}</p>
                                                                {g.subject.secondary && <p className="text-[11px] text-ink-muted truncate">{g.subject.secondary}</p>}
                                                            </div>
                                                            <div className="flex items-center bg-black/5 dark:bg-white/5 rounded-lg p-0.5 shrink-0">
                                                                {ROLES.map(({ id, label, icon: Icon }) => (
                                                                    <button
                                                                        key={id}
                                                                        type="button"
                                                                        disabled={busy}
                                                                        aria-pressed={g.role === id}
                                                                        onClick={() => void setRole(g, id)}
                                                                        className={cn(
                                                                            'flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold transition-colors disabled:opacity-50',
                                                                            g.role === id ? 'bg-white dark:bg-white/10 text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
                                                                        )}
                                                                    >
                                                                        <Icon className="w-3 h-3" /> {label}
                                                                    </button>
                                                                ))}
                                                            </div>
                                                            <HoverTip label={`Stop sharing with ${name}`}>
                                                                <button
                                                                    type="button"
                                                                    disabled={busy}
                                                                    aria-label={`Stop sharing with ${name}`}
                                                                    onClick={() => void remove(g)}
                                                                    className="p-1.5 rounded-lg text-ink-muted hover:text-red-500 hover:bg-red-500/10 disabled:opacity-50"
                                                                >
                                                                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                                                                </button>
                                                            </HoverTip>
                                                        </li>
                                                    )
                                                })}
                                            </ul>
                                        )}
                                    </div>
                                </>
                            )}
                        </section>
                    </div>
                </div>
            </div>
        </>
    )
}
