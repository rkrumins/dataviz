/**
 * A template's versions, newest first: what each changed, who changed it and
 * when — compared with the current layers on request, and put back by anyone
 * who may edit it. Restoring is a new version, so nothing in the history is lost.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { GitCompareArrows, History, Loader2, RotateCcw } from 'lucide-react'
import { PersonChip } from '@/components/ui/PersonChip'
import { useAppNotifications } from '@/components/ui/notifications'
import { LAYOUT_TEMPLATES_KEY, useInvalidateLayoutTemplates } from '@/hooks/useLayoutTemplates'
import { timeAgo } from '@/lib/timeAgo'
import { cn } from '@/lib/utils'
import { layoutTemplateService, type LayoutTemplate } from '@/services/layoutTemplateService'
import { diffTemplateLayers, type TemplateField } from './templateUpdate'

const FIELD_WORD: Record<TemplateField, string> = {
    name: 'name', description: 'description', icon: 'icon', color: 'colour', entityTypes: 'entity types',
    rules: 'rules', logicalNodes: 'groups', showUnassigned: 'unassigned entities',
}

function Comparison({ template, version }: { template: LayoutTemplate; version: number }) {
    const old = useQuery({
        queryKey: [...LAYOUT_TEMPLATES_KEY, 'one', template.id, 'version', version],
        queryFn: () => layoutTemplateService.version(template.id, version),
        staleTime: Infinity,
    })
    if (!old.data) return <p className="text-[11px] text-ink-muted mt-2 flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Comparing…</p>
    const diff = diffTemplateLayers(old.data.layers, template.layers)
    if (diff.length === 0) return <p className="text-[11px] text-ink-muted mt-2">The same layers as now.</p>
    return (
        <ul className="mt-2 space-y-1 text-[11px]">
            {diff.map(d => (
                <li key={`${d.kind}:${d.id}`} className="flex items-baseline gap-1.5">
                    <span className={cn('font-bold w-3 text-center', d.kind === 'added' ? 'text-emerald-600' : d.kind === 'removed' ? 'text-rose-600' : 'text-indigo-600')}>
                        {d.kind === 'added' ? '+' : d.kind === 'removed' ? '−' : '~'}
                    </span>
                    <span className="text-ink-secondary">
                        <strong className="font-semibold text-ink">{d.name}</strong>
                        {d.kind === 'added' && ' added since'}
                        {d.kind === 'removed' && ' removed since'}
                        {d.kind === 'changed' && ` — ${d.fields.map(f => FIELD_WORD[f]).join(', ')} changed since`}
                    </span>
                </li>
            ))}
        </ul>
    )
}

export function TemplateVersionHistory({ template, open }: { template: LayoutTemplate; open: boolean }) {
    const { notify } = useAppNotifications()
    const invalidate = useInvalidateLayoutTemplates()
    const [comparing, setComparing] = useState<number | null>(null)
    const [confirming, setConfirming] = useState<number | null>(null)
    const [restoring, setRestoring] = useState(false)
    const versions = useQuery({
        queryKey: [...LAYOUT_TEMPLATES_KEY, 'one', template.id, 'versions'],
        queryFn: () => layoutTemplateService.versions(template.id),
        enabled: open,
    })

    const restore = async (version: number) => {
        setRestoring(true)
        try {
            await layoutTemplateService.restoreVersion(template.id, version)
            notify('success', `Version ${version}'s layers are the newest version again`)
            setConfirming(null)
            await invalidate()
        } catch (err) {
            notify('error', (err as Error).message)
        } finally {
            setRestoring(false)
        }
    }

    const items = versions.data ?? []
    return (
        <section>
            <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-3">
                <History className="w-3.5 h-3.5" /> Versions
            </h3>
            {versions.isLoading ? (
                <p className="text-xs text-ink-muted flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</p>
            ) : items.length === 0 ? (
                <p className="text-sm text-ink-muted">Version {template.version}. Earlier versions were not kept.</p>
            ) : (
                <ol className="relative border-l border-slate-200 dark:border-slate-700 ml-1.5 space-y-4">
                    {items.map(v => {
                        const current = v.version === template.version
                        return (
                            <li key={v.version} className="pl-4 relative">
                                <span className={cn(
                                    'absolute -left-[5px] top-1.5 w-2.5 h-2.5 rounded-full ring-2 ring-canvas-elevated',
                                    current ? 'bg-fuchsia-500' : 'bg-slate-300 dark:bg-slate-600',
                                )} />
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-xs font-bold text-ink tabular-nums">v{v.version}</span>
                                    {current && <span className="text-[10px] font-semibold uppercase tracking-wide text-fuchsia-600 dark:text-fuchsia-400">Current</span>}
                                    <span className="text-[11px] text-ink-muted">{v.layerCount} layer{v.layerCount === 1 ? '' : 's'} · {timeAgo(v.createdAt)}</span>
                                </div>
                                <p className="text-xs text-ink-secondary mt-0.5">{v.changeNote || (v.version === 1 ? 'First version.' : 'No note left for this version.')}</p>
                                <div className="flex items-center gap-2 mt-1 text-[11px] text-ink-muted">
                                    {v.createdBy ? <PersonChip id={v.createdBy} size="xs" link={false} /> : <span>With a release</span>}
                                    {!current && (
                                        <>
                                            <button
                                                type="button"
                                                onClick={() => setComparing(comparing === v.version ? null : v.version)}
                                                aria-expanded={comparing === v.version}
                                                className="inline-flex items-center gap-1 font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                                            >
                                                <GitCompareArrows className="w-3 h-3" /> Compare with now
                                            </button>
                                            {template.access.canEdit && (
                                                <button
                                                    type="button"
                                                    onClick={() => setConfirming(v.version)}
                                                    className="inline-flex items-center gap-1 font-semibold text-ink-secondary hover:text-ink hover:underline"
                                                >
                                                    <RotateCcw className="w-3 h-3" /> Restore
                                                </button>
                                            )}
                                        </>
                                    )}
                                </div>
                                {comparing === v.version && <Comparison template={template} version={v.version} />}
                                {confirming === v.version && (
                                    <div className="mt-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-ink-secondary">
                                        Make version {v.version}'s layers the newest version? The current ones stay in the history,
                                        and views built from this template are offered the change.
                                        <div className="flex gap-2 mt-2">
                                            <button
                                                type="button"
                                                disabled={restoring}
                                                onClick={() => void restore(v.version)}
                                                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-amber-500 text-white font-semibold disabled:opacity-50"
                                            >
                                                {restoring && <Loader2 className="w-3 h-3 animate-spin" />} Restore version {v.version}
                                            </button>
                                            <button type="button" onClick={() => setConfirming(null)} className="px-2.5 py-1 rounded-lg font-semibold hover:bg-black/5 dark:hover:bg-white/5">
                                                Cancel
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </li>
                        )
                    })}
                </ol>
            )}
        </section>
    )
}
