/**
 * Settings — every setting, by category: the platform's for its system admins, or a workspace's
 * (`scope="workspace"`) on that workspace's page, within the platform's limits.
 *
 *   rail          the seven categories, each with how many values are chosen at this level (on the
 *                 platform: differ from the default) and how many are staged; a select on a phone
 *   toolbar       Business / Operator lens, search (`/`), "Changed only", a profile to start from
 *   guides        the trade-off compass and "Something's wrong?", folded to one line each so the
 *                 first setting is on the first screen
 *   categories    each with its posture, its switch, its settings and what the deployment sets;
 *                 for a workspace, what only the platform sets is listed read-only, with its value
 *   save bar      Review → the full preview, warnings, a reason → Save → Undo
 *
 * A link to `#reads-mode` (or a search result, or a symptom's "Show") scrolls to that setting,
 * focuses it and marks it.
 */
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useReducedMotion } from 'framer-motion'
import { ChevronDown, Eye, Stethoscope, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/Dialog'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import {
    FEATURE_NAMES, LensSwitch, MemoryMarks, SettingsSearch, StickySaveBar, SymptomFinder, TradeoffCompass, compassMoves, compassScores,
    describeFix, ownValue, sameValue, scoreWords, settingAnchor, useLens,
    type CompassPoint, type DimensionInfo, type ResolvedSetting, type Setting, type SettingsFacts, type SettingValue,
    type Values, type WhyFix,
} from '@/components/settings'
import type { ServedSchema, SettingsValues, SignalCount } from '@/services/settingsService'
import { CategoryIcon, CategorySection, PlatformWideSettings } from './CategorySection'
import { MasterSwitchCard, MasterSwitchStatus } from './MasterSwitch'
import type { FeatureSwitches } from './useFeatureSwitches'
import { categoryAnchor } from './meta'
import { ProfileEntry } from './ProfileEntry'
import { RowItem } from './SettingsRows'
import { VisualContext } from './visualContext'
import { SavedBar, SettingsReview } from './SettingsReview'
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
    only: string
    onlyLabel: string
    readOnly: string
}> = {
    platform: {
        changed: (n) => `${n} changed`,
        none: () => 'All defaults',
        only: 'Changed only',
        onlyLabel: 'Show changed settings only',
        readOnly: 'You can read these settings and why each is what it is. Only a system admin can change them.',
    },
    workspace: {
        changed: (n) => `${n} ${n === 1 ? 'value' : 'values'} set here`,
        none: (settable) => (settable ? 'All inherited' : 'Platform-wide'),
        only: 'Set here only',
        onlyLabel: 'Show settings set for this workspace only',
        readOnly: 'You can read this workspace’s settings and why each is what it is. A workspace admin can change them.',
    },
}

/** Seven axes on a tile: the compass at a glance, beside its one-line summary. */
function MiniRadar({ points, ghost }: { points: CompassPoint[]; ghost: CompassPoint[] | null }) {
    const n = points.length || 1
    const at = (i: number, score: number) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / n
        const r = 15 * (0.18 + 0.82 * ((score + 1) / 2))
        return `${(18 + r * Math.cos(a)).toFixed(1)},${(18 + r * Math.sin(a)).toFixed(1)}`
    }
    return (
        <svg aria-hidden viewBox="0 0 36 36" className="w-9 h-9 shrink-0">
            <polygon points={points.map((_, i) => at(i, 1)).join(' ')} className="fill-none stroke-ink-muted/25" strokeWidth={1} />
            <polygon points={points.map((p, i) => at(i, p.score)).join(' ')} className="fill-ink-secondary/10 stroke-ink-secondary" strokeWidth={1.5} strokeLinejoin="round" />
            {ghost && <polygon points={ghost.map((p, i) => at(i, p.score)).join(' ')} className="fill-none stroke-accent-lineage" strokeWidth={1.5} strokeDasharray="3 2" strokeLinejoin="round" />}
        </svg>
    )
}

