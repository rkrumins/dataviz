/**
 * Settings — every setting, by category: the platform's for its system admins, or a workspace's
 * (`scope="workspace"`) on that workspace's page, within the platform's limits.
 *
 *   rail          the seven categories, each with how many values are chosen at this level (on the
 *                 platform: differ from the default) and how many are staged; a select on a phone
 *   hero          where the settings stand (`SettingsHero`): a headline counted from the values, the
 *                 reads posture, a pill while changes are staged, what this platform's facts
 *                 suggest; the actions ("Set up with a guide" for an editor, its coach mark once in
 *                 the Business view; start from a profile; "Something's wrong?"); the trade-off
 *                 compass at a glance; the search (`/`) and "Changed only". The compass and the finder
 *                 open full width under it. The Business / Technical view is the app's own,
 *                 switched in the page's header (`LensSwitch`)
 *   tasks         in the Business view, "What do you want to do?": business settings' own
 *                 questions, each a link to its row
 *   categories    each with its posture, its switch, its settings and what the deployment sets;
 *                 for a workspace, what only the platform sets is listed read-only, with its value.
 *                 In the Business view the business categories lead, and the rest follow under
 *                 "For your platform team", here and in the rail: every one is shown
 *   save bar      Review → the full preview, warnings, a reason → Save → Undo
 *
 * A link to `#reads-mode` (or a search result, a task card, a suggestion, or a symptom's "Show")
 * scrolls to that setting, focuses it and marks it; a link to `#category-builds` scrolls to that
 * category. Leaving with changes staged asks first: the page's `LeaveGuard`.
 */
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useReducedMotion } from 'framer-motion'
import { BookOpen, Route, Stethoscope, UsersRound } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/Dialog'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import {
    FEATURE_NAMES, MemoryMarks, SettingsSearch, StickySaveBar, SymptomFinder,
    describeFix, ownValue, sameValue, settingAnchor, useLens,
    type Category, type ResolvedSetting, type Setting, type SettingsFacts, type SettingValue, type WhyFix,
} from '@/components/settings'
import type { ServedSchema, SettingsValues, SignalCount } from '@/services/settingsService'
import { CategoryIcon, CategorySection, PlatformWideSettings } from './CategorySection'
import { MasterSwitchCard, MasterSwitchStatus } from './MasterSwitch'
import type { FeatureSwitches } from './useFeatureSwitches'
import { categoryAnchor } from './meta'
import { ProfileEntry } from './ProfileEntry'
import { RowItem } from './SettingsRows'
import { CompassSummary, SettingsHero, TaskCards, type Headline } from './SettingsHero'
import { SetupCoachMark } from './SetupCoachMark'
import { VisualContext } from './visualContext'
import { SettingsReview } from './SettingsReview'
import type { SettingsEditor } from './useSettingsEditor'

type Level = 'platform' | 'workspace'

/** On the platform, a value chosen there that differs from the default; for a workspace, any value it chose. */
const changedHere = (r: ResolvedSetting, scope: Level) => {
    const own = ownValue(r, scope)
    return own !== null && (scope !== 'platform' || !sameValue(own, r.trail[0]?.value))
}

/** What the page says about the values chosen at its level. */
const WORDS: Record<Level, {
    changed: (n: number) => string
    /** None chosen: `settable`, how many could be. */
    none: (settable: number) => string
    /** The hero's headline: `changed` of `settable` settings. */
    headline: (changed: number, settable: number) => Headline
    only: string
    onlyLabel: string
    readOnly: string
}> = {
    platform: {
        changed: (n) => `${n} changed`,
        none: () => 'All defaults',
        headline: (changed, settable) => (changed
            ? { count: changed, after: ` of ${settable} settings changed from the default` }
            : { before: 'All ', count: settable, after: ' settings at their defaults' }),
        only: 'Changed only',
        onlyLabel: 'Show changed settings only',
        readOnly: 'You can read these settings and why each is what it is. Only a system admin can change them.',
    },
    workspace: {
        changed: (n) => `${n} ${n === 1 ? 'value' : 'values'} set here`,
        none: (settable) => (settable ? 'All inherited' : 'Platform-wide'),
        headline: (changed, settable) => (changed
            ? { count: changed, after: ` ${changed === 1 ? 'value' : 'values'} set for this workspace` }
            : { before: 'All ', count: settable, after: ' settings follow the platform' }),
        only: 'Set here only',
        onlyLabel: 'Show settings set for this workspace only',
        readOnly: 'You can read this workspace’s settings and why each is what it is. A workspace admin can change them.',
    },
}

