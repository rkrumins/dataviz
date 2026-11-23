/**
 * The settings kit's harness page (mounted by `settingsHarness.tsx`): the building blocks composed
 * the way a settings page will use them, against the fixture registry and the resolver's answers
 * (`components/settings/__fixtures__`). No API, no auth. Every state is a URL away, in both themes,
 * so the kit is judged by looking.
 *
 *   npm run harness
 *   open http://localhost:5199/settings-harness.html?fixture=platform&theme=dark
 *
 * `npm run harness:settings` drives Chromium over every fixture and writes PNGs to .harness/.
 *
 *   fixture   platform | business | graph | review | visuals | visuals-signals | profiles |
 *             profiles-applied | primitives
 *   theme     `dark` for the dark palette
 *
 * The page opens in the app's Business view for `business` and `graph`, else the Technical one;
 * its switch is the app's own (`LensSwitch`), so flipping it changes the persona, as in the app.
 *
 * `visuals-signals` gives the symptom finder a day's signal counts; `profiles` opens the profile
 * picker on the platform with Fastest reads chosen, and `profiles-applied` applies Balanced to a
 * graph as a workspace admin, to show what was staged and what was left out.
 */
import { MotionGlobalConfig } from 'framer-motion'
import { useEffect, useMemo, useState } from 'react'

import { Button } from '../components/ui/Button'
import { Card, CardHeader } from '../components/ui/Card'
import { ConfirmDialog } from '../components/ui/Dialog'
import { Drawer } from '../components/ui/Drawer'
import { Field } from '../components/ui/Field'
import { Input } from '../components/ui/Input'
import { NumberInput } from '../components/ui/NumberInput'
import { QuantityInput } from '../components/ui/QuantityInput'
import { Select } from '../components/ui/Select'
import { Switch } from '../components/ui/Switch'
import {
    ChangeReviewDialog, CopyRoomBar, GuardMeter, IdleTimeline, LensSwitch, MemoryMarks, ProfilePicker, ReadTimeline, RetentionTimeline,
    SettingRow, SettingsSearch, SettingVisual, StickySaveBar, SymptomFinder, TradeoffCompass, WriteRhythm,
    describeFix, orderForLens, reviewItems, settingAnchor, useLens, useStagedChanges, validateStaged, boundsAt,
    type ResolvedValues, type Scope, type SettingValue,
} from '../components/settings'
import { SCHEMA, SETTINGS_BY_KEY } from '../components/settings/__fixtures__/schema'
import { FACTS, GRAPH_VALUES, PLATFORM_VALUES, SIGNAL_COUNTS } from '../components/settings/__fixtures__/resolved'
import { BYTE_UNITS, DURATION_UNITS } from '../lib/units'
import { usePersonaStore } from '../store/persona'
import { usePreferencesStore } from '../store/preferences'

const params = new URLSearchParams(window.location.search)
const fixture = params.get('fixture') ?? 'platform'
const dark = params.get('theme') === 'dark'

MotionGlobalConfig.skipAnimations = true
usePersonaStore.setState({ mode: fixture === 'business' || fixture === 'graph' ? 'business' : 'technical' })

/** Changes a fixture stages once the page has drawn, the way a person would. */
const STAGED: Record<string, Array<[string, SettingValue | null]>> = {
    platform: [['reads.mode', 'in_place'], ['residency.unloadStartPct', 85], ['updates.pacingRatio', 0.5]],
    business: [['reads.mode', 'in_place']],
    graph: [['imports.guardDeleteShare', 0.25]],
    review: [['reads.mode', 'in_place'], ['residency.unloadStartPct', 85], ['drafts.keepClosedDays', 14]],
}

const CATEGORIES: Record<string, string[]> = {
    platform: ['reads', 'residency', 'updates', 'builds'],
    business: ['reads', 'drafts', 'imports'],
    review: ['reads', 'residency', 'drafts'],
}

