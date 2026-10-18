/**
 * Everything about one template, without leaving the library: every layer with
 * its types, rules and logical nodes, who can use it, the views built from it,
 * and the actions this person may take.
 */
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
    ArrowRight, Box, Copy, Eye, EyeOff, GitBranch, Layers, Pencil, Share2, Trash2, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Backdrop } from '@/components/ui/Backdrop'
import { PersonChip } from '@/components/ui/PersonChip'
import { useModalA11y } from '@/hooks/useModalA11y'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { listViews } from '@/services/viewApiService'
import type { LayoutTemplate } from '@/services/layoutTemplateService'
import { useBrand } from '@/store/branding'
import type { LogicalNodeConfig, ViewLayerConfig } from '@/types/schema'
import { AudienceBadge } from './TemplateCard'
import { TemplateUpdateChip } from './TemplateUpdateChip'
import { TemplateVersionHistory } from './TemplateVersionHistory'
import { audienceDescription, audienceOf, categoryLabel, menuActions, type TemplateAction } from './templateAudience'

const ACTION_BUTTONS: Record<Exclude<TemplateAction, 'use'>, { label: string; icon: LucideIcon }> = {
    edit: { label: 'Edit', icon: Pencil },
    duplicate: { label: 'Duplicate', icon: Copy },
    share: { label: 'Share', icon: Share2 },
    hide: { label: 'Hide', icon: EyeOff },
    show: { label: 'Show', icon: Eye },
    delete: { label: 'Delete', icon: Trash2 },
}

function countNodes(nodes: readonly LogicalNodeConfig[] | undefined): number {
    return (nodes ?? []).reduce((n, node) => n + 1 + countNodes(node.children), 0)
}

function LayerRow({ layer, index }: { layer: ViewLayerConfig; index: number }) {
    const rules = layer.rules?.length ?? 0
    const nodes = countNodes(layer.logicalNodes)
    return (
        <li className="relative pl-4">
            <span
                aria-hidden
                className="absolute left-0 top-1 bottom-1 w-1 rounded-full"
                style={{ backgroundColor: layer.color || '#94a3b8' }}
            />
            <div className="flex items-baseline gap-2">
                <span className="text-[10px] font-semibold text-ink-muted tabular-nums">{index + 1}</span>
                <span className="text-sm font-semibold text-ink">{layer.name}</span>
            </div>
            {layer.description && <p className="text-xs text-ink-muted mt-0.5">{layer.description}</p>}
            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                {(layer.entityTypes ?? []).map(type => (
                    <span key={type} className="px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-black/[0.04] dark:bg-white/[0.06] text-ink-secondary">
                        {type}
                    </span>
                ))}
                {(layer.entityTypes ?? []).length === 0 && (
                    <span className="text-[10px] text-ink-muted italic">Filled by hand — no entity types</span>
                )}
                {rules > 0 && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-ink-muted">
                        <GitBranch className="w-3 h-3" /> {rules} rule{rules === 1 ? '' : 's'}
                    </span>
                )}
                {nodes > 0 && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-ink-muted">
                        <Box className="w-3 h-3" /> {nodes} group{nodes === 1 ? '' : 's'}
                    </span>
                )}
            </div>
        </li>
    )
}