/** The compass, folded to a line: the dimensions it leans on most, and how staged changes move them. */
function CompassSummary({ dimensions, settings, current, next, inactive, open, onToggle }: {
    dimensions: DimensionInfo[]
    settings: Setting[]
    current: Values
    next: Values
    inactive: string[]
    open: boolean
    onToggle: () => void
}) {
    const id = useId()
    const skip = useMemo(() => new Set(inactive), [inactive])
    const points = useMemo(() => compassScores(dimensions, settings, current, skip), [dimensions, settings, current, skip])
    const ghost = useMemo(() => compassScores(dimensions, settings, next, skip), [dimensions, settings, next, skip])
    const moved = compassMoves(points, ghost)
    const lead = points.filter((p) => p.touched && Math.abs(p.score) >= 0.1).sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 3)
    const shifted = moved ? points.filter((p, i) => Math.abs(p.score - ghost[i].score) > 0.005).length : 0
    return (
        <div className={cn('rounded-2xl border border-glass-border/50 bg-canvas-elevated', open && 'col-span-full')}>
            <button type="button" aria-expanded={open} aria-controls={`${id}-panel`} onClick={onToggle}
                className="flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                <MiniRadar points={points} ghost={moved ? ghost : null} />
                <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold text-ink">What your settings trade</span>
                    <span className="block text-xs text-ink-muted">
                        {lead.length ? lead.map((p) => `${p.label} ${scoreWords(p.score)}`).join(' · ') : 'Balanced on every dimension'}
                        {shifted > 0 && <span className="font-semibold text-accent-lineage"> · your changes move {shifted}</span>}
                    </span>
                </span>
                <ChevronDown aria-hidden className={cn('w-4 h-4 shrink-0 text-ink-muted transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
            </button>
            <div id={`${id}-panel`} hidden={!open} className="px-4 pb-4">
                {open && <TradeoffCompass dimensions={dimensions} settings={settings} current={current} next={next} inactive={inactive} className="border-0 bg-transparent p-0 sm:p-0" />}
            </div>
        </div>
    )
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
                <CategoryIcon name={icon} className="w-4 h-4 shrink-0 text-ink-muted" />
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{label}</span>
                    <span className="block text-[11px] text-ink-muted">
                        {note}
                        {staged > 0 && <span className="font-semibold text-accent-lineage"> · {staged} not saved</span>}
                    </span>
                </span>
                {staged > 0 && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-lineage" />}
            </button>
        </li>
    )
})