function SettingsPage({ scope, values, inDrawer = false }: {
    scope: Scope
    values: ResolvedValues
    inDrawer?: boolean
}) {
    const [lens] = useLens()
    const staged = useStagedChanges(values, scope)
    const [reviewing, setReviewing] = useState(fixture === 'review')
    const [openKey, setOpenKey] = useState<string | null>(fixture === 'platform' ? 'residency.unloadStartPct' : null)

    // The fixture's staged changes, made once the page is up (a timer: staging is a person's act).
    useEffect(() => {
        const t = setTimeout(() => (STAGED[fixture] ?? []).forEach(([k, v]) => staged.stage(k, v)), 0)
        return () => clearTimeout(t)
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
    }, [])

    const stagedMap = Object.fromEntries(staged.changes.map((c) => [c.key, c.ownAfter]))
    const errors = validateStaged(SETTINGS_BY_KEY, stagedMap, (key) => ({
        values: staged.next,
        bounds: boundsAt(SETTINGS_BY_KEY[key], values[key], scope),
        allowed: values[key]?.allowed,
    }))
    const settings = useMemo(() => {
        const present = SCHEMA.settings.filter((s) => values[s.key] && (inDrawer || (CATEGORIES[fixture] ?? []).includes(s.category)))
        return orderForLens(present, lens, SCHEMA.categories)
    }, [values, lens, inDrawer])
    const inactive = Object.values(values).filter((r) => r.status === 'dormant' || r.status === 'not_used').map((r) => r.key)
    const items = reviewItems(staged.changes, SETTINGS_BY_KEY, values, scope)
    const show = (key: string) => document.getElementById(settingAnchor(key))?.scrollIntoView({ behavior: 'smooth', block: 'start' })

    return (
        <div className="space-y-6">
            {!inDrawer && (
                <>
                    <div className="flex flex-wrap items-end justify-between gap-4">
                        <div>
                            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">Administration · Versioned graphs</p>
                            <h1 className="mt-1 text-2xl font-bold tracking-tight text-ink">Settings</h1>
                            <p className="mt-1 max-w-2xl text-sm text-ink-muted">{SCHEMA.categories[0].posture}</p>
                        </div>
                        <LensSwitch />
                    </div>
                    <SettingsSearch className="max-w-xl" settings={SCHEMA.settings} categories={SCHEMA.categories} onSelect={show} lens={lens} />
                    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
                        <TradeoffCompass dimensions={SCHEMA.dimensions} settings={SCHEMA.settings} current={staged.current} next={staged.next} inactive={inactive} />
                        <SymptomFinder settings={SCHEMA.settings} values={values} staged={stagedMap} onStage={staged.stage} onShow={show} />
                    </div>
                </>
            )}
            <div className="space-y-4">
                {settings.map((s) => (
                    <SettingRow
                        key={s.key}
                        setting={s}
                        resolved={values[s.key]}
                        scope={scope}
                        lens={lens}
                        staged={staged.isStaged(s.key) ? staged.valueAt(s.key) : undefined}
                        onStage={(v) => staged.stage(s.key, v)}
                        onUnstage={() => staged.unstage(s.key)}
                        error={errors[s.key]}
                        onFix={() => {}}
                        fixLabel={(f) => describeFix(f, { settings: SETTINGS_BY_KEY })}
                        dimensions={SCHEMA.dimensions}
                        glossary={SCHEMA.glossary}
                        defaultOpen={openKey === s.key}
                        visual={s.visual ? (
                            <SettingVisual setting={s} settings={SETTINGS_BY_KEY} current={staged.current} next={staged.next} facts={FACTS}
                                onStage={staged.stage} />
                        ) : undefined}
                    />
                ))}
            </div>
            <StickySaveBar count={staged.dirtyCount} problems={Object.keys(errors).length} onReview={() => setReviewing(true)}
                onDiscard={() => { staged.reset(); setOpenKey(null) }} />
            <ChangeReviewDialog
                open={reviewing}
                onOpenChange={setReviewing}
                items={items}
                where={scope === 'graph' ? 'Sales lineage' : 'the platform'}
                dimensions={SCHEMA.dimensions}
                impact={(
                    <ul className="grid gap-2 text-[13px] text-ink-secondary sm:grid-cols-3">
                        <li className="rounded-xl bg-black/[0.03] px-3 py-2.5 dark:bg-white/[0.04]"><span className="block text-lg font-semibold text-ink">41 graphs</span>keep reads on the graph store while they update</li>
                        <li className="rounded-xl bg-black/[0.03] px-3 py-2.5 dark:bg-white/[0.04]"><span className="block text-lg font-semibold text-ink">2 nodes</span>unload less: Node 1 and Node 3</li>
                        <li className="rounded-xl bg-black/[0.03] px-3 py-2.5 dark:bg-white/[0.04]"><span className="block text-lg font-semibold text-ink">18 drafts</span>lose their changes at the next sweep</li>
                    </ul>
                )}
                warnings={[{ id: 'drafts', text: 'Shortening how long closed drafts keep their changes removes the changes of 18 drafts within the hour. They don’t come back.' }]}
                onSave={() => { staged.markSaved(); setReviewing(false) }}
            />
        </div>
    )
}

