/**
 * SettingsReview — the kit's ChangeReviewDialog with what the server says: the full preview drawn
 * as a report, its warnings to acknowledge (and values the new limits would leave outside them),
 * and a refused save in words, with "Reload and re-apply my changes" after a version conflict.
 *
 * Save waits for the full preview: its warnings are part of what is acknowledged. When it can't be
 * worked out, the review says so, offers to try again, and saves only once the person chooses to
 * save without seeing what the change does.
 *
 * The page's editor (`useSettingsEditor`) and History's revert both open it.
 */
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CircleCheck, RotateCw, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ChangeReviewDialog, type DimensionInfo, type ReviewItem, type Setting } from '@/components/settings'
import { settingsKeys, type Impact, type SettingsRequestError } from '@/services/settingsService'
import { ImpactReport } from './ImpactReport'
import { refusalWords, reviewWarnings } from './reviewText'

/**
 * After a save, where the save bar was: what was saved, and Undo, for as long as the toast's. The
 * toast is the app's, outside a drawer's focus; this one is inside, within reach of the keyboard.
 */
export function SavedBar({ saved }: { saved: { words: string; undo: () => void } | null }) {
    if (!saved) return null
    return (
        <div className="sticky bottom-4 z-30 px-0 sm:px-4">
            <div className={'mx-auto flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-emerald-500/25 bg-canvas-elevated px-4 py-3 '
                + 'shadow-[0_1px_2px_rgba(15,23,42,0.08),0_18px_48px_-18px_rgba(15,23,42,0.45)] dark:shadow-[0_18px_48px_-18px_rgba(0,0,0,0.9)]'}>
                <CircleCheck aria-hidden className="w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <p className="min-w-0 flex-1 text-[13px] font-medium text-ink">{saved.words}</p>
                <Button variant="ghost" leftIcon={Undo2} onClick={saved.undo} aria-label="Undo this save" className="text-ink-secondary">Undo</Button>
            </div>
        </div>
    )
}

export function SettingsReview({
    open, onOpenChange, items, where, settings, dimensions, impact, impactPending, impactError, onRetryImpact, impactNote, onSave,
    saving, error, onReapply, round,
}: {
    open: boolean
    onOpenChange: (open: boolean) => void
    items: ReviewItem[]
    where: string
    settings: Record<string, Setting>
    dimensions: DimensionInfo[]
    impact: Impact | null | undefined
    impactPending: boolean
    impactError: SettingsRequestError | null
    /** Asks for the full preview again; without it, the review asks the open one again itself. */
    onRetryImpact?: () => void
    /** Said in place of the impact when it can't be worked out here. */
    impactNote?: ReactNode
    onSave: (reason: string) => void | Promise<void>
    saving: boolean
    error: SettingsRequestError | null
    onReapply?: () => void
    /** A new value starts a fresh review: an empty reason, nothing acknowledged. */
    round: number
}) {
    const qc = useQueryClient()
    const retry = onRetryImpact ?? (() => void qc.refetchQueries({ queryKey: [...settingsKeys.all, 'preview', 'full'], type: 'active' }))
    // Failed: no answer for these values, and none on its way. An answer kept from before still stands.
    const failed = !impact && Boolean(impactError) && !impactPending
    const drawn = failed && impactError ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.05] px-4 py-3">
            <p className="min-w-0 flex-1 text-[13px] text-ink-secondary">
                Couldn’t work out what this changes: {impactError.message}.
            </p>
            <Button size="sm" variant="secondary" leftIcon={RotateCw} onClick={retry}>Try again</Button>
        </div>
    ) : impact ? <ImpactReport impact={impact} settings={settings} />
        : impactNote ? <p className="text-[13px] text-ink-secondary">{impactNote}</p> : undefined

    return (
        <ChangeReviewDialog
            key={round}
            open={open}
            onOpenChange={onOpenChange}
            items={items}
            where={where}
            dimensions={dimensions}
            impact={drawn}
            impactLoading={impactPending && !impact}
            impactFailed={failed}
            warnings={reviewWarnings(impact)}
            onSave={onSave}
            saving={saving}
            error={error ? refusalWords(error, settings) : undefined}
            onReapply={onReapply}
        />
    )
}
