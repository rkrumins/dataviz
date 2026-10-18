/**
 * The Templates page's Requests tab, for template managers: every team
 * template someone asked to offer to everyone, with its layout, who asked and
 * why, and the answer right there.
 */
import { CheckCircle2 } from 'lucide-react'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import type { LayoutTemplate } from '@/services/layoutTemplateService'
import { AudienceBadge } from './TemplateCard'
import { PromotionDecision } from './PromotionDecision'
import { TemplatePreview } from './TemplatePreview'

export function PromotionRequestsPanel({ requests, isLoading, onOpen }: {
    requests: readonly LayoutTemplate[]
    isLoading: boolean
    onOpen: (template: LayoutTemplate) => void
}) {
    if (isLoading) {
        return (
            <div className="space-y-4">
                {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-[180px] rounded-2xl" />)}
            </div>
        )
    }
    if (requests.length === 0) {
        return (
            <div className="rounded-2xl border border-dashed border-slate-200 dark:border-slate-700 bg-canvas-elevated/40">
                <EmptyState icon={CheckCircle2} title="No requests waiting"
                    description="When someone asks for their template to be offered to everyone, it waits here — and in your inbox." />
            </div>
        )
    }
    return (
        <ul className="space-y-4">
            {requests.map(t => (
                <li key={t.id} className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] rounded-2xl border border-glass-border bg-canvas-elevated p-4">
                    <div className="min-w-0">
                        <AudienceBadge template={t} />
                        <button
                            type="button"
                            onClick={() => onOpen(t)}
                            className="block mt-2 text-left text-sm font-bold text-ink hover:text-indigo-600 dark:hover:text-indigo-400"
                        >
                            {t.name}
                        </button>
                        {t.description && <p className="mt-1 text-xs text-ink-muted line-clamp-2">{t.description}</p>}
                        <div className="mt-3">
                            <TemplatePreview layers={t.layers} />
                        </div>
                        <p className="mt-2 text-[11px] text-ink-muted">
                            {t.layers.length} layer{t.layers.length === 1 ? '' : 's'}
                            {t.usageCount > 0 && ` · used in ${t.usageCount} view${t.usageCount === 1 ? '' : 's'}`}
                        </p>
                    </div>
                    <PromotionDecision template={t} />
                </li>
            ))}
        </ul>
    )
}