/** Clicks what a person would, once the page has drawn: a harness state is a URL, not a script. */
function useClickOnce(find: () => HTMLElement | null | undefined, when: boolean) {
    useEffect(() => {
        if (!when) return
        const t = setTimeout(() => find()?.click(), 0)
        return () => clearTimeout(t)
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
    }, [])
}

function Visuals({ signals = false }: { signals?: boolean }) {
    const [marks, setMarks] = useState({ start: 85, stop: 70 })
    const current = Object.fromEntries(Object.values(PLATFORM_VALUES).map((r) => [r.key, r.effective]))
    // With the day's counts, open the problem that leads: what happened most past its mark.
    useClickOnce(() => document.querySelector<HTMLElement>('[aria-label="Common problems"] button'), signals)
    return (
        <div className="grid items-start gap-6 xl:grid-cols-2">
            <TradeoffCompass dimensions={SCHEMA.dimensions} settings={SCHEMA.settings} current={current}
                next={{ ...current, 'reads.mode': 'in_place', 'residency.unloadStartPct': 90 }}
                inactive={Object.values(PLATFORM_VALUES).filter((r) => r.status === 'dormant' || r.status === 'not_used').map((r) => r.key)} />
            <SymptomFinder settings={SCHEMA.settings} values={PLATFORM_VALUES} signals={signals ? SIGNAL_COUNTS : undefined} />
            <ReadTimeline className="xl:col-span-2" setting={SETTINGS_BY_KEY['reads.mode']} value="latest" next="beside" />
            <MemoryMarks nodes={FACTS.nodes!} start={marks.start} stop={marks.stop} saved={{ start: 80, stop: 70 }} margin={5}
                onChange={(start, stop) => setMarks({ start, stop })} />
            <CopyRoomBar graph={FACTS.largestGraph!} copyRoomPct={100} nextCopyRoomPct={220} startPct={80} nodes={FACTS.nodes!} />
            <WriteRhythm statementTargetMs={500} pacingRatio={0.25} readPressureRatio={2} next={{ statementTargetMs: 500, pacingRatio: 0.5, readPressureRatio: 2 }} />
            <GuardMeter limits={{ enabled: true, minLive: 1000, deleteShare: 0.5, createShare: 0.5, minMatchShare: 0.05 }}
                next={{ enabled: true, minLive: 1000, deleteShare: 0.15, createShare: 0.15, minMatchShare: 0.05 }} sample={FACTS.sampleImport!} />
            <RetentionTimeline days={30} nextDays={14} />
            <IdleTimeline standardIdleSecs={604800} coldlineIdleSecs={3600} next={{ standardIdleSecs: 1209600 }} />
        </div>
    )
}

/**
 * The profile picker as a page hosts it, in a drawer: on the platform as a system admin with Fastest
 * reads chosen, or (`applied`) on a graph as a workspace admin with Balanced applied.
 */
function Profiles({ applied }: { applied: boolean }) {
    const [lens] = useLens()
    const scope: Scope = applied ? 'graph' : 'platform'
    const values = applied ? GRAPH_VALUES : PLATFORM_VALUES
    const staged = useStagedChanges(values, scope)
    const [open, setOpen] = useState(true)
    useClickOnce(() => (applied
        ? [...document.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.startsWith('Apply '))
        : document.querySelector<HTMLElement>('[role="radio"][aria-label="Fastest reads"]')), true)
    return (
        <Drawer open={open} onOpenChange={setOpen} size="xl" title="Start from a profile"
            eyebrow={applied ? 'Graph · Sales lineage' : 'Administration · Versioned graphs'}>
            <ProfilePicker profiles={SCHEMA.profiles} scope={scope} editor={applied ? 'workspace_admin' : 'system_admin'}
                resolved={values} onStage={staged.stage} onClose={() => setOpen(false)} lens={lens} />
        </Drawer>
    )
}

