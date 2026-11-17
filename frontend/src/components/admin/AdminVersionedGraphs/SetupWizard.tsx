/**
 * SetupWizard — "Set up with a guide": a few plain questions, then the usual review, on the app's
 * own wizard chrome (`WizardShell`).
 *
 *   1 What matters most   the registry's profiles, by their goals; picking one shows what it would
 *                         stage here (its plan, and the compass's dashed outline); Next stages it,
 *                         and a different goal first unstages what the last one staged
 *   2 While data loads    the read mode as rich cards with its timeline, and how far behind a fast
 *                         view may be, within what the platform allows here
 *   3 Memory              the residency class, and its switch, shown: the guide never turns a
 *                         switch, which saves at once, and nothing here saves before the review
 *   4 Drafts & imports    who approves and merges, how long closed drafts keep their changes, and
 *                         the replace guard with its example
 *   5 Review              every change staged at this level, those staged before too: what it
 *                         affects, the warnings to acknowledge, a reason, Save (one PATCH)
 *
 * It stages through the page's own editor (`useSettingsEditor`): the page's save bar and the tab's
 * count show what it stages, and Save is the page's PATCH, confirmed here (a success screen with
 * Undo for as long as the editor keeps it) rather than by the page's toast. Its progress is the
 * page's (`useSetupGuide`): closing it with choices staged asks whether to keep them — "Continue
 * setup" then picks up where it was — or to discard them, each value put back as it was.
 *
 * What a setting says is the registry's: its question, label, summary and choices. Each question
 * step ends with the rest of its category, a click away; following it keeps what is staged.
 */