export function TemplateDetailDrawer({ template, open, onClose, onAction }: {
    template: LayoutTemplate | null
    open: boolean
    onClose: () => void
    onAction: (template: LayoutTemplate, action: TemplateAction) => void
}) {
    const ref = useModalA11y(open, onClose)
    const { appName } = useBrand()
    const usedBy = useQuery({
        queryKey: ['views', 'by-template', template?.id ?? ''],
        queryFn: () => listViews({ contextModelId: template!.id, limit: 6, sort: 'updated' }),
        enabled: open && !!template && template.usageCount > 0,
        staleTime: 30_000,
    })

    return (
        <>
            {/* Above the app's top bar, like the Explorer's preview drawer. */}
            <Backdrop open={open} onClick={onClose} zClassName="z-[60]" />
            <aside
                ref={ref}
                role="dialog"
                aria-modal="true"
                aria-label={template ? `Template ${template.name}` : 'Template'}
                aria-hidden={!open}
                inert={!open}
                tabIndex={-1}
                className={cn(
                    'fixed inset-y-0 right-0 z-[61] w-full max-w-[480px] bg-canvas-elevated border-l border-slate-200 dark:border-slate-700 shadow-2xl',
                    'flex flex-col focus:outline-none transition-transform duration-300 ease-out',
                    open ? 'translate-x-0' : 'translate-x-full pointer-events-none',
                )}
            >
                {template && (
                    <>
                        <div className="h-1 w-full bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-500 shrink-0" />
                        <header className="px-6 pt-5 pb-4 border-b border-slate-200 dark:border-slate-700 shrink-0">
                            <div className="flex items-center gap-1.5 mb-2">
                                <AudienceBadge template={template} />
                                {template.category && (
                                    <span className="px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
                                        {categoryLabel(template.category)}
                                    </span>
                                )}
                                <button
                                    type="button"
                                    onClick={onClose}
                                    aria-label="Close"
                                    className="ml-auto p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                            <h2 className="text-lg font-bold text-ink leading-tight">{template.name}</h2>
                            {template.description && (
                                <p className="text-sm text-ink-muted mt-1 leading-relaxed">{template.description}</p>
                            )}
                            <div className="flex flex-wrap items-center gap-2 mt-4">
                                <button
                                    type="button"
                                    onClick={() => onAction(template, 'use')}
                                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-gradient-to-r from-indigo-500 to-violet-600 text-white shadow-md shadow-indigo-500/25 hover:shadow-lg transition-shadow"
                                >
                                    Use template <ArrowRight className="w-4 h-4" />
                                </button>
                                {menuActions(template).map(action => {
                                    const { label, icon: Icon } = ACTION_BUTTONS[action]
                                    return (
                                        <button
                                            key={action}
                                            type="button"
                                            onClick={() => onAction(template, action)}
                                            className={cn(
                                                'inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold border transition-colors',
                                                action === 'delete'
                                                    ? 'border-red-500/20 text-red-600 dark:text-red-400 hover:bg-red-500/10'
                                                    : 'border-slate-200 dark:border-slate-700 text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5',
                                            )}
                                        >
                                            <Icon className="w-3.5 h-3.5" /> {label}
                                        </button>
                                    )
                                })}
                            </div>
                        </header>

                        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
                            <section>
                                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-2">Who can use it</h3>
                                <p className="text-sm text-ink-secondary">
                                    {audienceDescription(audienceOf(template), { workspaceName: template.workspaceName, appName })}
                                </p>
                                {template.grantCount != null && template.grantCount > 0 && (
                                    <p className="text-xs text-ink-muted mt-1">
                                        Also shared with {template.grantCount} {template.grantCount === 1 ? 'person or team' : 'people and teams'}.
                                    </p>
                                )}
                                {template.hidden && (
                                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                                        Hidden: only template managers see it in the library.
                                    </p>
                                )}
                            </section>

                            <section>
                                <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-3">
                                    <Layers className="w-3.5 h-3.5" /> {template.layers.length} layer{template.layers.length === 1 ? '' : 's'}
                                </h3>
                                <ol className="space-y-3.5">
                                    {template.layers.map((layer, i) => (
                                        <LayerRow key={layer.id ?? i} layer={layer} index={i} />
                                    ))}
                                </ol>
                                <p className="text-[11px] text-ink-muted mt-3">
                                    Entity types are matched to each view's semantic layer when the template is used.
                                </p>
                            </section>

                            <section>
                                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-2">
                                    Views built from it
                                </h3>
                                {template.usageCount === 0 ? (
                                    <p className="text-sm text-ink-muted">None yet. Use it to start a Context View.</p>
                                ) : (
                                    <ul className="rounded-xl border border-slate-200 dark:border-slate-700 divide-y divide-slate-200 dark:divide-slate-700">
                                        {(usedBy.data?.items ?? []).map(view => (
                                            <li key={view.id} className="flex items-center gap-2 pr-3">
                                                <Link
                                                    to={`/views/${view.id}`}
                                                    className="flex flex-1 min-w-0 items-center gap-2 px-3 py-2 text-sm text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03]"
                                                >
                                                    <span className="truncate flex-1">{view.name}</span>
                                                    {view.workspaceName && (
                                                        <span className="text-[11px] text-ink-muted truncate max-w-[40%]">{view.workspaceName}</span>
                                                    )}
                                                </Link>
                                                {view.contextModelVersion != null && (
                                                    <span className="text-[10px] text-ink-muted tabular-nums shrink-0">v{view.contextModelVersion}</span>
                                                )}
                                                <TemplateUpdateChip view={view} canEdit={view.access?.canEdit ?? false} variant="inline" />
                                            </li>
                                        ))}
                                        {usedBy.isLoading && <li className="px-3 py-2 text-xs text-ink-muted">Loading…</li>}
                                        {template.usageCount > (usedBy.data?.items.length ?? 0) && !usedBy.isLoading && (
                                            <li className="px-3 py-2 text-xs text-ink-muted">
                                                and {template.usageCount - (usedBy.data?.items.length ?? 0)} more
                                            </li>
                                        )}
                                    </ul>
                                )}
                                <p className="text-[11px] text-ink-muted mt-2">
                                    A view keeps its own copy of the layers: editing or deleting the template never changes it.
                                    When the template has a new version, the people who can edit a view built from it are offered the changes.
                                </p>
                            </section>

                            <TemplateVersionHistory template={template} open={open} />
                        </div>

                        <footer className="px-6 py-3 border-t border-slate-200 dark:border-slate-700 text-[11px] text-ink-muted flex items-center gap-2 shrink-0">
                            {template.builtIn || !template.createdBy
                                ? <span>Built-in · ships with {appName}</span>
                                : <>Made by <PersonChip id={template.createdBy} size="xs" link={false} /></>}
                            <span className="ml-auto">Updated {timeAgo(template.updatedAt)}</span>
                        </footer>
                    </>
                )}
            </aside>
        </>
    )
}
