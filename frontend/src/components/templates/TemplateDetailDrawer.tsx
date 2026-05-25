/**
 * TemplateDetailDrawer — right-side slide-in panel for inspecting
 * one template. Shows about-markdown, layer breakdown, and usage stats.
 *
 * Kept self-contained: parent passes the template summary (already in
 * cache from the list query); the drawer fetches the usage stats on
 * its own. This keeps the gallery list query lean.
 */
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
    X, Pencil, Copy, Trash2, Star, Globe2, Building2,
    User, Calendar, Tag, Layers as LayersIcon, Download, ArrowUpRight,
} from 'lucide-react'
import type { ContextModel } from '@/services/contextModelService'
import { useTemplateUsage } from '@/hooks/useTemplates'
import { useWorkspacesStore } from '@/store/workspaces'
import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { useCountUp } from '@/components/canvas/trace/useCountUp'
import { cn } from '@/lib/utils'

interface TemplateDetailDrawerProps {
    template: ContextModel | null
    onClose: () => void
    onEdit: (t: ContextModel) => void
    onDuplicate: (t: ContextModel) => void
    onDelete: (t: ContextModel) => void
    onExport: (t: ContextModel) => void
}

export function TemplateDetailDrawer({
    template, onClose, onEdit, onDuplicate, onDelete, onExport,
}: TemplateDetailDrawerProps) {
    const usage = useTemplateUsage(template?.id ?? null)

    const node = (
        <AnimatePresence>
            {template && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="fixed inset-0 z-[75] bg-black/40 flex justify-end"
                    onClick={onClose}
                >
                    <motion.aside
                        initial={{ x: '100%' }}
                        animate={{ x: 0 }}
                        exit={{ x: '100%' }}
                        transition={{ type: 'spring', damping: 30, stiffness: 320 }}
                        onClick={(e) => e.stopPropagation()}
                        className="w-full max-w-lg h-full bg-canvas-elevated border-l border-glass-border shadow-2xl flex flex-col"
                    >
                        <DrawerContent
                            template={template}
                            usage={usage.data}
                            usageLoading={usage.isLoading}
                            onClose={onClose}
                            onEdit={onEdit}
                            onDuplicate={onDuplicate}
                            onDelete={onDelete}
                            onExport={onExport}
                        />
                    </motion.aside>
                </motion.div>
            )}
        </AnimatePresence>
    )

    return createPortal(node, document.body)
}

