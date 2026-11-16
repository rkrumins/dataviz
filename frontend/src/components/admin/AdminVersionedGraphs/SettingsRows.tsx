/**
 * One setting's row on a settings page or in a graph's drawer: the kit's SettingRow, plus what the
 * page knows about it — the server's answer for a staged value (quick preview), the platform's
 * limits (editable on the platform, in words below it), and its explainer.
 *
 * The answer heads the row ("Once saved: …"); under the control it says what that means: the
 * worked example, or why the value in force would differ, with the fix one click away.
 *
 * Rows are memoised and take only primitives and stable callbacks, so staging one value redraws
 * that row (and those whose rule reads it), never all of them. An explainer reads the values in
 * force and staged from `VisualContext` and is drawn only while its row's guidance is open, so
 * it alone redraws as values are staged.
 */
import { memo, useCallback, useContext, useMemo } from 'react'
import { CircleCheck } from 'lucide-react'
import {
    SettingRow, SettingVisual, STATUS_META, WhyBanner, formatValue, ownValue, sameValue,
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

const plainStatus = (q: PreviewItem) => q.status === 'in_effect' || q.status === 'exception'

/** Whether the server's answer says anything here: a staged value's meaning, or a change elsewhere that moves this one. */
const outcomeShown = (r: ResolvedSetting, quick: PreviewItem | undefined, staged: boolean) =>
    quick ? (staged ? !plainStatus(quick) || Boolean(quick.example) : !sameValue(quick.effective, r.effective) || quick.status !== r.status) : false

/** What the server says a staged value, or a change elsewhere, would mean here — and, when the value in force would differ, why and the fix. */
function Outcome({ s, quick, staged, onFix, fixLabel }: {
    s: Setting
    quick: PreviewItem
    staged: boolean
    onFix?: (fix: WhyFix, item: WhyItem) => void
    fixLabel: (fix: WhyFix) => string
}) {
    const plain = plainStatus(quick)
    // A staged row's header already says what is in force once saved.
    const lead = staged
        ? plain ? null : `${STATUS_META[quick.status].label} once saved:`
        : `With your changes: ${formatValue(s, quick.effective)}${plain ? '' : ` · ${STATUS_META[quick.status].label}`}`
    return (
        <div className="space-y-1.5 text-[11.5px] leading-relaxed text-ink-secondary">
            {lead && <p className="font-semibold text-ink">{lead}</p>}
            {plain ? quick.example && (
                <p className="flex items-start gap-2 rounded-xl bg-black/[0.025] px-3 py-2 dark:bg-white/[0.035]">
                    <CircleCheck aria-hidden className="mt-0.5 w-3.5 h-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <span className="min-w-0">{quick.example}</span>
                </p>
            ) : <WhyBanner why={quick.why} onFix={onFix} fixLabel={fixLabel} compact />}
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
    const isStaged = staged !== undefined
    // A staged row's answer counts only once it is for the value staged now, and never while it needs a fix.
    const answer = quick && (!isStaged || (!error && sameValue(ownValue(quick, scope), staged))) ? quick : undefined
    const showOutcome = outcomeShown(resolved, answer, isStaged)
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
            preview={quick}
            checking={checking}
            onFix={onFix}
            fixLabel={fixLabel}
            dimensions={dimensions}
            glossary={glossary}
            visual={visual}
            highlighted={highlighted}
        >
            {((showOutcome && answer) || limits) && (
                <div className="space-y-3">
                    {showOutcome && answer && <Outcome s={s} quick={answer} staged={isStaged} onFix={onFix} fixLabel={fixLabel} />}
                    {limits}
                </div>
            )}
        </SettingRow>
    )
})
