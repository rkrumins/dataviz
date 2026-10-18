/**
 * Review a layout template's new version against a view built from an older
 * one, then apply it — or keep the view's own layers.
 *
 * Nothing changes until "Apply update". What the template changed and the view
 * did not is ticked already; where both changed the same thing the view's value
 * stays unless the person picks the template's; a dropped layer that holds
 * placed entities, or was edited here, stays unless they say otherwise. Applying
 * saves a version of the view (source "template") and offers Undo, which puts
 * the layers back exactly as they were.
 *
 * Portaled, and above the template drawer (z-61) it can be opened from: a
 * transformed ancestor would otherwise trap its fixed layout.
 */
import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
    ArrowRight, ArrowUpDown, Check, LayoutTemplate as TemplateIcon, Loader2, Minus, Pencil, Plus, RotateCcw, X,
} from 'lucide-react'
import { Backdrop } from '@/components/ui/Backdrop'
import { PersonChip } from '@/components/ui/PersonChip'
import { useAppNotifications } from '@/components/ui/notifications'
import { LAYOUT_TEMPLATES_KEY } from '@/hooks/useLayoutTemplates'
import { useModalA11y } from '@/hooks/useModalA11y'
import { VIEW_QUERY_KEY } from '@/hooks/useViewMetadata'
import { useWorkspaceEntityTypes } from '@/hooks/useWorkspaceEntityTypes'
import { timeAgo } from '@/lib/timeAgo'
import { cn } from '@/lib/utils'
import { layoutTemplateService, type LayoutTemplate } from '@/services/layoutTemplateService'
import { setViewTemplateVersion, updateViewLayout, type View } from '@/services/viewApiService'
import type { LayerAssignmentEntry, ViewLayerConfig } from '@/types/schema'
import { normalizeReferenceLayout } from '@/utils/referenceLayout'
import {
    applyTemplateUpdate, defaultChoices, ORDER_KEY, planTemplateUpdate,
    type FieldChange, type TemplateField, type TemplateUpdateInput, type UpdateRow,
} from './templateUpdate'

const FIELD_LABEL: Record<TemplateField, string> = {
    name: 'Name', description: 'Description', icon: 'Icon', color: 'Colour', entityTypes: 'Entity types',
    rules: 'Rules', logicalNodes: 'Groups', showUnassigned: 'Unassigned entities',
}

/** A field's change in a few words — enough to decide on. */
function FieldDiff({ change }: { change: FieldChange }) {
    const { field, ours, theirs } = change
    if (field === 'color') {
        return (
            <span className="inline-flex items-center gap-1.5">
                <span className="w-3.5 h-3.5 rounded-full border border-black/10" style={{ background: String(ours ?? 'transparent') }} />
                <ArrowRight className="w-3 h-3 text-ink-muted" aria-hidden />
                <span className="w-3.5 h-3.5 rounded-full border border-black/10" style={{ background: String(theirs ?? 'transparent') }} />
            </span>
        )
    }
    if (field === 'entityTypes') {
        const before = new Set((ours as string[] | undefined) ?? [])
        const after = new Set((theirs as string[] | undefined) ?? [])
        return (
            <span className="inline-flex flex-wrap gap-1">
                {[...after].filter(t => !before.has(t)).map(t => (
                    <span key={`+${t}`} className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">+{t}</span>
                ))}
                {[...before].filter(t => !after.has(t)).map(t => (
                    <span key={`-${t}`} className="px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-rose-500/10 text-rose-700 dark:text-rose-300 line-through">{t}</span>
                ))}
            </span>
        )
    }
    if (field === 'rules' || field === 'logicalNodes') {
        const count = (v: unknown) => (Array.isArray(v) ? v.length : 0)
        const noun = field === 'rules' ? 'rule' : 'group'
        return <span>{count(ours)} {noun}{count(ours) === 1 ? '' : 's'} → {count(theirs)} {noun}{count(theirs) === 1 ? '' : 's'}</span>
    }
    if (field === 'showUnassigned') return <span>{ours ? 'Shown' : 'Hidden'} → {theirs ? 'Shown' : 'Hidden'}</span>
    if (field === 'name') return <span>{String(ours ?? '—')} → <strong className="font-semibold text-ink">{String(theirs ?? '—')}</strong></span>
    return <span>Changed</span>
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={label}
            onClick={() => onChange(!on)}
            className={cn(
                'relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors',
                on ? 'bg-indigo-500' : 'bg-slate-300 dark:bg-slate-600',
            )}
        >
            <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform', on ? 'translate-x-4' : 'translate-x-0.5')} />
        </button>
    )
}

