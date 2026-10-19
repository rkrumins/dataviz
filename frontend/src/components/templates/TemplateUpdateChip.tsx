/**
 * "Template updated" — shown to someone who may edit a view built from a layout
 * template that has moved on since, and opens the review.
 *
 * Renders nothing unless all of it holds: the view names a template the reader
 * can open, records the version it matched, and that version is behind. A view
 * still living in a draft is left alone — its layers are not the view's yet.
 */
import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { HoverTip } from '@/components/ui/HoverTip'
import { useLayoutTemplate } from '@/hooks/useLayoutTemplates'
import { cn } from '@/lib/utils'
import type { View } from '@/services/viewApiService'
import { TemplateUpdateDialog } from './TemplateUpdateDialog'

export function TemplateUpdateChip({ view, canEdit, variant = 'badge' }: {
    view: View
    canEdit: boolean
    /** A badge in the view header, or an inline link in its details. */
    variant?: 'badge' | 'inline'
}) {
    const [open, setOpen] = useState(false)
    const eligible = canEdit && !view.draftBranchId && view.contextModelVersion != null
    const { data: template } = useLayoutTemplate(eligible ? view.contextModelId : null)
    if (!eligible || !template || template.version <= (view.contextModelVersion ?? 0)) return null

    const behind = template.version - (view.contextModelVersion ?? 0)
    return (
        <>
            <HoverTip
                className="inline-flex shrink-0"
                label={`"${template.name}" has ${behind === 1 ? 'a new version' : `${behind} new versions`}`}
                detail="See what changed and choose what to bring into this view"
            >
                <button
                    type="button"
                    onClick={e => { e.preventDefault(); setOpen(true) }}
                    aria-label={`Review the update to ${template.name}`}
                    className={cn(
                        'inline-flex items-center gap-1 font-semibold transition-colors',
                        variant === 'badge'
                            ? 'px-2 py-0.5 rounded-full text-[11px] bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300 border border-fuchsia-500/20 hover:bg-fuchsia-500/20'
                            : 'text-[11px] text-fuchsia-600 dark:text-fuchsia-400 hover:underline',
                    )}
                >
                    <Sparkles className="w-3 h-3" aria-hidden />
                    {variant === 'badge' ? 'Template updated' : `v${template.version} available`}
                </button>
            </HoverTip>
            {open && <TemplateUpdateDialog view={view} template={template} onClose={() => setOpen(false)} />}
        </>
    )
}
