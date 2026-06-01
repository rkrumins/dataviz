/**
 * PickTemplateDialog — modal listing every template in the gallery so the
 * user can choose one to duplicate.
 */
import { useMemo, useState } from 'react'
import { Copy, Search, Layers as LayersIcon } from 'lucide-react'
import { TemplateDialogShell } from './TemplateDialogShell'
import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { useTemplatesList } from '@/hooks/useTemplates'
import type { ContextModel } from '@/services/contextModelService'

interface PickTemplateDialogProps {
    isOpen: boolean
    onClose: () => void
    onPick: (template: ContextModel) => void
}

export function PickTemplateDialog({ isOpen, onClose, onPick }: PickTemplateDialogProps) {
    const { data: templates = [], isLoading } = useTemplatesList({ scope: 'all', sort: 'popular' })
    const [search, setSearch] = useState('')

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase()
        if (!q) return templates
        return templates.filter(
            (t) =>
                t.name.toLowerCase().includes(q) ||
                (t.description?.toLowerCase().includes(q) ?? false) ||
                t.tags.some((tag) => tag.toLowerCase().includes(q)),
        )
    }, [templates, search])

    return (
        <TemplateDialogShell
            isOpen={isOpen}
            onClose={onClose}
            title="Duplicate template"
            subtitle="Pick a template to clone — you'll be able to rename and re-scope it."
            icon={<Copy className="w-4 h-4" />}
            accentColor="#a855f7"
            size="lg"
        >
            <div className="space-y-3">
                <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
                    <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        autoFocus
                        placeholder="Search templates…"
                        className="w-full pl-8 pr-3 py-2 text-sm rounded-lg bg-canvas border border-glass-border text-ink focus:outline-none focus:border-accent-lineage/50 focus:ring-1 focus:ring-accent-lineage/30"
                    />
                </div>

                {isLoading ? (
                    <div className="text-center py-10 text-sm text-ink-muted">
                        Loading templates…
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="text-center py-10 text-sm text-ink-muted">
                        No templates available.
                    </div>
                ) : (
                    <div className="max-h-[50vh] overflow-y-auto custom-scrollbar space-y-1 -mx-1 px-1">
                        {filtered.map((t) => {
                            const accent = t.accentColor ?? '#6366f1'
                            return (
                                <button
                                    key={t.id}
                                    type="button"
                                    onClick={() => onPick(t)}
                                    className="w-full flex items-center gap-3 p-2.5 rounded-lg border border-transparent hover:border-glass-border hover:bg-black/[0.025] dark:hover:bg-white/[0.025] transition-colors text-left"
                                >
                                    <div
                                        className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                                        style={{
                                            backgroundColor: `${accent}15`,
                                            color: accent,
                                            border: `1px solid ${accent}30`,
                                        }}
                                    >
                                        <DynamicIcon name={t.icon ?? 'LayoutTemplate'} className="w-4 h-4" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="text-sm font-medium text-ink truncate">{t.name}</div>
                                        <div className="text-[11px] text-ink-muted truncate inline-flex items-center gap-1">
                                            <LayersIcon className="w-2.5 h-2.5" />
                                            {t.layersConfig.length} layer{t.layersConfig.length === 1 ? '' : 's'}
                                            <span className="mx-1">·</span>
                                            used {t.instantiationCount} time{t.instantiationCount === 1 ? '' : 's'}
                                        </div>
                                    </div>
                                </button>
                            )
                        })}
                    </div>
                )}
            </div>
        </TemplateDialogShell>
    )
}