function Choice({ takeTheirs, onChange, label }: { takeTheirs: boolean; onChange: (theirs: boolean) => void; label: string }) {
    return (
        <div role="radiogroup" aria-label={label} className="flex items-center bg-black/5 dark:bg-white/5 rounded-lg p-0.5 shrink-0">
            {[{ v: false, text: 'Keep yours' }, { v: true, text: "Use template's" }].map(o => (
                <button
                    key={o.text}
                    type="button"
                    role="radio"
                    aria-checked={takeTheirs === o.v}
                    onClick={() => onChange(o.v)}
                    className={cn(
                        'px-2 py-1 rounded-md text-[11px] font-semibold transition-colors',
                        takeTheirs === o.v ? 'bg-white dark:bg-white/10 text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
                    )}
                >
                    {o.text}
                </button>
            ))}
        </div>
    )
}

const ROW_LOOK: Record<UpdateRow['kind'], { icon: typeof Plus; tone: string; title: (r: UpdateRow) => string }> = {
    added: { icon: Plus, tone: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400', title: r => `New layer · ${r.name}` },
    changed: { icon: Pencil, tone: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400', title: r => r.name },
    removed: { icon: Minus, tone: 'bg-rose-500/10 text-rose-600 dark:text-rose-400', title: r => `${r.name} · removed from the template` },
    restorable: { icon: RotateCcw, tone: 'bg-amber-500/10 text-amber-600 dark:text-amber-400', title: r => `${r.name} · you removed it; the template has changed it since` },
}

export function TemplateUpdateDialog({ view, template, onClose }: {
    view: View
    template: LayoutTemplate
    onClose: () => void
}) {
    const ref = useModalA11y(true, onClose)
    const queryClient = useQueryClient()
    const { notify } = useAppNotifications()
    const baseVersion = view.contextModelVersion ?? 1
    const latest = template.version
    const [overrides, setOverrides] = useState<Record<string, boolean>>({})
    const [busy, setBusy] = useState<'apply' | 'keep' | null>(null)

    const base = useQuery({
        queryKey: [...LAYOUT_TEMPLATES_KEY, 'one', template.id, 'version', baseVersion],
        queryFn: () => layoutTemplateService.version(template.id, baseVersion),
        staleTime: Infinity,
    })
    const versions = useQuery({
        queryKey: [...LAYOUT_TEMPLATES_KEY, 'one', template.id, 'versions'],
        queryFn: () => layoutTemplateService.versions(template.id),
    })
    const types = useWorkspaceEntityTypes(view.workspaceId, view.dataSourceId)
    const rawLayout = useMemo(
        () => (view.config?.layout?.referenceLayout ?? view.config?.referenceLayout ?? {}) as Record<string, unknown>,
        [view.config],
    )

    const input = useMemo<TemplateUpdateInput | null>(() => {
        if (!base.data || types.isLoading) return null
        const current = normalizeReferenceLayout(rawLayout)
        return {
            base: base.data.layers,
            latest: template.layers,
            view: { layers: current.layers, assignments: current.assignments },
            declared: types.types,
        }
    }, [base.data, types.isLoading, types.types, template.layers, rawLayout])
    const plan = useMemo(() => (input ? planTemplateUpdate(input) : null), [input])
    const defaults = useMemo(() => (plan ? defaultChoices(plan) : new Set<string>()), [plan])
    const take = useMemo(() => {
        const out = new Set([...defaults].filter(k => overrides[k] !== false))
        for (const [k, on] of Object.entries(overrides)) if (on) out.add(k)
        return out
    }, [defaults, overrides])
    const choose = (key: string, on: boolean) => setOverrides(o => ({ ...o, [key]: on }))

    const notes = (versions.data ?? []).filter(v => v.version > baseVersion && v.version <= latest)
    const decisions = plan ? plan.rows.reduce((n, r) => n + (r.kind === 'changed' ? r.fields.filter(f => f.conflict).length
        : r.kind === 'removed' ? (r.conflict ? 1 : 0) : r.kind === 'restorable' ? 1 : 0), plan.order?.conflict ? 1 : 0) : 0
    const nothing = plan !== null && plan.rows.length === 0 && !plan.order

    const refresh = () => {
        void queryClient.invalidateQueries({ queryKey: [...VIEW_QUERY_KEY, view.id] })
        void queryClient.invalidateQueries({ queryKey: ['views'] })
        void queryClient.invalidateQueries({ queryKey: ['explorer-views'] })
    }

    const putBack = async (before: { layers: ViewLayerConfig[]; assignments: Record<string, LayerAssignmentEntry> }) => {
        try {
            await updateViewLayout(view.id, { referenceLayout: { ...rawLayout, ...before } })
            await setViewTemplateVersion(view.id, baseVersion)
            refresh()
            notify('success', `"${view.name}" is back as it was`)
        } catch (err) {
            notify('error', (err as Error).message)
        }
    }

    const apply = async () => {
        if (!input || !plan) return
        setBusy('apply')
        const before = normalizeReferenceLayout(rawLayout)
        try {
            const result = applyTemplateUpdate(input, plan, take)
            await updateViewLayout(view.id, {
                referenceLayout: { ...rawLayout, layers: result.layers, assignments: result.assignments },
                checkpoint: { source: 'template', message: `Applied version ${latest} of "${template.name}"` },
            })
            await setViewTemplateVersion(view.id, latest)
            refresh()
            notify('success', `Applied version ${latest} of "${template.name}"`, {
                label: 'Undo', onClick: () => void putBack({ layers: before.layers, assignments: before.assignments }),
            }, 10_000)
            onClose()
        } catch (err) {
            notify('error', (err as Error).message)
        } finally {
            setBusy(null)
        }
    }

    const keepMine = async () => {
        setBusy('keep')
        try {
            await setViewTemplateVersion(view.id, latest)
            refresh()
            notify('success', `"${view.name}" keeps its layers — marked as up to date with version ${latest}`)
            onClose()
        } catch (err) {
            notify('error', (err as Error).message)
        } finally {
            setBusy(null)
        }
    }

    return createPortal(
        <>
            <Backdrop open onClick={onClose} zClassName="z-[70]" className="bg-black/50" />
            <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 pointer-events-none">
                <div
                    ref={ref}
                    role="dialog"
                    aria-modal="true"
                    aria-label={`Update ${view.name} from ${template.name}`}
                    tabIndex={-1}
                    className="pointer-events-auto w-full max-w-3xl max-h-[88vh] flex flex-col rounded-2xl bg-canvas-elevated border border-slate-200 dark:border-slate-700 shadow-2xl focus:outline-none"
                >
                    <div className="h-1 rounded-t-2xl bg-gradient-to-r from-fuchsia-500 via-violet-500 to-indigo-500" />
                    <header className="flex items-start gap-3 px-6 pt-5 pb-4 border-b border-slate-200 dark:border-slate-700">
                        <div className="w-10 h-10 rounded-xl bg-fuchsia-500/10 border border-fuchsia-500/20 text-fuchsia-500 flex items-center justify-center shrink-0">
                            <TemplateIcon className="w-5 h-5" aria-hidden />
                        </div>
                        <div className="flex-1 min-w-0">
                            <h2 className="text-lg font-bold text-ink truncate">Update from “{template.name}”</h2>
                            <p className="text-xs text-ink-muted mt-0.5 flex items-center gap-1.5">
                                “{view.name}” matches version {baseVersion}
                                <ArrowRight className="w-3 h-3" aria-hidden />
                                the template is at version {latest}
                            </p>
                        </div>
                        <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5">
                            <X className="w-4 h-4" />
                        </button>
                    </header>

                    <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
                        {notes.length > 0 && (
                            <section>
                                <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2">What's new</h3>
                                <ol className="space-y-2">
                                    {notes.map(v => (
                                        <li key={v.version} className="flex items-start gap-3 text-xs">
                                            <span className="shrink-0 px-1.5 py-0.5 rounded-md bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300 font-bold tabular-nums">v{v.version}</span>
                                            <span className="flex-1 min-w-0">
                                                <span className="text-ink">{v.changeNote || 'No note left for this version.'}</span>
                                                <span className="flex items-center gap-1.5 text-ink-muted mt-0.5">
                                                    {v.createdBy ? <PersonChip id={v.createdBy} size="xs" link={false} /> : 'With this release'}
                                                    · {timeAgo(v.createdAt)}
                                                </span>
                                            </span>
                                        </li>
                                    ))}
                                </ol>
                            </section>
                        )}

                        {!plan ? (
                            <div className="flex items-center justify-center py-10 text-xs text-ink-muted">
                                {base.isError
                                    ? 'The version this view was built from could not be read.'
                                    : <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Comparing…</>}
                            </div>
                        ) : !plan.follows ? (
                            <p className="rounded-xl border border-dashed border-slate-200 dark:border-slate-700 px-4 py-5 text-sm text-ink-muted">
                                None of this view's layers come from the template any more, so there is nothing to bring across.
                                You can mark the view as up to date.
                            </p>
                        ) : nothing ? (
                            <p className="rounded-xl border border-dashed border-slate-200 dark:border-slate-700 px-4 py-5 text-sm text-ink-muted">
                                This view already has everything the new version changed.
                            </p>
                        ) : (
                            <section>
                                <div className="flex items-baseline justify-between gap-3 mb-3">
                                    <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Changes</h3>
                                    <p className="text-[11px] text-ink-muted">
                                        {take.size} will apply{decisions > 0 && ` · ${decisions} need your call`} · nothing changes until you apply
                                    </p>
                                </div>
                                <ul className="space-y-2.5">
                                    {plan.rows.map(row => {
                                        const look = ROW_LOOK[row.kind]
                                        return (
                                            <li key={`${row.kind}:${row.key}`} className="rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-3">
                                                <div className="flex items-center gap-3">
                                                    <span className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0', look.tone)}>
                                                        <look.icon className="w-3.5 h-3.5" aria-hidden />
                                                    </span>
                                                    <span className="flex-1 min-w-0 text-sm font-semibold text-ink truncate">{look.title(row)}</span>
                                                    {row.kind === 'added' && (
                                                        <Toggle on={take.has(row.key)} onChange={on => choose(row.key, on)} label={`Add ${row.name}`} />
                                                    )}
                                                    {row.kind === 'removed' && (
                                                        <Toggle on={take.has(row.key)} onChange={on => choose(row.key, on)} label={`Remove ${row.name} here too`} />
                                                    )}
                                                    {row.kind === 'restorable' && (
                                                        <Toggle on={take.has(row.key)} onChange={on => choose(row.key, on)} label={`Add ${row.name} back`} />
                                                    )}
                                                </div>
                                                {row.kind === 'removed' && row.conflict && (
                                                    <p className="text-[11px] text-ink-muted mt-2 pl-10">
                                                        Kept unless you switch it on:
                                                        {row.placed > 0 && ` ${row.placed} entit${row.placed === 1 ? 'y is' : 'ies are'} placed in it here`}
                                                        {row.placed > 0 && row.edited && ' and'}
                                                        {row.edited && ' you changed it in this view'}.
                                                        {row.placed > 0 && ' Removing it unplaces them.'}
                                                    </p>
                                                )}
                                                {row.kind === 'changed' && (
                                                    <ul className="mt-2 pl-10 space-y-1.5">
                                                        {row.fields.map(f => (
                                                            <li key={f.key} className="flex items-center gap-3 text-xs">
                                                                <span className="w-28 shrink-0 font-semibold text-ink-secondary">{FIELD_LABEL[f.field]}</span>
                                                                <span className="flex-1 min-w-0 text-ink-muted truncate"><FieldDiff change={f} /></span>
                                                                {f.conflict ? (
                                                                    <Choice takeTheirs={take.has(f.key)} onChange={v => choose(f.key, v)} label={`${FIELD_LABEL[f.field]} of ${row.name}`} />
                                                                ) : (
                                                                    <Toggle on={take.has(f.key)} onChange={on => choose(f.key, on)} label={`Apply the new ${FIELD_LABEL[f.field].toLowerCase()} of ${row.name}`} />
                                                                )}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )}
                                            </li>
                                        )
                                    })}
                                    {plan.order && (
                                        <li className="rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-3 flex items-center gap-3">
                                            <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-sky-500/10 text-sky-600 dark:text-sky-400">
                                                <ArrowUpDown className="w-3.5 h-3.5" aria-hidden />
                                            </span>
                                            <span className="flex-1 min-w-0 text-sm font-semibold text-ink">
                                                The template reordered its layers{plan.order.conflict && ' — and so did you'}
                                            </span>
                                            <Toggle on={take.has(ORDER_KEY)} onChange={on => choose(ORDER_KEY, on)} label="Use the template's order" />
                                        </li>
                                    )}
                                </ul>
                            </section>
                        )}
                    </div>

                    <footer className="flex items-center justify-between gap-3 px-6 py-4 border-t border-slate-200 dark:border-slate-700">
                        <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => void keepMine()}
                            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50"
                        >
                            {busy === 'keep' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                            Keep my layers
                        </button>
                        <button
                            type="button"
                            disabled={busy !== null || !plan?.follows || nothing}
                            onClick={() => void apply()}
                            className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold bg-gradient-to-r from-fuchsia-500 to-indigo-600 text-white shadow-md disabled:opacity-50 disabled:shadow-none"
                        >
                            {busy === 'apply' ? <Loader2 className="w-4 h-4 animate-spin" /> : <TemplateIcon className="w-4 h-4" />}
                            Apply update
                        </button>
                    </footer>
                </div>
            </div>
        </>,
        document.body,
    )
}
