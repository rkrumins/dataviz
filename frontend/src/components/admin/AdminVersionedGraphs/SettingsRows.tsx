/**
 * One setting's row on a settings page or in a graph's drawer: the kit's SettingRow, plus what the
 * page knows about it — the server's answer for a staged value (quick preview), the platform's
 * limits (editable on the platform, in words below it), and its explainer.
 *
 * Rows are memoised and take only primitives and stable callbacks, so staging one value redraws
 * that row (and those whose rule reads it), never all of them. An explainer reads the values in
 * force and staged from `VisualContext` and is drawn only while its row's guidance is open, so
 * it alone redraws as values are staged.
 */
import { memo, useCallback, useContext, useMemo } from 'react'
import { CircleCheck, Info, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    SettingRow, SettingVisual, STATUS_META, formatValue, sameValue,
    type DimensionInfo, type Lens, type Limits, type ResolvedSetting, type Scope, type Setting,
    type SettingValue, type Term, type WhyFix, type WhyItem,
} from '@/components/settings'
import type { PreviewItem } from '@/services/settingsService'
import { LimitsEditor, LimitsNote } from './LimitsEditor'
import { limitsNoteShown } from './limits'
import { VisualContext } from './visualContext'

function LiveVisual({ setting }: { setting: Setting }) {
    const ctx = useContext(VisualContext)
    if (!ctx) return null
    return <SettingVisual setting={setting} settings={ctx.settings} current={ctx.current} next={ctx.next} facts={ctx.facts} onStage={ctx.stage} />
}

/** Whether the server's answer for the staged values says anything about this row. */
const outcomeShown = (r: ResolvedSetting, quick: PreviewItem | undefined, staged: boolean, checking: boolean) =>
    quick ? staged || !sameValue(quick.effective, r.effective) || quick.status !== r.status : staged && checking

/** What the server says a staged value, or a change elsewhere, would leave in force here. */
function Outcome({ s, quick, staged }: { s: Setting; quick: PreviewItem | undefined; staged: boolean }) {
    if (!quick) {
        return (
            <p className="flex items-center gap-1.5 text-[11.5px] text-ink-muted">
                <Loader2 aria-hidden className="w-3 h-3 animate-spin motion-reduce:animate-none" /> Checking what this does…
            </p>
        )
    }
    const plain = quick.status === 'in_effect' || quick.status === 'exception'
    const why = quick.why[0]?.text
    return (
        <div className={cn('flex items-start gap-2 rounded-xl px-3 py-2 text-[11.5px] leading-relaxed',
            plain ? 'bg-black/[0.025] text-ink-secondary dark:bg-white/[0.035]' : 'bg-amber-500/[0.07] text-ink-secondary')}>
            {plain
                ? <CircleCheck aria-hidden className="mt-0.5 w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                : <Info aria-hidden className="mt-0.5 w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-400" />}
            <p className="min-w-0">
                <span className="font-semibold text-ink">{staged ? 'Once saved' : 'With your changes'}: {formatValue(s, quick.effective)}</span>
                {!plain && <> · {STATUS_META[quick.status].label}{why ? `: ${why}` : ''}</>}
                {plain && quick.example && <span className="block text-ink-muted">{quick.example}</span>}
            </p>
        </div>
    )
}

export interface RowItemProps {
    setting: Setting
    resolved: ResolvedSetting
    scope: Scope
    lens: Lens
    /** A value staged here; undefined when none is. */
    staged: SettingValue | null | undefined
    error?: string
    quick?: PreviewItem
    /** The quick preview is on its way. */
    checking: boolean
    /** The platform's limits: editable here (a system admin on the platform). */
    editLimits: boolean
    stagedLimits: Limits | null | undefined
    limitError?: string
    /** The platform's own value once saved: always among the allowed. */
    platformValue?: SettingValue
    highlighted: boolean
    onStage: (key: string, value: SettingValue | null) => void
    onUnstage: (key: string) => void
    onStageLimits: (key: string, limits: Limits | null) => void
    onUnstageLimits: (key: string) => void
    onFix?: (fix: WhyFix, item: WhyItem) => void
    fixLabel: (fix: WhyFix) => string
    dimensions: DimensionInfo[]
    glossary: Term[]
}

export const RowItem = memo(function RowItem({
    setting: s, resolved, scope, lens, staged, error, quick, checking, editLimits, stagedLimits, limitError, platformValue,
    highlighted, onStage, onUnstage, onStageLimits, onUnstageLimits, onFix, fixLabel, dimensions, glossary,
}: RowItemProps) {
    const stage = useCallback((v: SettingValue | null) => onStage(s.key, v), [onStage, s.key])
    const unstage = useCallback(() => onUnstage(s.key), [onUnstage, s.key])
    const visual = useMemo(() => (s.visual ? <LiveVisual setting={s} /> : undefined), [s])
    const showOutcome = outcomeShown(resolved, quick, staged !== undefined, checking)
    const limits = editLimits && s.limitable.length > 0
        ? <LimitsEditor setting={s} resolved={resolved} staged={stagedLimits} platformValue={platformValue ?? resolved.effective}
            error={limitError} onStage={onStageLimits} onUnstage={onUnstageLimits} />
        : scope !== 'platform' && limitsNoteShown(s, resolved) ? <LimitsNote setting={s} resolved={resolved} /> : null
    return (
        <SettingRow
            setting={s}
            resolved={resolved}
            scope={scope}
            lens={lens}
            staged={staged}
            onStage={stage}
            onUnstage={unstage}
            error={error}
            onFix={onFix}
            fixLabel={fixLabel}
            dimensions={dimensions}
            glossary={glossary}
            visual={visual}
            highlighted={highlighted}
        >
            {(showOutcome || limits) && (
                <div className="space-y-3">
                    {showOutcome && <Outcome s={s} quick={quick} staged={staged !== undefined} />}
                    {limits}
                </div>
            )}
        </SettingRow>
    )
})