import { useEffect, useId, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import {
    ArrowRight, BadgeCheck, CircleCheck, ClipboardCheck, Feather, History, Lock, MoonStar, Route, Scale, Sparkles, Target, Undo2, Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatCount } from '@/lib/units'
import { onRadioGroupKeyDown } from '@/lib/radioGroupKeys'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { WizardShell, type WizardStepDef } from '@/components/wizard/WizardShell'
import { ConfettiBurst, SuccessMark } from '@/components/views/ViewWizard/CreationPhase'
import {
    ChangeReviewBody, EDITOR_LABEL, LockedValue, PlanList, SCOPE_LABEL, SettingControl, SettingVisual, TradeoffCompass, WhyBanner,
    applyProfile, formatValue, lockedFor, ownValue, sameValue, skipWords, useChangeReview,
    type Editor, type ProfilePlan, type ResolvedSetting, type ResolvedValues, type ReviewWarning, type Scope, type Setting,
    type SettingsFacts, type SettingValue, type SkipReason, type Values,
} from '@/components/settings'
import { useCalmMotion } from '@/components/settings/visuals/motion'
import type { Impact, PreviewItem, ServedSchema, SettingsProfile } from '@/services/settingsService'
import { CategoryIcon } from './CategorySection'
import { MasterSwitchCard, MasterSwitchStatus } from './MasterSwitch'
import { Outcome } from './SettingsRows'
import { SETUP_STEPS, moreInCategories, stepSettings, type SetupStep, type SetupStepId } from './setupSteps'
import type { FeatureSwitches } from './useFeatureSwitches'
import { useServerReview } from './useServerReview'
import type { SettingsEditor } from './useSettingsEditor'
import type { SetupGuide } from './useSetupGuide'

type Level = 'platform' | 'workspace'
type Icon = ComponentType<{ className?: string }>

export interface SetupWizardProps {
    guide: SetupGuide
    /** The page's editor: the guide stages through it, and saves with it. */
    editor: SettingsEditor
    schema: ServedSchema
    /** The values resolved at this level, by key. */
    values: ResolvedValues
    /** The viewer's role here. */
    viewer: Editor | null
    scope: Level
    /** Where a save applies: "the platform", "the Finance workspace". */
    where: string
    /** The platform's live facts, for the explainers. */
    facts: SettingsFacts
    /** The platform's switches; without them (a workspace), a switch is shown as a status. */
    switches?: FeatureSwitches
    /** Closes the guide, keeping what is staged, and shows a category's settings on the page. */
    onShowCategory: (id: string) => void
    /** Shows the page's settings (after a save). */
    onSeeSettings: () => void
    /** Shows History, where a save can be put back once its Undo has gone. */
    onOpenHistory?: () => void
}

/** Each step's tile in the chrome's header and stepper. */
const STEP_ICON: Record<SetupStepId, Icon> = {
    goal: Target,
    reads: ({ className }) => <CategoryIcon name="eye" className={className} />,
    memory: ({ className }) => <CategoryIcon name="memory-stick" className={className} />,
    drafts: ({ className }) => <CategoryIcon name="git-branch" className={className} />,
    review: ClipboardCheck,
}

const STEP_DEFS: WizardStepDef[] = SETUP_STEPS.map((s) => {
    const StepIcon = STEP_ICON[s.id]
    return { id: s.id, label: s.label, icon: <StepIcon className="w-6 h-6" /> }
})

/** A goal's tile, by its profile's id; a profile this map doesn't know gets `Sparkles`. */
const GOAL_ICON: Record<string, Icon> = {
    balanced: Scale,
    'fastest-reads': Zap,
    'always-exact': BadgeCheck,
    'least-memory': Feather,
    'big-import-tonight': MoonStar,
}

/** Why a goal can't be applied here: the reason someone could act on first. */
const LEFT_OUT_ORDER: SkipReason[] = ['system_admin_only', 'locked', 'not_allowed', 'no_permission', 'follows_root', 'not_here']

const plural = (n: number, one: string, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// ── Pieces ─────────────────────────────────────────────────────────────────

/** A step's opening: its tile, an eyebrow, its name and what it asks. */
function StepIntro({ icon: StepIcon, eyebrow, title, children }: { icon: Icon; eyebrow: string; title: string; children?: ReactNode }) {
    return (
        <div className="flex items-start gap-3.5">
            <span className="hidden h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-md shadow-indigo-600/20 sm:grid">
                <StepIcon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-indigo-700 dark:text-indigo-300">{eyebrow}</p>
                <h3 className="mt-0.5 text-xl font-bold tracking-tight text-ink">{title}</h3>
                {children && <div className="mt-1 max-w-3xl space-y-0.5 text-[13.5px] leading-relaxed text-ink-secondary">{children}</div>}
            </div>
        </div>
    )
}

function RadioDot({ on }: { on: boolean }) {
    return (
        <span aria-hidden className={cn(
            'grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border-2 transition-colors',
            on ? 'border-indigo-600 bg-indigo-600 dark:border-indigo-400 dark:bg-indigo-400' : 'border-ink-muted/40',
        )}>
            {on && <span className="h-1.5 w-1.5 rounded-full bg-white dark:bg-canvas-elevated" />}
        </span>
    )
}

// ── 1. What matters most ───────────────────────────────────────────────────

interface Goal {
    profile: SettingsProfile
    plan: ProfilePlan
    /** Why it can't be applied here; null when it can. */
    blocked: string | null
}

function GoalCard({ goal, on, focusable, onPick }: { goal: Goal; on: boolean; focusable: boolean; onPick: () => void }) {
    const id = useId()
    const { profile: p, plan, blocked } = goal
    const GoalIcon = GOAL_ICON[p.id] ?? Sparkles
    const already = !blocked && plan.stage.length === 0
    return (
        <button
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={p.goal}
            aria-describedby={`${id}-promise${blocked ? ` ${id}-blocked` : ''}`}
            tabIndex={focusable ? 0 : -1}
            disabled={Boolean(blocked)}
            onClick={onPick}
            className={cn(
                'group flex w-full items-start gap-3.5 rounded-2xl border p-4 text-left outline-none transition-[border-color,background-color,box-shadow] duration-150',
                'focus-visible:ring-2 focus-visible:ring-accent-lineage/40 disabled:cursor-not-allowed',
                on
                    ? 'border-indigo-500/60 bg-indigo-500/[0.04] shadow-[0_0_0_3px_rgba(99,102,241,0.10)] dark:border-indigo-400/60 dark:bg-indigo-400/[0.06]'
                    : blocked ? 'border-glass-border/60 bg-black/[0.02] dark:bg-white/[0.02]'
                        : 'border-glass-border/70 bg-canvas-elevated hover:border-indigo-500/35',
            )}
        >
            <span className={cn(
                'grid h-10 w-10 shrink-0 place-items-center rounded-xl transition-colors',
                on ? 'bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-md shadow-indigo-600/20'
                    : blocked ? 'bg-black/[0.05] text-ink-secondary dark:bg-white/[0.06]'
                        : 'bg-indigo-500/10 text-indigo-700 dark:bg-indigo-400/15 dark:text-indigo-300',
            )}>
                <GoalIcon className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
                <span className={cn('block text-[15px] font-semibold leading-snug tracking-tight', blocked ? 'text-ink-secondary' : 'text-ink')}>{p.goal}</span>
                <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex rounded-full bg-black/[0.05] px-2 py-px text-[11px] font-semibold text-ink-secondary dark:bg-white/[0.07]">{p.title}</span>
                    {already && <span className="text-[11.5px] font-medium text-ink-secondary">Already like this here</span>}
                </span>
                <span id={`${id}-promise`} className="mt-1.5 block text-[13px] leading-relaxed text-ink-secondary">{p.promise}</span>
                {blocked && (
                    <span id={`${id}-blocked`} className="mt-2 flex items-start gap-1.5 text-[12.5px] font-medium text-ink-secondary">
                        <Lock aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{blocked}.</span>
                    </span>
                )}
            </span>
            {!blocked && <RadioDot on={on} />}
        </button>
    )
}

function GoalStep({ goals, picked, applied, scope, where, values, settings, dimensions, onPick }: {
    goals: Goal[]
    picked: Goal | null
    applied: string | null
    scope: Level
    where: string
    values: ResolvedValues
    settings: Setting[]
    dimensions: ServedSchema['dimensions']
    onPick: (id: string | null) => void
}) {
    const previewId = useId()
    const current = useMemo(() => Object.fromEntries(Object.values(values).map((r) => [r.key, r.effective])) as Values, [values])
    const inactive = useMemo(() => Object.values(values).filter((r) => r.status === 'dormant' || r.status === 'not_used').map((r) => r.key), [values])
    const next = useMemo(() => (picked ? { ...current, ...Object.fromEntries(picked.plan.stage.map((s) => [s.key, s.value])) } as Values : current),
        [current, picked])
    const first = goals.find((g) => !g.blocked)
    const done = picked !== null && applied === picked.profile.id
    return (
        <div className="space-y-6">
            <StepIntro icon={Target} eyebrow={`For ${where}`} title="What matters most?">
                <p>Pick the goal closest to yours: it stages the values that serve it, and each question after this one lets you change them. Nothing is saved until you review the changes.</p>
            </StepIntro>
            <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)]">
                <div className="space-y-3">
                    <div role="radiogroup" aria-label="What matters most" onKeyDown={onRadioGroupKeyDown} className="space-y-2.5">
                        {goals.map((g) => (
                            <GoalCard key={g.profile.id} goal={g} on={picked?.profile.id === g.profile.id}
                                focusable={picked ? picked.profile.id === g.profile.id : g === first} onPick={() => onPick(g.profile.id)} />
                        ))}
                    </div>
                    {picked ? (
                        <button type="button" onClick={() => onPick(null)}
                            className="rounded text-[12.5px] font-medium text-ink-secondary underline-offset-2 outline-none hover:text-ink hover:underline focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                            Clear the goal: answer each question yourself
                        </button>
                    ) : (
                        <p className="text-[12.5px] text-ink-secondary">Or go on without one, and answer each question yourself.</p>
                    )}
                </div>

                <section aria-labelledby={previewId} className="rounded-2xl border border-glass-border/60 bg-canvas-elevated p-4 sm:p-5">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-secondary">
                        {done ? 'Staged' : 'What it would change'} · {SCOPE_LABEL[scope]}
                    </p>
                    {picked ? (
                        <>
                            <h4 id={previewId} className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink">
                                {picked.profile.title}: {plural(picked.plan.stage.length, 'change')} for {where}
                            </h4>
                            <div className="mt-4 space-y-5">
                                {picked.plan.stage.length > 0 && (
                                    <TradeoffCompass dimensions={dimensions} settings={settings} current={current} next={next} inactive={inactive}
                                        title={`What ${picked.profile.title} trades here`} />
                                )}
                                <PlanList plan={picked.plan} scope={scope} resolved={values} done={done} />
                            </div>
                        </>
                    ) : (
                        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-indigo-500/10 text-indigo-700 dark:bg-indigo-400/15 dark:text-indigo-300">
                                <Target aria-hidden className="h-5 w-5" />
                            </span>
                            <h4 id={previewId} className="text-[13.5px] font-semibold text-ink">Pick a goal to see what it would change</h4>
                            <p className="max-w-xs text-[12.5px] text-ink-secondary">Each value it would stage here, from what is in force now, and what it trades.</p>
                        </div>
                    )}
                </section>
            </div>
        </div>
    )
}