function DrawerContent({
    template, usage, usageLoading, onClose, onEdit, onDuplicate, onDelete, onExport,
}: {
    template: ContextModel
    usage?: { instantiationCount: number; lastUsedAt?: string; instancesByWorkspace: Record<string, number> }
    usageLoading: boolean
    onClose: () => void
    onEdit: (t: ContextModel) => void
    onDuplicate: (t: ContextModel) => void
    onDelete: (t: ContextModel) => void
    onExport: (t: ContextModel) => void
}) {
    const accent = template.accentColor ?? '#6366f1'
    const icon = template.icon ?? 'LayoutTemplate'
    const isGlobal = template.workspaceId == null
    const animatedCount = useCountUp(template.instantiationCount)
    const navigate = useNavigate()
    const workspaces = useWorkspacesStore((s) => s.workspaces)
    const workspaceNameById = new Map(workspaces.map((w) => [w.id, w.name]))

    return (
        <>
            {/* Header */}
            <div className="px-5 py-4 border-b border-glass-border" style={{
                background: `linear-gradient(135deg, ${accent}10, transparent 70%)`,
            }}>
                <div className="flex items-start justify-between mb-3">
                    <div className="flex items-start gap-3">
                        <div
                            className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0"
                            style={{
                                backgroundColor: `${accent}20`,
                                color: accent,
                                border: `1px solid ${accent}40`,
                            }}
                        >
                            <DynamicIcon name={icon} className="w-5 h-5" />
                        </div>
                        <div className="min-w-0">
                            <h2 className="text-base font-semibold text-ink leading-tight">{template.name}</h2>
                            <div className="flex items-center gap-2 mt-1">
                                <span
                                    className={cn(
                                        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider',
                                        isGlobal
                                            ? 'bg-blue-500/10 text-blue-500'
                                            : 'bg-emerald-500/10 text-emerald-500',
                                    )}
                                >
                                    {isGlobal ? <Globe2 className="w-2.5 h-2.5" /> : <Building2 className="w-2.5 h-2.5" />}
                                    {isGlobal ? 'Global' : 'Workspace'}
                                </span>
                                {template.category && (
                                    <span className="text-[11px] text-ink-muted">{template.category}</span>
                                )}
                            </div>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="w-7 h-7 rounded-md flex items-center justify-center text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink transition-colors"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {template.description && (
                    <p className="text-sm text-ink-secondary leading-relaxed mb-3">{template.description}</p>
                )}

                {/* Actions */}
                <div className="flex items-center gap-1.5">
                    <ActionButton icon={Pencil} label="Edit" onClick={() => onEdit(template)} />
                    <ActionButton icon={Copy} label="Duplicate" onClick={() => onDuplicate(template)} />
                    <ActionButton icon={Download} label="Export" onClick={() => onExport(template)} />
                    <ActionButton icon={Trash2} label="Delete" onClick={() => onDelete(template)} danger />
                </div>
            </div>

            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto custom-scrollbar px-5 py-4 space-y-5">
                {/* Metadata grid */}
                <div className="grid grid-cols-2 gap-3 text-xs">
                    <MetaItem icon={User} label="Maintainer" value={template.maintainer ?? '—'} />
                    <MetaItem
                        icon={Star}
                        label="Used"
                        value={`${animatedCount} time${animatedCount === 1 ? '' : 's'}`}
                    />
                    <MetaItem
                        icon={Calendar}
                        label="Updated"
                        value={formatDate(template.updatedAt)}
                    />
                    <MetaItem
                        icon={Calendar}
                        label="Last used"
                        value={template.lastUsedAt ? formatDate(template.lastUsedAt) : 'Never'}
                    />
                </div>

                {/* Tags */}
                {template.tags.length > 0 && (
                    <Section icon={Tag} title="Tags">
                        <div className="flex flex-wrap gap-1.5">
                            {template.tags.map(tag => (
                                <span
                                    key={tag}
                                    className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-black/5 dark:bg-white/5 text-ink-secondary"
                                >
                                    {tag}
                                </span>
                            ))}
                        </div>
                    </Section>
                )}

                {/* About */}
                {template.aboutMarkdown && (
                    <Section title="About">
                        <div className="prose-template text-sm text-ink-secondary leading-relaxed">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                                {template.aboutMarkdown}
                            </ReactMarkdown>
                        </div>
                    </Section>
                )}

                {/* Layers */}
                <Section icon={LayersIcon} title={`Layers (${template.layersConfig.length})`}>
                    <div className="space-y-1.5">
                        {template.layersConfig.map((layer, i) => (
                            <div
                                key={layer.id}
                                className="flex items-center gap-2.5 p-2 rounded-md border border-glass-border bg-canvas"
                            >
                                <span className="w-5 h-5 inline-flex items-center justify-center text-[10px] font-bold rounded text-ink-muted bg-black/5 dark:bg-white/5">
                                    {i + 1}
                                </span>
                                <div
                                    className="w-2 h-2 rounded-full shrink-0"
                                    style={{ backgroundColor: layer.color ?? '#6366f1' }}
                                />
                                <span className="text-sm text-ink flex-1 truncate">{layer.name}</span>
                                {layer.description && (
                                    <span className="text-[11px] text-ink-muted truncate max-w-[40%]">{layer.description}</span>
                                )}
                            </div>
                        ))}
                    </div>
                </Section>

                {/* Usage breakdown */}
                {!usageLoading && usage && Object.keys(usage.instancesByWorkspace).length > 0 && (
                    <Section icon={Building2} title="Live instances by workspace">
                        <div className="space-y-1">
                            {Object.entries(usage.instancesByWorkspace).map(([wsId, count]) => {
                                const name = workspaceNameById.get(wsId)
                                return (
                                    <button
                                        key={wsId}
                                        type="button"
                                        onClick={() => navigate(`/workspaces/${wsId}`)}
                                        className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded bg-canvas hover:bg-accent-lineage/5 transition-colors group/row text-left"
                                    >
                                        <span className="flex items-center gap-1.5 min-w-0">
                                            <span className="text-xs font-medium text-ink truncate">
                                                {name ?? wsId}
                                            </span>
                                            <ArrowUpRight className="w-3 h-3 text-ink-muted opacity-0 group-hover/row:opacity-100 transition-opacity" />
                                        </span>
                                        <span className="text-xs font-medium text-ink-muted shrink-0">{count}</span>
                                    </button>
                                )
                            })}
                        </div>
                    </Section>
                )}
            </div>

            <style>{`
                .prose-template h1,
                .prose-template h2,
                .prose-template h3 {
                    font-weight: 600;
                    color: var(--ink, currentColor);
                    margin: 0.75em 0 0.35em;
                    line-height: 1.3;
                }
                .prose-template h1 { font-size: 1.05rem; }
                .prose-template h2 { font-size: 0.95rem; }
                .prose-template h3 { font-size: 0.875rem; }
                .prose-template p { margin: 0.5em 0; }
                .prose-template ul,
                .prose-template ol {
                    padding-left: 1.25em;
                    margin: 0.5em 0;
                }
                .prose-template ul { list-style: disc; }
                .prose-template ol { list-style: decimal; }
                .prose-template li { margin: 0.2em 0; }
                .prose-template code {
                    padding: 1px 4px;
                    font-size: 0.85em;
                    border-radius: 4px;
                    background: rgba(99, 102, 241, 0.08);
                    color: rgb(99, 102, 241);
                    font-family: ui-monospace, monospace;
                }
                .prose-template pre {
                    padding: 0.75em;
                    border-radius: 8px;
                    background: rgba(0, 0, 0, 0.04);
                    overflow-x: auto;
                    margin: 0.5em 0;
                }
                .prose-template pre code {
                    padding: 0;
                    background: transparent;
                    color: var(--ink, currentColor);
                }
                .prose-template strong { font-weight: 600; color: var(--ink, currentColor); }
                .prose-template em { font-style: italic; }
                .prose-template a {
                    color: rgb(99, 102, 241);
                    text-decoration: underline;
                    text-underline-offset: 2px;
                }
                .prose-template blockquote {
                    border-left: 2px solid rgba(99, 102, 241, 0.4);
                    padding-left: 0.75em;
                    margin: 0.5em 0;
                    color: var(--ink-muted, currentColor);
                }
                .prose-template table {
                    border-collapse: collapse;
                    margin: 0.5em 0;
                    font-size: 0.8125rem;
                }
                .prose-template th,
                .prose-template td {
                    border: 1px solid var(--glass-border, rgba(0,0,0,0.08));
                    padding: 4px 8px;
                    text-align: left;
                }
            `}</style>
        </>
    )
}

