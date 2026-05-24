/**
 * TemplateCard — gallery tile for one ContextViewCanvas template.
 *
 * Pure-presentational: actions are surfaced via the `onMenuAction` callback
 * so the parent owns dialog/state management. Icon and accent color come
 * from the template's metadata; falls back to a sensible default if absent.
 */
import { motion } from 'framer-motion'
import {
    Star, MoreVertical, Eye, Copy, Download, Trash2, Pencil, Globe2,
    Building2, Pin, Layers as LayersIcon,
} from 'lucide-react'
import { useState, useRef, useEffect } from 'react'
import { DynamicIcon } from '@/components/ui/DynamicIcon'
import type { ContextModel } from '@/services/contextModelService'
import { cn } from '@/lib/utils'

export type TemplateCardAction = 'open' | 'edit' | 'duplicate' | 'export' | 'delete'

interface TemplateCardProps {
    template: ContextModel
    onMenuAction: (action: TemplateCardAction, template: ContextModel) => void
    onOpen: (template: ContextModel) => void
    delayMs?: number
}

const DEFAULT_ACCENT = '#6366f1'
const DEFAULT_ICON = 'LayoutTemplate'

export function TemplateCard({ template, onMenuAction, onOpen, delayMs = 0 }: TemplateCardProps) {
    const accent = template.accentColor || DEFAULT_ACCENT
    const icon = template.icon || DEFAULT_ICON
    const isGlobal = template.workspaceId == null
    const layerCount = template.layersConfig?.length ?? 0

    const [menuOpen, setMenuOpen] = useState(false)
    const menuRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!menuOpen) return
        const onClick = (e: MouseEvent) => {
            if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
        }
        document.addEventListener('mousedown', onClick)
        return () => document.removeEventListener('mousedown', onClick)
    }, [menuOpen])

    return (
        <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, delay: delayMs / 1000 }}
            className="group relative glass-panel rounded-2xl border border-glass-border hover:border-current/40 transition-all hover:-translate-y-0.5 hover:shadow-xl overflow-hidden"
            style={{ ['--card-accent' as string]: accent }}
        >
            {/* Accent gradient wash on hover */}
            <div
                className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
                style={{
                    background: `linear-gradient(135deg, ${accent}08, transparent 60%)`,
                }}
            />

            {/* Pin badge */}
            {template.isPinned && (
                <div className="absolute top-2 right-10 z-10">
                    <div
                        className="w-6 h-6 rounded-full flex items-center justify-center"
                        style={{ backgroundColor: `${accent}20`, color: accent }}
                        title="Pinned"
                    >
                        <Pin className="w-3 h-3" />
                    </div>
                </div>
            )}

            {/* Menu */}
            <div ref={menuRef} className="absolute top-2 right-2 z-10">
                <button
                    onClick={(e) => { e.stopPropagation(); setMenuOpen(o => !o) }}
                    className="w-7 h-7 rounded-md flex items-center justify-center text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 hover:text-ink transition-colors"
                >
                    <MoreVertical className="w-3.5 h-3.5" />
                </button>
                {menuOpen && (
                    <div className="absolute right-0 top-full mt-1 w-44 rounded-lg border border-glass-border bg-canvas-elevated shadow-lg shadow-black/15 py-1 z-20">
                        <MenuItem icon={Eye} label="Open details" onClick={() => { setMenuOpen(false); onMenuAction('open', template) }} />
                        <MenuItem icon={Pencil} label="Edit" onClick={() => { setMenuOpen(false); onMenuAction('edit', template) }} />
                        <MenuItem icon={Copy} label="Duplicate" onClick={() => { setMenuOpen(false); onMenuAction('duplicate', template) }} />
                        <MenuItem icon={Download} label="Export JSON" onClick={() => { setMenuOpen(false); onMenuAction('export', template) }} />
                        <div className="border-t border-glass-border my-1" />
                        <MenuItem icon={Trash2} label="Delete" onClick={() => { setMenuOpen(false); onMenuAction('delete', template) }} danger />
                    </div>
                )}
            </div>

            <button
                type="button"
                onClick={() => onOpen(template)}
                className="relative w-full text-left p-5 flex flex-col gap-3 cursor-pointer"
            >
                <div className="flex items-start gap-3">
                    <div
                        className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 transition-transform group-hover:scale-105"
                        style={{ backgroundColor: `${accent}15`, color: accent, border: `1px solid ${accent}30` }}
                    >
                        <DynamicIcon name={icon} className="w-5 h-5" />
                    </div>
                    <div className="min-w-0 flex-1 pr-6">
                        <div className="flex items-center gap-1.5 mb-0.5">
                            <h3 className="font-semibold text-sm text-ink truncate">{template.name}</h3>
                        </div>
                        <p className="text-xs text-ink-muted line-clamp-2 leading-snug">
                            {template.description || 'No description'}
                        </p>
                    </div>
                </div>

                {template.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                        {template.tags.slice(0, 3).map(tag => (
                            <span
                                key={tag}
                                className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-black/5 dark:bg-white/5 text-ink-muted"
                            >
                                {tag}
                            </span>
                        ))}
                        {template.tags.length > 3 && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium text-ink-muted">
                                +{template.tags.length - 3}
                            </span>
                        )}
                    </div>
                )}

                <div className="flex items-center justify-between pt-2 mt-auto border-t border-glass-border/40">
                    <div className="flex items-center gap-3 text-[11px] text-ink-muted">
                        <span className="inline-flex items-center gap-1">
                            <LayersIcon className="w-3 h-3" />
                            {layerCount} {layerCount === 1 ? 'layer' : 'layers'}
                        </span>
                        <span
                            className="inline-flex items-center gap-1"
                            title={`Used ${template.instantiationCount} times`}
                        >
                            <Star className="w-3 h-3" />
                            {template.instantiationCount}
                        </span>
                    </div>
                    <div
                        className={cn(
                            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider',
                            isGlobal
                                ? 'bg-blue-500/10 text-blue-500'
                                : 'bg-emerald-500/10 text-emerald-500',
                        )}
                    >
                        {isGlobal ? <Globe2 className="w-2.5 h-2.5" /> : <Building2 className="w-2.5 h-2.5" />}
                        {isGlobal ? 'Global' : 'Workspace'}
                    </div>
                </div>
            </button>
        </motion.div>
    )
}

function MenuItem({
    icon: Icon,
    label,
    onClick,
    danger,
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
                'w-full px-3 py-1.5 text-left text-sm flex items-center gap-2 transition-colors',
                danger
                    ? 'text-red-500 hover:bg-red-500/5'
                    : 'text-ink hover:bg-black/5 dark:hover:bg-white/5',
            )}
        >
            <Icon className="w-3.5 h-3.5" />
            {label}
        </button>
    )
}