// ── 2–4. The questions ─────────────────────────────────────────────────────

/** Why a value can't be changed here, in words: who can. */
function readOnlyWhy(s: Setting, r: ResolvedSetting, scope: Scope): string {
    if (lockedFor(r, scope)) return 'The platform locked this value.'
    if (!s.scopes[scope]) return 'Set at another level.'
    return r.editor ? `Only ${EDITOR_LABEL[r.editor]} can change it here.` : 'You can’t change it here.'
}

const plainStatus = (q: PreviewItem) => q.status === 'in_effect' || q.status === 'exception'

/** One setting, asked: its question, what it is, the control (or its value, read-only, and who can change it), and what the server makes of a staged value. */
function Question({ s, r, scope, staged, error, quick, checking, dimensions, onStage, visual }: {
    s: Setting
    r: ResolvedSetting
    scope: Level
    /** A value staged here; undefined when none is. */
    staged: SettingValue | null | undefined
    error?: string
    quick?: PreviewItem
    checking: boolean
    dimensions: ServedSchema['dimensions']
    onStage: (key: string, value: SettingValue | null) => void
    visual?: ReactNode
}) {
    const id = useId()
    const isStaged = staged !== undefined
    const own = isStaged ? staged : ownValue(r, scope)
    const editable = r.editable && !lockedFor(r, scope) && Boolean(s.scopes[scope])
    // The server's answer, when it is for the value staged now; never while that value needs a fix.
    const answer = isStaged && !error && quick && sameValue(ownValue(quick, scope), staged) ? quick : undefined
    const rec = s.guidance.recommended.forThisPlatform?.value ?? s.guidance.recommended.value
    const recWhy = s.guidance.recommended.forThisPlatform?.why ?? s.guidance.recommended.why
    // Choices mark the recommended one themselves.
    const showRec = editable && s.kind !== 'choice'
    return (
        <article aria-labelledby={`${id}-q`} className={cn(
            'relative rounded-2xl border bg-canvas-elevated p-5 sm:p-6 transition-[border-color] duration-200',
            isStaged ? 'border-accent-lineage/35' : 'border-glass-border/60',
        )}>
            {isStaged && <span aria-hidden className="absolute inset-y-5 left-0 w-[3px] rounded-r-full bg-accent-lineage" />}
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-secondary">{s.label}</p>
            <h4 id={`${id}-q`} className="mt-0.5 text-[15px] font-semibold tracking-tight text-ink">{s.question || s.label}</h4>
            <p id={`${id}-summary`} className="mt-1 max-w-prose text-[13.5px] leading-relaxed text-ink-secondary">{s.guidance.summary}</p>
            {r.why.length > 0 && <WhyBanner className="mt-3" why={r.why} compact />}
            <div className="mt-4">
                {editable ? (
                    <SettingControl setting={s} value={own} onChange={(v) => onStage(s.key, v)} resolved={r} scope={scope} lens="business"
                        dimensions={dimensions} invalid={Boolean(error)} aria-labelledby={`${id}-q`}
                        aria-describedby={error ? `${id}-summary ${id}-error` : `${id}-summary`} />
                ) : (
                    <LockedValue setting={s} value={r.effective} why={readOnlyWhy(s, r, scope)} />
                )}
            </div>
            <p id={`${id}-error`} aria-live="polite" className={cn('text-[12.5px] font-medium text-rose-600 dark:text-rose-400', error ? 'mt-2' : 'sr-only')}>
                {error ?? ''}
            </p>
            {answer ? (
                <div className="mt-3 space-y-2">
                    <p className="text-[12.5px] font-semibold text-indigo-700 dark:text-indigo-300">Once saved: {formatValue(s, answer.effective)}</p>
                    {(!plainStatus(answer) || answer.example) && <Outcome s={s} quick={answer} staged fixLabel={() => ''} />}
                </div>
            ) : isStaged && !error && checking ? (
                <p className="mt-3 text-[12.5px] text-ink-secondary">Checking…</p>
            ) : null}
            {showRec && (
                <div className="mt-4 flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xl bg-black/[0.025] px-3.5 py-2.5 dark:bg-white/[0.035]">
                    <Sparkles aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-600 dark:text-violet-300" />
                    <p className="min-w-0 flex-1 basis-60 text-[12.5px] leading-relaxed text-ink-secondary">
                        <span className="font-semibold text-ink">Recommended: {formatValue(s, rec)}.</span> {recWhy}
                    </p>
                    {!sameValue(own ?? r.effective, rec) && (
                        <Button size="sm" variant="ghost" onClick={() => onStage(s.key, rec)} className="text-indigo-700 dark:text-indigo-300">
                            Use {formatValue(s, rec)}
                        </Button>
                    )}
                </div>
            )}
            {visual && <div className="mt-4">{visual}</div>}
        </article>
    )
}