/** In the Business view, what heads the categories a business owner doesn't decide. */
const PLATFORM_TEAM = 'For your platform team: how writes, builds and database reads run'

/**
 * "What do you want to do?", in the Business view: up to six business settings, each by its own
 * question, chosen from the registry's order: the first of each business category, then the next
 * ones. Nothing here is written for the cards.
 */
function pickTasks(settings: Setting[], categories: Category[], max = 6): Setting[] {
    const business = settings.filter((s) => s.audience === 'business' && s.question)
    const firsts = categories.filter((c) => c.audience.includes('business'))
        .flatMap((c) => business.find((s) => s.category === c.id) ?? [])
    return [...firsts, ...business.filter((s) => !firsts.includes(s))].slice(0, max)
}

const RailItem = memo(function RailItem({ id, label, icon, note, staged, current, onJump }: {
    id: string
    label: string
    icon: string
    /** How many values are chosen at this level, in words: "2 changed", "All defaults". */
    note: string
    staged: number
    current: boolean
    onJump: (id: string) => void
}) {
    return (
        <li>
            <button type="button" onClick={() => onJump(id)} aria-current={current ? 'true' : undefined}
                className={cn(
                    'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left outline-none transition-colors',
                    'focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                    current ? 'bg-black/[0.05] text-ink dark:bg-white/[0.07]' : 'text-ink-secondary hover:bg-black/[0.03] hover:text-ink dark:hover:bg-white/[0.04]',
                )}>
                <CategoryIcon name={icon} className="w-4 h-4 shrink-0 text-ink-secondary" />
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{label}</span>
                    <span className="block text-[11px] text-ink-secondary">
                        {note}
                        {staged > 0 && <span className="font-semibold text-indigo-700 dark:text-indigo-300"> · {staged} not saved</span>}
                    </span>
                </span>
                {staged > 0 && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-lineage" />}
            </button>
        </li>
    )
})

export function SettingsView({
    schema, data, editor, switches, facts, signals, signalsUnavailable, onFinderOpenChange, readOnly, scope = 'platform', where = 'the platform', workspaceName, setup,
}: {
    schema: ServedSchema
    data: SettingsValues
    editor: SettingsEditor
    /** The feature switches, which the platform's page turns on and off; without them a category's switch is shown, not flipped. */
    switches?: FeatureSwitches
    facts: SettingsFacts
    /** Signal counts for the finder, where the server counts them. */
    signals?: SignalCount[]
    /** The server couldn't count the signals: the finder says so. */
    signalsUnavailable?: boolean
    /** "Something's wrong?" opened or closed: the page asks for the signals only while it shows them. */
    onFinderOpenChange?: (open: boolean) => void
    readOnly: boolean
    /** The level edited: the platform, or a workspace, within the platform's limits. */
    scope?: Level
    /** Where a save applies, for the review: "the platform", "the Finance workspace". */
    where?: string
    /** The workspace's name, for the hero (`scope="workspace"`). */
    workspaceName?: string
    /** The guided setup, for an editor: the hero's first action ("Set up with a guide", or "Continue setup"). */
    setup?: { label: string; onStart: () => void }
}) {
    const values = data.values
    const words = WORDS[scope]
    const { staged } = editor
    const [lens] = useLens()
    const [onlyChangedAsked, setOnlyChanged] = useState(false)
    const [compassOpen, setCompassOpen] = useState(false)
    const [finderOpen, setFinderOpen] = useState(false)
    // Focus follows the finder: into it when it opens, back to its button when it closes.
    const finderButton = useRef<HTMLButtonElement>(null)
    const finderPanel = useRef<HTMLDivElement>(null)
    const finderToggled = useRef(false)
    const toggleFinder = (open: boolean) => {
        finderToggled.current = true
        setFinderOpen(open)
        onFinderOpenChange?.(open)
    }
    useEffect(() => {
        if (!finderToggled.current) return
        if (finderOpen) finderPanel.current?.querySelector<HTMLElement>('input')?.focus()
        else finderButton.current?.focus()
    }, [finderOpen])
    const [discarding, setDiscarding] = useState(false)
    // "Set up with a guide", for its coach mark to point at.
    const [setupButton, setSetupButton] = useState<HTMLButtonElement | null>(null)
    const offerSetup = Boolean(setup) && !readOnly
    const [currentCategory, setCurrentCategory] = useState<string | null>(null)
    const location = useLocation()
    const navigate = useNavigate()
    const reduced = useReducedMotion()
    const byKey = useMemo(() => Object.fromEntries(schema.settings.map((s) => [s.key, s])), [schema.settings])
    const keyOfAnchor = useMemo(() => Object.fromEntries(schema.settings.map((s) => [settingAnchor(s.key), s.key])), [schema.settings])
    const present = useMemo(() => schema.settings.filter((s) => values[s.key]), [schema.settings, values])
    // What the platform lets lower levels choose is set on the platform alone.
    const editLimits = scope === 'platform' && data.editor === 'system_admin' && !readOnly

    const categories = useMemo(() => {
        const sorted = [...schema.categories].sort((a, b) => a.order - b.order)
        // The business lens leads with what a business owner decides; both show every category.
        return lens === 'operator' ? sorted
            : [...sorted.filter((c) => c.audience.includes('business')), ...sorted.filter((c) => !c.audience.includes('business'))]
    }, [schema.categories, lens])
    // In the Business view, where the platform team's categories start (under their divider); -1: none.
    const teamFrom = lens === 'business' ? categories.findIndex((c) => !c.audience.includes('business')) : -1

    const stagedKeys = useMemo(() => {
        const out = new Map<string, number>()
        for (const k of [...staged.changes.map((c) => c.key), ...staged.limitChanges.map((l) => l.key)]) out.set(k, (out.get(k) ?? 0) + 1)
        return out
    }, [staged.changes, staged.limitChanges])
    // Counted over the settings this level can have: below the platform, some are the platform's alone.
    const counts = useMemo(() => Object.fromEntries(categories.map((c) => {
        const own = present.filter((s) => s.category === c.id && s.scopes[scope])
        return [c.id, {
            total: own.length,
            changed: own.filter((s) => changedHere(values[s.key], scope)).length,
            staged: own.reduce((n, s) => n + (stagedKeys.get(s.key) ?? 0), 0),
        }]
    })), [categories, present, values, stagedKeys, scope])
    // What "Changed only" shows: each setting chosen here or staged, once.
    const onlyCount = useMemo(() => present.filter((s) => s.scopes[scope] && (changedHere(values[s.key], scope) || stagedKeys.has(s.key))).length,
        [present, values, stagedKeys, scope])
    const note = (id: string) => (counts[id]?.changed ? words.changed(counts[id].changed) : words.none(counts[id]?.total ?? 0))
    // The settings this level has a row for, in the order the page shows them: by category, then section.
    const rows = useMemo(() => categories.flatMap((c) => {
        const at = (s: Setting) => {
            const i = c.sections.findIndex((sec) => sec.id === s.section)
            return i < 0 ? c.sections.length : i
        }
        return present.filter((s) => s.category === c.id && s.scopes[scope]).sort((a, b) => at(a) - at(b))
    }), [categories, present, scope])
    const changedCount = useMemo(() => rows.filter((s) => changedHere(values[s.key], scope)).length, [rows, values, scope])
    // What this platform's facts suggest, where it isn't in force: for a system admin, who can act on it.
    const suggestions = useMemo(() => (data.editor !== 'system_admin' ? [] : rows.filter((s) => {
        const ftp = s.guidance.recommended.forThisPlatform
        return ftp && !sameValue(ftp.value, values[s.key].effective)
    })), [rows, values, data.editor])
    const tasks = useMemo(() => (lens === 'business'
        ? pickTasks(present.filter((s) => s.scopes[scope]), [...schema.categories].sort((a, b) => a.order - b.order)) : []),
    [lens, present, scope, schema.categories])
    const icons = useMemo(() => Object.fromEntries(schema.categories.map((c) => [c.id, c.icon])), [schema.categories])
    const readsPosture = schema.categories.find((c) => c.id === 'reads')?.posture

    // The setting a link points at (`#reads-mode`) is marked, and shown even when "Changed only"
    // would hide it.
    const highlight: string | null = keyOfAnchor[location.hash.slice(1)] ?? null
    const onlyChanged = onlyChangedAsked && !(highlight && !changedHere(values[highlight], scope) && !stagedKeys.has(highlight))
    const inactive = useMemo(() => Object.values(values).filter((r) => r.status === 'dormant' || r.status === 'not_used').map((r) => r.key), [values])

    // ── Showing one setting: a deep link, a search result, a symptom's "Show" ──
    const show = useCallback((key: string) => {
        navigate({ search: location.search, hash: settingAnchor(key) }, { replace: true })
    }, [navigate, location.search])

    const goTo = useCallback((key: string) => {
        const el = document.getElementById(settingAnchor(key))
        el?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' })
        el?.focus({ preventScroll: true })
    }, [reduced])

    useEffect(() => {
        if (!highlight) return
        const raf = requestAnimationFrame(() => goTo(highlight))
        return () => cancelAnimationFrame(raf)
    }, [highlight, goTo])

    /** A setting the page already points at is gone back to by hand: a link to it changes nothing. */
    const showOrReturn = (key: string) => {
        if (key === highlight) goTo(key)
        else show(key)
    }

    /** "Changed only": turning it on lets go of a link to a setting it would hide. */
    const askOnlyChanged = (on: boolean) => {
        setOnlyChanged(on)
        if (on && highlight) navigate({ search: location.search }, { replace: true })
    }

    const jump = useCallback((id: string) => {
        const el = document.getElementById(categoryAnchor(id))
        el?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' })
        el?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
        setCurrentCategory(id)
    }, [reduced])

    // A link to a category (`#category-builds`, as Admin → Infrastructure links) opens at it.
    const linkedCategory = schema.categories.find((c) => location.hash === `#${categoryAnchor(c.id)}`)?.id ?? null
    useEffect(() => {
        if (!linkedCategory) return
        const raf = requestAnimationFrame(() => jump(linkedCategory))
        return () => cancelAnimationFrame(raf)
    }, [linkedCategory, jump])

    // The rail follows the category in view.
    useEffect(() => {
        if (typeof IntersectionObserver === 'undefined') return
        const io = new IntersectionObserver((entries) => {
            const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
            if (top) setCurrentCategory((top.target as HTMLElement).dataset.category ?? null)
        }, { rootMargin: '-10% 0px -70% 0px' })
        document.querySelectorAll('[data-category]').forEach((el) => io.observe(el))
        return () => io.disconnect()
    }, [categories, onlyChanged])

    // ── What rows need, kept stable ──────────────────────────────────────────
    const latestSwitches = useRef(switches)
    useEffect(() => { latestSwitches.current = switches })
    const { stage } = editor
    const onFix = useCallback((fix: WhyFix) => {
        if (fix.feature) latestSwitches.current?.request(fix.feature, fix.to !== false)
        else if (fix.setting) {
            stage(fix.setting, fix.to)
            show(fix.setting)
        }
    }, [stage, show])
    const switchNames = switches?.names
    const featureNames = useMemo(() => ({ ...FEATURE_NAMES, ...switchNames }), [switchNames])
    const fixLabel = useCallback((fix: WhyFix) => describeFix(fix, { settings: byKey, featureNames }), [byKey, featureNames])
    const { current, next } = staged
    const visuals = useMemo(() => ({ settings: byKey, current, next, facts, stage }), [byKey, current, next, facts, stage])
    const stagedMap = useMemo(() => Object.fromEntries(staged.changes.map((c) => [c.key, c.ownAfter])), [staged.changes])

    const row = (s: Setting) => (
        <RowItem
            key={s.key}
            setting={s}
            resolved={values[s.key]}
            scope={scope}
            lens={lens}
            staged={staged.isStaged(s.key) ? staged.valueAt(s.key) : undefined}
            error={editor.errors[s.key]}
            quick={editor.quick[s.key]}
            checking={editor.quickPending && staged.isStaged(s.key)}
            editLimits={editLimits}
            stagedLimits={staged.stagedLimits(s.key)}
            limitError={editor.limitErrors[s.key]}
            platformValue={staged.next[s.key]}
            highlighted={highlight === s.key}
            onStage={editor.stage}
            onUnstage={editor.unstage}
            onStageLimits={editor.stageLimits}
            onUnstageLimits={editor.unstageLimits}
            onFix={readOnly ? undefined : onFix}
            fixLabel={fixLabel}
            dimensions={schema.dimensions}
            glossary={schema.glossary}
        />
    )

    const nodes = facts.nodes
    // The marks as served and as staged: the gauges draw only what is known, never a stand-in.
    const marks = [staged.next['residency.unloadStartPct'], staged.next['residency.unloadStopPct'],
        staged.current['residency.unloadStartPct'], staged.current['residency.unloadStopPct']]
    const memoryGauges = (category: string) => category === 'residency' && nodes?.length && marks.every((m) => typeof m === 'number') ? (
        <MemoryMarks
            nodes={nodes}
            start={Number(marks[0])}
            stop={Number(marks[1])}
            saved={{ start: Number(marks[2]), stop: Number(marks[3]) }}
            startRange={byKey['residency.unloadStartPct']?.range ?? undefined}
            stopRange={byKey['residency.unloadStopPct']?.range ?? undefined}
            margin={byKey['residency.unloadStopPct']?.rules.find((r) => r.other === 'residency.unloadStartPct')?.margin ?? 0}
            onChange={readOnly ? undefined : (start: number, stop: number) => {
                if (start !== staged.next['residency.unloadStartPct']) stage('residency.unloadStartPct', start)
                if (stop !== staged.next['residency.unloadStopPct']) stage('residency.unloadStopPct', stop)
            }}
        />
    ) : undefined

    const searchPlaceholder = lens === 'business' ? 'Search settings or problems' : 'Search settings, problems or env vars'
    const signalProps = signals ? { signals } : {}

    return (
        <VisualContext.Provider value={visuals}>
            <div className="grid items-start gap-x-10 gap-y-6 lg:grid-cols-[13.5rem_minmax(0,1fr)]">
                <nav aria-label="Setting categories" className="sticky top-6 hidden lg:block">
                    <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-secondary">Categories</p>
                    <ul className="space-y-0.5">
                        {categories.map((c, i) => (
                            <Fragment key={c.id}>
                                {i === teamFrom && (
                                    <li className="mx-3 mb-1.5 mt-3 border-t border-glass-border/60 pt-3 text-[11.5px] font-medium leading-snug text-ink-secondary">
                                        {PLATFORM_TEAM}
                                    </li>
                                )}
                                <RailItem id={c.id} label={c.label} icon={c.icon} note={note(c.id)}
                                    staged={counts[c.id]?.staged ?? 0} current={currentCategory === c.id} onJump={jump} />
                            </Fragment>
                        ))}
                    </ul>
                </nav>

                <div className="min-w-0 space-y-5">
                    {/* On a phone the rail is this select, kept in reach while the settings scroll by. */}
                    <div className="sticky top-0 z-20 -mt-2 bg-canvas py-2 lg:hidden">
                        <Select
                            aria-label="Go to a category"
                            value={currentCategory ?? categories[0]?.id ?? ''}
                            onChange={jump}
                            options={categories.flatMap((c, i) => [
                                // The platform team's divider, as the rail has it: a heading among the options, not one to pick.
                                ...(i === teamFrom ? [{ value: '', label: PLATFORM_TEAM, disabled: true }] : []),
                                {
                                    value: c.id,
                                    label: `${c.label}${counts[c.id]?.changed ? ` · ${words.changed(counts[c.id].changed)}` : ''}${counts[c.id]?.staged ? ` · ${counts[c.id].staged} not saved` : ''}`,
                                },
                            ])}
                        />
                    </div>

                    <SettingsHero
                        eyebrow={scope === 'platform' ? 'Settings · the platform' : `Defaults · ${workspaceName ?? 'this workspace'}`}
                        headline={words.headline(changedCount, rows.length)}
                        posture={readsPosture && (
                            <>
                                {/* The server writes it from the platform's values: below the platform, it says so. */}
                                {scope !== 'platform' && <span className="font-semibold text-ink">Across the platform: </span>}
                                {readsPosture}
                            </>
                        )}
                        staged={staged.dirtyCount}
                        problems={editor.problems}
                        onReview={() => editor.review.setOpen(true)}
                        suggestions={suggestions.length}
                        onSuggestions={() => { if (suggestions[0]) showOrReturn(suggestions[0].key) }}
                        readOnlyNote={readOnly ? words.readOnly : null}
                        actions={(
                            <>
                                {offerSetup && setup && (
                                    // The page's first step: filled, in the app's indigo-to-violet.
                                    <Button ref={setSetupButton} variant="primary" leftIcon={Route} onClick={setup.onStart}
                                        className="bg-indigo-600 bg-gradient-to-r from-indigo-600 to-violet-600 shadow-indigo-600/25">
                                        {setup.label}
                                    </Button>
                                )}
                                {!readOnly && (
                                    <ProfileEntry variant="button" primary={!offerSetup} profiles={schema.profiles} scope={scope} editor={data.editor}
                                        resolved={values} onStage={editor.stage} lens={lens} />
                                )}
                                {/* Finding what's behind a problem changes nothing: a viewer who may only read has it too. Its
                                    edge a divider's: the plain glass edge is white, invisible on the card. */}
                                <Button ref={finderButton} leftIcon={Stethoscope} aria-expanded={finderOpen} onClick={() => toggleFinder(!finderOpen)}
                                    className="border-glass-border/80">
                                    Something’s wrong?
                                </Button>
                                {/* A workspace's page has no header of the section's own: its guide is here. */}
                                {scope === 'workspace' && (
                                    <Link to="/guide/versioned-graph-settings"
                                        className="inline-flex items-center gap-1.5 rounded text-[13px] font-medium text-indigo-700 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent-lineage/40 dark:text-indigo-300">
                                        <BookOpen aria-hidden className="w-4 h-4" /> The settings guide
                                    </Link>
                                )}
                            </>
                        )}
                        compass={(
                            <CompassSummary dimensions={schema.dimensions} settings={present} current={staged.current} next={staged.next}
                                inactive={inactive} open={compassOpen} onToggle={() => setCompassOpen((o) => !o)} />
                        )}
                        compassOpen={compassOpen}
                        tools={(
                            <>
                                <SettingsSearch className="min-w-0 flex-1 basis-72 max-w-2xl" settings={present} categories={schema.categories} onSelect={show}
                                    placeholder={searchPlaceholder} lens={lens} />
                                <label className="inline-flex items-center gap-2 text-[13px] font-medium text-ink-secondary">
                                    <Switch size="sm" checked={onlyChanged} onChange={askOnlyChanged} aria-label={words.onlyLabel} />
                                    {words.only} <span className="text-[12.5px] font-normal text-ink-secondary">({onlyCount})</span>
                                </label>
                            </>
                        )}
                    />

                    {/* Opened from the hero's actions, full width under it. */}
                    {finderOpen && (
                        <div ref={finderPanel}>
                            <SymptomFinder settings={present} values={values} staged={stagedMap} onStage={readOnly ? undefined : (k: string, v: SettingValue) => editor.stage(k, v)}
                                onShow={show} onClose={() => toggleFinder(false)} {...signalProps} signalsUnavailable={signalsUnavailable} />
                        </div>
                    )}

                    <TaskCards tasks={tasks} icons={icons} search={location.search} current={highlight} onAgain={goTo} />

                    <div className="space-y-12 pt-2">
                        {categories.map((c, i) => {
                            const all = present.filter((s) => s.category === c.id)
                            const settable = all.filter((s) => s.scopes[scope])
                            // Below the platform: what only the platform sets, read-only, with the value in force here.
                            const fixed = all.filter((s) => !s.scopes[scope])
                            const shown = onlyChanged ? settable.filter((s) => changedHere(values[s.key], scope) || stagedKeys.has(s.key)) : settable
                            return (
                                <Fragment key={c.id}>
                                    {i === teamFrom && (
                                        <div className="flex items-center gap-3 border-t border-glass-border/60 pt-8">
                                            <span className="grid place-items-center w-9 h-9 shrink-0 rounded-xl bg-black/[0.04] text-ink-secondary dark:bg-white/[0.06]">
                                                <UsersRound aria-hidden className="w-4 h-4" />
                                            </span>
                                            <p className="min-w-0 text-[13.5px] font-semibold text-ink-secondary">{PLATFORM_TEAM}</p>
                                        </div>
                                    )}
                                    <CategorySection
                                        category={c}
                                        scope={scope}
                                        settings={shown}
                                        total={settable.length}
                                        changed={counts[c.id]?.changed ?? 0}
                                        staged={counts[c.id]?.staged ?? 0}
                                        lens={lens}
                                        masterSwitch={!c.masterSwitch ? undefined : switches
                                            ? <MasterSwitchCard featureKey={c.masterSwitch} switches={switches} readOnly={readOnly} />
                                            : <MasterSwitchStatus featureKey={c.masterSwitch} />}
                                        extra={onlyChanged ? undefined : memoryGauges(c.id)}
                                        fixed={onlyChanged || fixed.length === 0 ? undefined : <PlatformWideSettings settings={fixed} values={values} highlight={highlight} category={c.label} />}
                                        deployment={onlyChanged ? [] : schema.deployment.filter((f) => f.category === c.id)}
                                        row={row}
                                        filtered={onlyChanged}
                                        onShowAll={() => setOnlyChanged(false)}
                                    />
                                </Fragment>
                            )
                        })}
                    </div>

                    <StickySaveBar count={staged.dirtyCount} problems={editor.problems} saving={editor.review.saving}
                        onReview={() => editor.review.setOpen(true)} onDiscard={() => setDiscarding(true)} />
                </div>
            </div>

            <SettingsReview
                open={editor.review.open}
                onOpenChange={editor.review.setOpen}
                items={editor.review.items}
                where={where}
                settings={byKey}
                dimensions={schema.dimensions}
                impact={editor.review.full?.impact}
                impactPending={editor.review.fullPending}
                impactError={editor.review.fullError}
                onRetryImpact={editor.review.retryFull}
                onSave={editor.review.save}
                saving={editor.review.saving}
                error={editor.review.error}
                onReapply={editor.review.reapply}
                round={editor.review.round}
            />
            <ConfirmDialog
                open={discarding}
                onOpenChange={setDiscarding}
                title={`Discard ${staged.dirtyCount} ${staged.dirtyCount === 1 ? 'change' : 'changes'}?`}
                confirmLabel="Discard"
                tone="danger"
                onConfirm={() => { staged.reset(); setDiscarding(false) }}
            >
                Your staged changes go back to the values in force. Nothing has been saved.
            </ConfirmDialog>
            {switches?.dialogs}
            {offerSetup && <SetupCoachMark anchor={setupButton} />}
            <p className="sr-only" aria-live="polite">{editor.announcement}</p>
        </VisualContext.Provider>
    )
}