function Primitives() {
    const [name, setName] = useState('Sales lineage')
    const [pct, setPct] = useState<number | null>(85)
    const [bytes, setBytes] = useState<number | null>(13 * 1024 ** 3)
    const [secs, setSecs] = useState<number | null>(1800)
    const [mode, setMode] = useState('auto')
    const [on, setOn] = useState(true)
    const [confirm, setConfirm] = useState(false)
    return (
        <div className="grid gap-6 lg:grid-cols-2">
            <Card>
                <CardHeader eyebrow="Fields" title="Every control explains itself" description="Label, one line of help, and an error that says how to fix it." />
                <div className="mt-5 space-y-5">
                    <Field label="Graph name" help="Shown wherever the graph is listed."><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
                    <Field label="Start unloading at" help="When a node’s memory reaches this." error={pct !== null && pct > 95 ? 'Enter 50% to 95%.' : null}>
                        <NumberInput value={pct} onChange={setPct} min={50} max={95} unit="%" name="Start unloading at" />
                    </Field>
                    <Field label="Largest graph copied" help="Larger graphs are rebuilt from the database."><QuantityInput value={bytes} onChange={setBytes} units={BYTE_UNITS} name="Largest graph copied" /></Field>
                    <Field label="Unload unread Coldline graphs after" layout="inline" help="From 5 minutes to 7 days."><QuantityInput value={secs} onChange={setSecs} units={DURATION_UNITS} name="Idle time" /></Field>
                    <Field label="How a new version is built" layout="inline">
                        <Select value={mode} onChange={setMode} options={[{ value: 'auto', label: 'Copy if there is room' }, { value: 'copy', label: 'Copy only' }, { value: 'reseed', label: 'Rebuild from the database' }]} />
                    </Field>
                    <Field label="Unload graphs automatically" layout="inline" help="Off: nothing is unloaded."><Switch size="sm" checked={on} onChange={setOn} /></Field>
                </div>
            </Card>
            <Card tone="accent">
                <CardHeader eyebrow="Your change" title="A card that holds the reader’s own change" description="The one accent on a page." actions={<Button size="sm" variant="primary" onClick={() => setConfirm(true)}>Discard…</Button>} />
            </Card>
            <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Discard 3 changes?" confirmLabel="Discard" tone="danger"
                onConfirm={() => setConfirm(false)}>Your staged changes go back to the values in force. Nothing has been saved.</ConfirmDialog>
        </div>
    )
}

export function SettingsKitHarness() {
    const setTheme = usePreferencesStore((s) => s.setTheme)
    const [drawer, setDrawer] = useState(fixture === 'graph')
    useEffect(() => {
        setTheme(dark ? 'dark' : 'light')
        document.documentElement.classList.toggle('dark', dark)
    }, [setTheme])

    return (
        <div className="min-h-screen bg-canvas-base text-ink">
            <div className="h-11 flex items-center gap-3 px-4 border-b border-glass-border/60 text-xs text-ink-muted">
                <span className="font-display font-semibold text-ink">Settings kit</span>
                <span className="font-mono">fixture={fixture} · {dark ? 'dark' : 'light'}</span>
                {fixture !== 'graph' && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setDrawer(true)}>Open a graph’s settings</Button>}
            </div>
            <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
                {fixture === 'visuals' || fixture === 'visuals-signals' ? <Visuals signals={fixture === 'visuals-signals'} />
                    : fixture === 'primitives' ? <Primitives />
                        : fixture !== 'graph' && <SettingsPage scope="platform" values={PLATFORM_VALUES} />}
            </main>
            {fixture.startsWith('profiles') && <Profiles applied={fixture === 'profiles-applied'} />}
            <Drawer open={drawer} onOpenChange={setDrawer} eyebrow="Graph · Finance" title="Sales lineage" size="xl"
                description="Settings for this graph. Values it doesn’t set come from the workspace, then the platform.">
                <SettingsPage scope="graph" values={GRAPH_VALUES} inDrawer />
            </Drawer>
        </div>
    )
}