function QuestionStep({ step, schema, byKey, values, scope, editor, facts, switches, onStage, onShowCategory }: {
    step: SetupStep
    schema: ServedSchema
    byKey: Record<string, Setting>
    values: ResolvedValues
    scope: Level
    editor: SettingsEditor
    facts: SettingsFacts
    switches?: FeatureSwitches
    onStage: (key: string, value: SettingValue | null) => void
    onShowCategory: (id: string) => void
}) {
    const { staged } = editor
    const asked = stepSettings(step, byKey, scope).filter((s) => values[s.key])
    const categories = [...new Set(asked.map((s) => s.category))].flatMap((id) => schema.categories.find((c) => c.id === id) ?? [])
    const present = schema.settings.filter((s) => values[s.key])
    const more = moreInCategories(step, present, schema.categories, scope)
    const StepIcon = STEP_ICON[step.id]
    const explainer = (s: Setting): ReactNode => {
        // The read mode's timeline; the replace guard's example, which its delete share draws.
        const of = s.key === 'reads.mode' ? s : s.key === 'imports.replaceGuard' ? byKey['imports.guardDeleteShare'] : undefined
        if (!of) return undefined
        return <SettingVisual setting={of} settings={byKey} current={staged.current} next={staged.next} facts={facts} />
    }
    const residencySwitch = schema.categories.find((c) => c.id === 'residency')?.masterSwitch
    return (
        <div className="space-y-5">
            <StepIntro icon={StepIcon} eyebrow={categories.map((c) => c.label).join(' · ')} title={step.label}>
                {categories.map((c) => <p key={c.id}>{c.summary}</p>)}
            </StepIntro>
            {asked.map((s) => (
                <Question key={s.key} s={s} r={values[s.key]} scope={scope}
                    staged={staged.isStaged(s.key) ? staged.valueAt(s.key) : undefined}
                    error={editor.errors[s.key]} quick={editor.quick[s.key]} checking={editor.quickPending && staged.isStaged(s.key)}
                    dimensions={schema.dimensions} onStage={onStage} visual={explainer(s)} />
            ))}
            {step.id === 'memory' && residencySwitch && (
                <div className="space-y-2">
                    {switches ? <MasterSwitchCard featureKey={residencySwitch} switches={switches} readOnly /> : <MasterSwitchStatus featureKey={residencySwitch} />}
                    <p className="text-[12.5px] text-ink-secondary">
                        The guide never turns a switch: a switch saves at once, and nothing here is saved before the review.
                    </p>
                </div>
            )}
            {more.length > 0 && (
                <nav aria-label="The rest of these settings" className="flex flex-wrap gap-x-6 gap-y-2 border-t border-glass-border/60 pt-4">
                    {more.map(({ category, more: n }) => (
                        <button key={category.id} type="button" onClick={() => onShowCategory(category.id)}
                            className="group inline-flex items-center gap-1.5 rounded text-[13px] font-semibold text-indigo-700 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent-lineage/40 dark:text-indigo-300">
                            <CategoryIcon name={category.icon} className="h-4 w-4" />
                            {n} more in {category.label}
                            <ArrowRight aria-hidden className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
                        </button>
                    ))}
                </nav>
            )}
        </div>
    )
}

