/**
 * One template in the library: its layout at a glance, who can use it, who
 * made it, how much it is used — and the actions the server says this person
 * may take, nothing more.
 */
import { useEffect, useRef, useState } from 'react'
import {
    ArrowRight, Copy, Eye, EyeOff, MoreHorizontal, Pencil, Share2, Trash2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { HoverTip } from '@/components/ui/HoverTip'
import { PersonChip } from '@/components/ui/PersonChip'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import type { LayoutTemplate } from '@/services/layoutTemplateService'
import { TemplatePreview } from './TemplatePreview'
import { AUDIENCE, audienceOf, categoryLabel, menuActions, type TemplateAction } from './templateAudience'

const ACTION_META: Record<Exclude<TemplateAction, 'use'>, { label: string; icon: LucideIcon; danger?: boolean }> = {
    edit: { label: 'Edit', icon: Pencil },
    duplicate: { label: 'Duplicate', icon: Copy },
    share: { label: 'Share', icon: Share2 },
    hide: { label: 'Hide for everyone', icon: EyeOff },
    show: { label: 'Show to everyone', icon: Eye },
    delete: { label: 'Delete', icon: Trash2, danger: true },
}

export function AudienceBadge({ template }: { template: LayoutTemplate }) {
    const audience = audienceOf(template)
    const meta = AUDIENCE[audience]
    const Icon = meta.icon
    const label = audience === 'workspace' && template.workspaceName ? template.workspaceName : meta.label
    return (
        <span className={cn(
            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-semibold max-w-[11rem]',
            meta.badge,
        )}>
            <Icon className="w-3 h-3 shrink-0" />
            <span className="truncate">{label}</span>
        </span>
    )
}

function ActionsMenu({ template, onAction }: {
    template: LayoutTemplate
    onAction: (action: TemplateAction) => void
}) {
    const [open, setOpen] = useState(false)
    const ref = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!open) return
        const onDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
        }
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onDown)
            document.removeEventListener('keydown', onKey)
        }
    }, [open])

    return (
        <div ref={ref} className="relative" onClick={e => e.stopPropagation()}>
            <button
                type="button"
                aria-label={`More actions for ${template.name}`}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen(o => !o)}
                className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
                <MoreHorizontal className="w-4 h-4" />
            </button>
            {open && (
                <div
                    role="menu"
                    className="absolute right-0 top-full mt-1 z-30 w-52 py-1 rounded-2xl border border-glass-border bg-white dark:bg-slate-900 shadow-lg"
                >
                    {menuActions(template).map(action => {
                        const { label, icon: Icon, danger } = ACTION_META[action]
                        return (
                            <button
                                key={action}
                                type="button"
                                role="menuitem"
                                onClick={() => { setOpen(false); onAction(action) }}
                                className={cn(
                                    'w-[calc(100%-4px)] mx-0.5 flex items-center gap-2.5 px-3.5 py-2 rounded-xl text-sm font-medium transition-colors',
                                    danger
                                        ? 'text-red-600 dark:text-red-400 hover:bg-red-500/10'
                                        : 'text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5',
                                )}
                            >
                                <Icon className="w-3.5 h-3.5" />
                                {label}
                            </button>
                        )
                    })}
                </div>
            )}
        </div>
    )
}

export function TemplateCard({ template, onOpen, onAction }: {
    template: LayoutTemplate
    onOpen: () => void
    onAction: (action: TemplateAction) => void
}) {
    const usage = template.usageCount
    return (
        <div
            onClick={onOpen}
            className={cn(
                'group relative flex flex-col rounded-2xl border bg-canvas-elevated p-4 cursor-pointer',
                'transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-indigo-500/5',
                template.hidden
                    ? 'border-dashed border-slate-300 dark:border-slate-600 opacity-75'
                    : 'border-glass-border hover:border-indigo-300/60 dark:hover:border-indigo-500/40',
            )}
        >
            <div className="flex items-center gap-1.5 mb-2.5 min-h-[28px]">
                <AudienceBadge template={template} />
                {template.category && (
                    <span className="px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 truncate">
                        {categoryLabel(template.category)}
                    </span>
                )}
                {template.hidden && (
                    <HoverTip label="Hidden from everyone but template managers" detail="Show it to put it back in everyone's library.">
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-slate-500/10 text-slate-500">
                            <EyeOff className="w-3 h-3" /> Hidden
                        </span>
                    </HoverTip>
                )}
                <div className="ml-auto">
                    <ActionsMenu template={template} onAction={onAction} />
                </div>
            </div>

            <button
                type="button"
                onClick={e => { e.stopPropagation(); onOpen() }}
                className="text-left text-sm font-bold text-ink leading-snug hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors focus:outline-none focus-visible:underline"
            >
                {template.name}
            </button>
            <p className={cn(
                'mt-1 text-xs leading-snug line-clamp-2 min-h-[2rem]',
                template.description ? 'text-ink-muted' : 'text-ink-muted/60 italic',
            )}>
                {template.description || `${template.layers.length} layer${template.layers.length === 1 ? '' : 's'}, no description yet.`}
            </p>

            <div className="mt-3">
                <TemplatePreview layers={template.layers} />
            </div>

            <div className="mt-3.5 pt-3 border-t border-glass-border/70 flex items-center gap-2 text-[11px] text-ink-muted">
                <span className="min-w-0 flex-1">
                    {template.builtIn || !template.createdBy
                        ? <span className="font-medium">Built-in</span>
                        : <PersonChip id={template.createdBy} size="xs" link={false} />}
                </span>
                <HoverTip label={usage === 0 ? 'No views use it yet' : `${usage} view${usage === 1 ? '' : 's'} you can open were built from it`}>
                    <span className="shrink-0 tabular-nums">
                        {usage === 0 ? 'Unused' : `Used in ${usage} view${usage === 1 ? '' : 's'}`}
                    </span>
                </HoverTip>
                <span aria-hidden className="text-ink-muted/40">·</span>
                <span className="shrink-0">{timeAgo(template.updatedAt)}</span>
            </div>

            <button
                type="button"
                onClick={e => { e.stopPropagation(); onAction('use') }}
                className={cn(
                    'absolute right-3 bottom-2.5 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold',
                    'bg-gradient-to-r from-indigo-500 to-violet-600 text-white shadow-md shadow-indigo-500/25',
                    'opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 focus-visible:opacity-100 focus-visible:translate-y-0',
                    'transition-all duration-200',
                )}
            >
                Use template <ArrowRight className="w-3.5 h-3.5" />
            </button>
        </div>
    )
}