function ActionButton({
    icon: Icon, label, onClick, danger,
}: {
    icon: React.ComponentType<{ className?: string }>
    label: string
    onClick: () => void
    danger?: boolean
}) {
    return (
        <button
            onClick={onClick}
            className={cn(
                'inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors',
                danger
                    ? 'text-ink-muted hover:text-red-500 hover:bg-red-500/5'
                    : 'text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5',
            )}
        >
            <Icon className="w-3.5 h-3.5" />
            {label}
        </button>
    )
}

function MetaItem({
    icon: Icon, label, value,
}: {
    icon: React.ComponentType<{ className?: string }>
    label: string
    value: string
}) {
    return (
        <div className="space-y-0.5">
            <div className="text-[10px] uppercase tracking-wider text-ink-muted font-medium inline-flex items-center gap-1">
                <Icon className="w-3 h-3" />
                {label}
            </div>
            <div className="text-ink truncate">{value}</div>
        </div>
    )
}

function Section({
    icon: Icon, title, children,
}: {
    icon?: React.ComponentType<{ className?: string }>
    title: string
    children: React.ReactNode
}) {
    return (
        <div>
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-ink-muted mb-2 inline-flex items-center gap-1.5">
                {Icon && <Icon className="w-3 h-3" />}
                {title}
            </h4>
            {children}
        </div>
    )
}

function formatDate(iso: string): string {
    try {
        const d = new Date(iso)
        if (Number.isNaN(d.getTime())) return iso
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    } catch {
        return iso
    }
}