// ── Success ────────────────────────────────────────────────────────────────

interface Saved {
    count: number
    /** The full preview's graphs, as it was just before the save. */
    graphs: Impact['graphs']
}

function SuccessTile({ label, figure = false, children }: { label: string; figure?: boolean; children: ReactNode }) {
    return (
        <div className="min-w-[9rem] flex-1 basis-[9rem] rounded-xl border border-glass-border/60 bg-canvas-elevated px-4 py-3 text-left">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-secondary">{label}</p>
            <div className={cn('mt-1 font-bold leading-snug text-ink', figure ? 'text-xl tabular-nums' : 'text-[15px]')}>{children}</div>
        </div>
    )
}

function Success({ saved, where, undo, onUndo, onOpenHistory, failure }: {
    saved: Saved
    where: string
    /** `ready`: Undo is offered; `gone`: its time is up; then while and once it runs. */
    undo: 'ready' | 'running' | 'done' | 'failed' | 'gone'
    onUndo: () => void
    onOpenHistory?: () => void
    /** Why the Undo failed. */
    failure: string
}) {
    const { reduced } = useCalmMotion()
    const [live, setLive] = useState('')
    const words = `Saved ${plural(saved.count, 'change')} to ${where}.`
    // Its own live region: the page's is behind the dialog. Filled once it is on screen, so it is heard.
    useEffect(() => {
        const t = setTimeout(() => setLive(undo === 'done' ? 'Undone: the earlier values are back.' : undo === 'failed' ? failure : words), 120)
        return () => clearTimeout(t)
    }, [undo, failure, words])
    const graphs = saved.graphs
    return (
        <div className="relative flex min-h-[360px] flex-col items-center justify-center px-2 py-6 text-center">
            {!reduced && <ConfettiBurst />}
            <SuccessMark />
            <h3 className="mt-7 text-2xl font-bold tracking-tight text-ink">{undo === 'done' ? 'Put back as it was' : words.slice(0, -1)}</h3>
            <p className="mt-2 max-w-xl text-sm text-ink-secondary">
                {undo === 'done'
                    ? 'The values in force before this save are back, and the undo is in the history.'
                    : 'Recorded in the history with your reason. Every server reads the new values within a few seconds.'}
            </p>
            <div className="mt-7 flex w-full max-w-2xl flex-wrap justify-center gap-3">
                <SuccessTile label="Changes saved" figure>{formatCount(saved.count)}</SuccessTile>
                <SuccessTile label="Graphs whose behaviour changes" figure>
                    {graphs ? <>{formatCount(graphs.changed)} <span className="text-[13px] font-medium text-ink-secondary">of {formatCount(graphs.inScope)}</span></>
                        : <span className="text-[13px] font-medium text-ink-secondary">Not worked out</span>}
                </SuccessTile>
                <SuccessTile label="Where">{capitalise(where)}</SuccessTile>
            </div>
            <div className="mt-6 flex min-h-9 flex-wrap items-center justify-center gap-x-3 gap-y-2 text-[13px] text-ink-secondary">
                {undo === 'ready' || undo === 'running' ? (
                    <>
                        <Button leftIcon={Undo2} loading={undo === 'running'} onClick={onUndo} className="border-glass-border/80">Undo</Button>
                        <span>For 10 seconds after saving.</span>
                    </>
                ) : undo === 'done' ? (
                    <span className="inline-flex items-center gap-1.5 font-medium text-ink"><CircleCheck aria-hidden className="h-4 w-4 text-emerald-600 dark:text-emerald-400" /> Undone</span>
                ) : (
                    <>
                        {undo === 'failed' && <span className="font-medium text-rose-700 dark:text-rose-300">{failure}</span>}
                        {onOpenHistory ? (
                            <button type="button" onClick={onOpenHistory}
                                className="inline-flex items-center gap-1.5 rounded font-semibold text-indigo-700 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent-lineage/40 dark:text-indigo-300">
                                <History aria-hidden className="h-4 w-4" /> Put it back from History
                            </button>
                        ) : <span>Put it back from History.</span>}
                    </>
                )}
            </div>
            <p className="sr-only" aria-live="polite">{live}</p>
        </div>
    )
}