export function SettingsView({ schema, data, editor, switches, facts, signals, readOnly, scope = 'platform', where = 'the platform' }: {
    schema: ServedSchema
    data: SettingsValues
    editor: SettingsEditor
    /** The feature switches, which the platform's page turns on and off; without them a category's switch is shown, not flipped. */
    switches?: FeatureSwitches
    facts: SettingsFacts
    /** Signal counts for the finder, where the server counts them. */
    signals?: SignalCount[]
    readOnly: boolean
    /** The level edited: the platform, or a workspace, within the platform's limits. */
    scope?: Level
    /** Where a save applies, for the review: "the platform", "the Finance workspace". */
    where?: string
}) {
    const values = data.values
    const words = WORDS[scope]
    const { staged } = editor
    const [lens, setLens] = useLens()
    const [onlyChangedAsked, setOnlyChanged] = useState(false)
    const [compassOpen, setCompassOpen] = useState(false)
    const [finderOpen, setFinderOpen] = useState(false)
    const [discarding, setDiscarding] = useState(false)
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
    const changedTotal = Object.values(counts).reduce((n, c) => n + c.changed, 0)
    const note = (id: string) => (counts[id]?.changed ? words.changed(counts[id].changed) : words.none(counts[id]?.total ?? 0))

    // The setting a link points at (`#reads-mode`) is marked, and shown even when "Changed only"
    // would hide it.
    const highlight: string | null = keyOfAnchor[location.hash.slice(1)] ?? null
    const onlyChanged = onlyChangedAsked && !(highlight && !changedHere(values[highlight], scope) && !stagedKeys.has(highlight))
    const inactive = useMemo(() => Object.values(values).filter((r) => r.status === 'dormant' || r.status === 'not_used').map((r) => r.key), [values])

    // ── Showing one setting: a deep link, a search result, a symptom's "Show" ──
    const show = useCallback((key: string) => {
        navigate({ search: location.search, hash: settingAnchor(key) }, { replace: true })
    }, [navigate, location.search])

    useEffect(() => {
        if (!highlight) return
        const raf = requestAnimationFrame(() => {
            const el = document.getElementById(settingAnchor(highlight))
            el?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' })
            el?.focus({ preventScroll: true })
        })
        return () => cancelAnimationFrame(raf)
    }, [highlight, reduced])

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

    // Leaving with staged changes asks first (a reload, closing the tab).
    const dirty = staged.dirtyCount > 0
    useEffect(() => {
        if (!dirty) return
        const hold = (e: BeforeUnloadEvent) => { e.preventDefault() }
        window.addEventListener('beforeunload', hold)
        return () => window.removeEventListener('beforeunload', hold)
    }, [dirty])

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
    const memoryGauges = (category: string) => category === 'residency' && nodes?.length ? (
        <MemoryMarks
            nodes={nodes}
            start={Number(staged.next['residency.unloadStartPct'] ?? 80)}
            stop={Number(staged.next['residency.unloadStopPct'] ?? 70)}
            saved={{ start: Number(staged.current['residency.unloadStartPct'] ?? 80), stop: Number(staged.current['residency.unloadStopPct'] ?? 70) }}
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
                    <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">Categories</p>
                    <ul className="space-y-0.5">
                        {categories.map((c) => (
                            <RailItem key={c.id} id={c.id} label={c.label} icon={c.icon} note={note(c.id)}
                                staged={counts[c.id]?.staged ?? 0} current={currentCategory === c.id} onJump={jump} />
                        ))}
                    </ul>
                </nav>

                <div className="min-w-0 space-y-5">
                    <div className="lg:hidden">
                        <Select
                            aria-label="Go to a category"
                            value={currentCategory ?? categories[0]?.id ?? ''}
                            onChange={jump}
                            options={categories.map((c) => ({
                                value: c.id,
                                label: `${c.label}${counts[c.id]?.changed ? ` · ${words.changed(counts[c.id].changed)}` : ''}${counts[c.id]?.staged ? ` · ${counts[c.id].staged} not saved` : ''}`,
                            }))}
                        />
                    </div>

                    {readOnly && (
                        <p role="note" className="flex items-start gap-2 rounded-2xl border border-glass-border/60 bg-black/[0.02] px-4 py-3 text-[13px] text-ink-secondary dark:bg-white/[0.03]">
                            <Eye aria-hidden className="mt-0.5 w-4 h-4 shrink-0 text-ink-muted" />
                            {words.readOnly}
                        </p>
                    )}

                    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                        <LensSwitch value={lens} onChange={setLens} />
                        <label className="inline-flex items-center gap-2 text-[13px] font-medium text-ink-secondary">
                            <Switch size="sm" checked={onlyChanged} onChange={askOnlyChanged} aria-label={words.onlyLabel} />
                            {words.only} <span className="text-xs font-normal text-ink-muted">({changedTotal + stagedKeys.size})</span>
                        </label>
                    </div>
                    <SettingsSearch className="max-w-2xl" settings={present} categories={schema.categories} onSelect={show} placeholder={searchPlaceholder} />

                    {!readOnly && (
                        <ProfileEntry profiles={schema.profiles} scope={scope} editor={data.editor} resolved={values} onStage={editor.stage} />
                    )}

                    <div className="grid gap-3 lg:grid-cols-2">
                        <CompassSummary dimensions={schema.dimensions} settings={present} current={staged.current} next={staged.next}
                            inactive={inactive} open={compassOpen} onToggle={() => setCompassOpen((o) => !o)} />
                        {finderOpen ? (
                            <div className="relative col-span-full">
                                <IconButton icon={X} label="Close the finder" size="sm" className="absolute right-3 top-3 z-10" onClick={() => setFinderOpen(false)} />
                                <SymptomFinder settings={present} values={values} staged={stagedMap} onStage={readOnly ? undefined : (k: string, v: SettingValue) => editor.stage(k, v)}
                                    onShow={show} {...signalProps} />
                            </div>
                        ) : (
                            <button type="button" aria-expanded={false} onClick={() => setFinderOpen(true)}
                                className="flex items-center gap-3 rounded-2xl border border-glass-border/50 bg-canvas-elevated px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                                <span className="grid place-items-center w-9 h-9 shrink-0 rounded-xl bg-black/[0.04] text-ink-secondary dark:bg-white/[0.06]">
                                    <Stethoscope aria-hidden className="w-4 h-4" />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block text-[13px] font-semibold text-ink">Something’s wrong?</span>
                                    <span className="block text-xs text-ink-muted">Start from what you see; get the settings behind it.</span>
                                </span>
                                <ChevronDown aria-hidden className="w-4 h-4 shrink-0 text-ink-muted" />
                            </button>
                        )}
                    </div>

                    <div className="space-y-12">
                        {categories.map((c) => {
                            const all = present.filter((s) => s.category === c.id)
                            const settable = all.filter((s) => s.scopes[scope])
                            // Below the platform: what only the platform sets, read-only, with the value in force here.
                            const fixed = all.filter((s) => !s.scopes[scope])
                            const shown = onlyChanged ? settable.filter((s) => changedHere(values[s.key], scope) || stagedKeys.has(s.key)) : settable
                            return (
                                <CategorySection
                                    key={c.id}
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
                                    fixed={onlyChanged || fixed.length === 0 ? undefined : <PlatformWideSettings settings={fixed} values={values} highlight={highlight} />}
                                    deployment={onlyChanged ? [] : schema.deployment.filter((f) => f.category === c.id)}
                                    row={row}
                                    filtered={onlyChanged}
                                    onShowAll={() => setOnlyChanged(false)}
                                />
                            )
                        })}
                    </div>

                    <StickySaveBar count={staged.dirtyCount} problems={editor.problems} saving={editor.review.saving}
                        onReview={() => editor.review.setOpen(true)} onDiscard={() => setDiscarding(true)} />
                    {staged.dirtyCount === 0 && <SavedBar saved={editor.saved} />}
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
            <p className="sr-only" aria-live="polite">{editor.announcement}</p>
        </VisualContext.Provider>
    )
}
