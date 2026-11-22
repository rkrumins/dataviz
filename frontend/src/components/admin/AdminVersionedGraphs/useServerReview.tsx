/**
 * The review as the server answers it, in the parts the kit's review draws (`ChangeReviewBody`, and
 * the dialog built on it): the full preview drawn as a report (told in the app's view), or why it
 * couldn't be worked out, with Try again; whether it is on its way or failed; its warnings to
 * acknowledge, with the values new limits would leave outside them; and a refused save in words.
 *
 * `SettingsReview` (the review dialog) and the guided setup's last step both draw from it. A module
 * of its own, beside SettingsReview, so that file stays one of components alone.
 */
import type { ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useLens, type ReviewWarning, type Setting } from '@/components/settings'
import { settingsKeys, type Impact, type SettingsRequestError } from '@/services/settingsService'
import { ImpactReport } from './ImpactReport'
import { refusalWords, reviewWarnings } from './reviewText'

export interface ServerReview {
    /** The full preview as a report, why it couldn't be worked out, or the note said in its place. */
    impact: ReactNode
    impactLoading: boolean
    impactFailed: boolean
    warnings: ReviewWarning[]
    /** A refused save, in words. */
    error: string | undefined
}

export function useServerReview({ impact, impactPending, impactError, onRetryImpact, impactNote, settings, error }: {
    impact: Impact | null | undefined
    impactPending: boolean
    impactError: SettingsRequestError | null
    /** Asks for the full preview again; without it, the review asks the open one again itself. */
    onRetryImpact?: () => void
    /** Said in place of the impact when it can't be worked out here. */
    impactNote?: ReactNode
    settings: Record<string, Setting>
    error: SettingsRequestError | null
}): ServerReview {
    const qc = useQueryClient()
    const [lens] = useLens()
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
    ) : impact ? <ImpactReport impact={impact} settings={settings} lens={lens} />
        : impactNote ? <p className="text-[13px] text-ink-secondary">{impactNote}</p> : undefined
    return {
        impact: drawn,
        impactLoading: impactPending && !impact,
        impactFailed: failed,
        warnings: reviewWarnings(impact),
        error: error ? refusalWords(error, settings) : undefined,
    }
}