// ── The wizard ─────────────────────────────────────────────────────────────

function SetupPanel({ guide, editor, schema, values, viewer, scope, where, facts, switches, confirming, onAskClose, onShowCategory, onSeeSettings, onOpenHistory }: SetupWizardProps & {
    confirming: boolean
    /** Asks whether to keep or discard what is staged. */
    onAskClose: () => void
}) {
    const byKey = useMemo(() => Object.fromEntries(schema.settings.map((s) => [s.key, s])), [schema.settings])
    const present = useMemo(() => schema.settings.filter((s) => values[s.key]), [schema.settings, values])
    const order = useMemo(() => new Map(schema.settings.map((s, i) => [s.key, i])), [schema.settings])
    const [phase, setPhase] = useState<'steps' | 'success'>('steps')
    const [saved, setSaved] = useState<Saved | null>(null)
    const [undo, setUndo] = useState<'idle' | 'running' | 'done' | 'failed'>('idle')
    const index = Math.max(0, SETUP_STEPS.findIndex((s) => s.id === guide.step))
    const step = SETUP_STEPS[index]
    const { staged, review: editorReview } = editor
    const saving = editorReview.saving

    // ── The goals: the profiles offered at this level, by their goals ──
    const goals = useMemo((): Goal[] => {
        const byOrder = (a: { key: string }, b: { key: string }) => (order.get(a.key) ?? 999) - (order.get(b.key) ?? 999)
        const atScope = (schema.profiles ?? []).filter((p) => p.scopes.includes(scope))
        // The business goals lead, as the profiles do in the Business view.
        const offered = [...atScope.filter((p) => p.audience === 'business'), ...atScope.filter((p) => p.audience !== 'business')]
        return offered.map((profile) => {
            const raw = applyProfile(profile, scope, viewer, values)
            const plan = { stage: [...raw.stage].sort(byOrder), skipped: [...raw.skipped].sort(byOrder) }
            const settable = plan.stage.length > 0 || plan.skipped.some((x) => x.reason === 'already')
            const reason = settable ? null : LEFT_OUT_ORDER.find((why) => plan.skipped.some((x) => x.reason === why)) ?? null
            return { profile, plan, blocked: reason ? skipWords(reason, scope) : null }
        })
    }, [schema.profiles, scope, viewer, values, order])
    const picked = goals.find((g) => g.profile.id === guide.goal && !g.blocked) ?? null

    // ── The review, drawn on its own step: its full preview runs while it is shown ──
    const reviewing = phase === 'steps' && step.id === 'review'
    const { setInline } = editorReview
    useEffect(() => {
        setInline(reviewing)
        return () => setInline(false)
    }, [reviewing, setInline])
    const server = useServerReview({
        impact: editorReview.full?.impact, impactPending: editorReview.fullPending, impactError: editorReview.fullError,
        onRetryImpact: editorReview.retryFull, settings: byKey, error: editorReview.error,
    })
    // Below the platform, a system admin may choose past its limits: the server's answer says the
    // value stays as an exception (among its whys, whatever else adjusts it), and the review says so.
    const fullValues = editorReview.full?.values
    const pastLimits = useMemo((): ReviewWarning[] => (scope === 'platform' ? [] : staged.changes.flatMap((c) => {
        const answer = fullValues?.[c.key]
        const s = byKey[c.key]
        const past = answer?.why.find((w) => w.code === 'outside_limits_exception')
        if (!s || !answer || !past) return []
        return [{ id: `outside_limits:${c.key}`, text: `${s.label}: ${formatValue(s, answer.declared ?? c.after)}. ${past.text}` }]
    })), [scope, staged.changes, fullValues, byKey])
    const warnings = useMemo(() => [...server.warnings, ...pastLimits], [server.warnings, pastLimits])
    const items = editorReview.items
    const review = useChangeReview({
        count: items.length, warnings, impactLoading: server.impactLoading, impactFailed: server.impactFailed, saving, round: editorReview.round,
    })
    const mine = new Set(guide.changed)
    const earlier = staged.changes.filter((c) => !mine.has(c.key)).length + staged.limitChanges.length
    const toFix = Object.keys({ ...editor.errors, ...editor.limitErrors }).map((k) => byKey[k]?.label ?? k)

    // ── Moving, closing, saving ──
    const go = (id: SetupStepId) => guide.setStep(id)
    const next = () => {
        if (step.id === 'goal') guide.applyGoal(picked?.profile.id ?? null, picked?.plan.stage ?? [])
        go(SETUP_STEPS[Math.min(index + 1, SETUP_STEPS.length - 1)].id)
    }
    const close = () => {
        if (phase === 'success') guide.finish()
        else if (saving) return
        // Nothing of the guide's is staged: nothing to keep or discard.
        else if (guide.changed.length === 0) guide.finish()
        else onAskClose()
    }
    const save = async () => {
        // What the full preview says now: once saved, there is nothing staged to preview.
        const graphs = editorReview.full?.impact?.graphs ?? null
        const count = items.length
        if (await editorReview.save(review.reason.trim(), { confirm: false })) {
            setSaved({ count, graphs })
            setPhase('success')
        }
    }
    const undoIt = async () => {
        if (!editor.saved) return
        setUndo('running')
        setUndo(await editor.saved.undo() ? 'done' : 'failed')
    }
    const leaveTo = (then: () => void) => {
        guide.finish()
        then()
    }

    const n = items.length
    const success = phase === 'success' && saved
    let body: ReactNode
    if (success) {
        body = (
            <Success saved={saved} where={where} failure={editor.announcement}
                undo={undo === 'idle' ? (editor.saved ? 'ready' : 'gone') : undo}
                onUndo={() => { void undoIt() }} onOpenHistory={onOpenHistory ? () => leaveTo(onOpenHistory) : undefined} />
        )
    } else if (step.id === 'goal') {
        body = (
            <GoalStep goals={goals} picked={picked} applied={guide.applied} scope={scope} where={where} values={values} settings={present}
                dimensions={schema.dimensions} onPick={guide.pickGoal} />
        )
    } else if (step.id === 'review') {
        body = (
            <div className="space-y-6">
                <StepIntro icon={ClipboardCheck} eyebrow="Review" title={`Review ${plural(n, 'change')} to ${where}`}>
                    <p>Nothing is saved until you press Save. The change is recorded with your reason, and you can undo it.</p>
                    {earlier > 0 && n > 0 && <p className="font-medium text-ink">Including {formatCount(earlier)} you staged earlier.</p>}
                </StepIntro>
                {n === 0 ? (
                    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-glass-border px-6 py-12 text-center">
                        <Route aria-hidden className="h-6 w-6 text-ink-secondary" />
                        <p className="text-sm font-semibold text-ink">Nothing to save yet</p>
                        <p className="max-w-sm text-[13px] text-ink-secondary">Go back to pick a goal or answer a question: what you change is listed here to review.</p>
                    </div>
                ) : (
                    <ChangeReviewBody review={review} items={items} dimensions={schema.dimensions} impact={server.impact} impactLoading={server.impactLoading}
                        error={server.error} onReapply={editorReview.reapply} headingLevel={4} />
                )}
                {n > 0 && (
                    <p aria-live="polite" className="text-[12.5px] font-medium text-ink-secondary">
                        {toFix.length ? `Fix ${toFix.join(', ')} before saving.` : review.blocking}
                    </p>
                )}
            </div>
        )
    } else {
        body = (
            <QuestionStep step={step} schema={schema} byKey={byKey} values={values} scope={scope} editor={editor} facts={facts} switches={switches}
                onStage={guide.stage} onShowCategory={(id) => { guide.keep(); onShowCategory(id) }} />
        )
    }

    return (
        <WizardShell
            title="Guided setup"
            submitLabel={`Save ${n === 1 ? 'change' : `${formatCount(n)} changes`}`}
            currentStep={step.id}
            activeSteps={STEP_DEFS}
            currentStepIndex={index}
            onStepClick={(id) => go(id as SetupStepId)}
            onBack={() => go(SETUP_STEPS[Math.max(index - 1, 0)].id)}
            onNext={next}
            onClose={close}
            onEscape={() => { if (!confirming) close() }}
            canProceed={step.id !== 'review' || (review.ready && toFix.length === 0)}
            isLastStep={step.id === 'review'}
            isSubmitting={saving}
            onSubmit={() => { void save() }}
            terminalPhase={success ? 'success' : undefined}
            terminalLabel="Saved"
            terminalSubtitle={`Saved to ${where}`}
            hideClose={saving}
            wide={step.id === 'goal' || step.id === 'reads'}
            helpSlug="governance-ops"
            footer={success ? (
                <div className="flex w-full flex-wrap items-center justify-end gap-3">
                    <Button variant="ghost" onClick={() => leaveTo(onSeeSettings)} className="text-ink-secondary">See the settings</Button>
                    <Button variant="primary" autoFocus onClick={() => guide.finish()}
                        className="bg-indigo-600 bg-gradient-to-r from-indigo-600 to-violet-600 px-5 shadow-indigo-600/25">
                        Done
                    </Button>
                </div>
            ) : undefined}
        >
            {body}
        </WizardShell>
    )
}

/** "Keep your N choices staged?": keep them (and continue later), discard them, or keep going. */
function KeepOrDiscard({ open, count, onKeep, onDiscard, onKeepGoing }: {
    open: boolean
    count: number
    onKeep: () => void
    onDiscard: () => void
    onKeepGoing: () => void
}) {
    const keepRef = useRef<HTMLButtonElement>(null)
    return (
        <Dialog
            open={open}
            onOpenChange={(o) => { if (!o) onKeepGoing() }}
            size="sm"
            initialFocus={keepRef}
            title={`Keep your ${plural(count, 'choice')} staged?`}
            description="They stay on the page, not saved, until you review and save them or discard them. Continue setup picks up where you left off."
            footer={(
                <>
                    <Button variant="ghost" onClick={onKeepGoing} className="mr-auto text-ink-secondary">Keep going</Button>
                    <Button variant="ghost" onClick={onDiscard} className="text-rose-700 hover:text-rose-800 dark:text-rose-300 dark:hover:text-rose-200">Discard them</Button>
                    <Button ref={keepRef} variant="primary" onClick={onKeep} className="bg-indigo-600 hover:bg-indigo-700 hover:brightness-100">Keep them staged</Button>
                </>
            )}
        />
    )
}

export function SetupWizard(props: SetupWizardProps) {
    const { guide } = props
    // Kept mounted with the page, never with the wizard: a dialog unmounted while open strands the page.
    const [confirming, setConfirming] = useState(false)
    return (
        <>
            {guide.open && <SetupPanel {...props} confirming={confirming} onAskClose={() => setConfirming(true)} />}
            <KeepOrDiscard
                open={confirming}
                count={guide.changed.length}
                onKeepGoing={() => setConfirming(false)}
                onKeep={() => { setConfirming(false); guide.keep() }}
                onDiscard={() => { setConfirming(false); guide.discard() }}
            />
        </>
    )
}
