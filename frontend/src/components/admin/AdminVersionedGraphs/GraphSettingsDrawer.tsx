/**
 * GraphSettingsDrawer — one graph's settings, beside the page it was opened from: the fleet's
 * inventory, a workspace's graphs, or a data source's Versioning tab.
 *
 * At the top, how the graph is doing now. Then the ways in, as the settings page has them: "Start
 * from a profile", opening in place (only the profiles a graph can take, staging only what this
 * person may set here), the trade-off compass at a glance, and "Something's wrong?", the finder,
 * counting what happened to this graph in the last day (its health's signals). Then each setting a
 * graph can have, with the value in force and where it came from (Default → Platform → Workspace →
 * Graph), why it differs from the one chosen, and "Set for this graph" offering only the choices
 * allowed here. The same save model as everywhere: stage, review the impact, give a reason, save,
 * undo — the save confirmed once, in the drawer, where the keyboard is.
 *
 *   a fork        has no settings of its own (it follows its root): it says so, names the root (as
 *                 its health does), and opens the root's
 *   not allowed   a setting only a system admin may change shows read-only, saying who may
 *   read-only     a viewer who may not change any, or while version control is off, reads them all
 *   settings a graph can't have (the platform's, a workspace's) are listed at the end, folded and
 *                 read-only, with how many differ from the default; each says its status only
 *                 where it isn't in effect here, and why not
 *
 * Nothing staged is dropped without asking: Esc, the overlay, ✕ and "Back" ask "Discard N
 * changes?" first. While something is staged, nothing here is refreshed over it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ArrowUpRight, ChevronDown, Eye, GitFork, RotateCw, Stethoscope } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/Dialog'
import { Drawer } from '@/components/ui/Drawer'
import { Skeleton } from '@/components/ui/Skeleton'
import {
    EDITOR_LABEL, FEATURE_NAMES, LensSwitch, ScopeBadge, StatusBadge, StickySaveBar, SymptomFinder, describeFix, formatValue, sameValue,
    settingAnchor, useLens, type ResolvedSetting, type ResolvedValues, type Setting, type SettingsFacts, type SettingValue, type WhyFix,
} from '@/components/settings'
import { useCalmMotion } from '@/components/settings/visuals/motion'
import { isFeatureOn, useFeaturesStore } from '@/store/features'
import { settingsError, useGraphHealth, useSettingsSchema, useSettingsValues, type SettingsPlace } from '@/services/settingsService'
import { GraphHealthPanel } from './GraphHealthPanel'
import { ProfileEntry } from './ProfileEntry'
import { RowItem } from './SettingsRows'
import { CompassSummary } from './SettingsHero'
import { VisualContext } from './visualContext'
import { SavedBar, SettingsReview } from './SettingsReview'
import { useSettingsEditor } from './useSettingsEditor'

export interface GraphSettingsDrawerProps {
    workspaceId: string
    graphId: string
    open: boolean
    onOpenChange: (open: boolean) => void
    /** The graph's name, for the title. */
    label?: string
    /** How many changes are staged in it, as it changes: the page's guard against leaving counts them. */
    onStagedChange?: (count: number) => void
}

const EMPTY: ResolvedValues = {}
const NO_FACTS: SettingsFacts = {}

/** The value that applies here isn't the default (the deployment's, else the code's). */
const notDefault = (r: ResolvedSetting) => !sameValue(r.declared ?? r.effective, r.trail[0]?.value)

/** Where a setting a graph can't have is set, and by whom: "On the platform, by a system admin". */
function whereSet(s: Setting): string {
    const at = [
        s.scopes.platform && `on the platform, by ${EDITOR_LABEL[s.scopes.platform]}`,
        s.scopes.workspace && `for a workspace, by ${EDITOR_LABEL[s.scopes.workspace]}`,
    ].filter(Boolean).join('; or ')
    return at ? `Set ${at}.` : ''
}

function Notice({ icon: Icon, children }: { icon: typeof Eye; children: ReactNode }) {
    return (
        <div role="note" className="flex items-start gap-2.5 rounded-2xl border border-glass-border/60 bg-black/[0.02] px-4 py-3 text-[13px] leading-relaxed text-ink-secondary dark:bg-white/[0.03]">
            <Icon aria-hidden className="mt-0.5 w-4 h-4 shrink-0 text-ink-secondary" />
            <div className="min-w-0">{children}</div>
        </div>
    )
}

/** What closing or going back asked for while changes are staged: the discard dialog is open for it. */
type Leaving = 'close' | 'back' | 'discard'

function GraphSettingsBody({ workspaceId, graphId, open, label, viewingRootOf, closeAsked, onCloseAnswered, onStaged, onBack, onOpenRoot }: {
    workspaceId: string
    graphId: string
    open: boolean
    label: string
    /** When showing a fork's root: the fork's name, and the root's where it is known. */
    viewingRootOf: { fork: string; root: string | null } | null
    /** Esc, the overlay or ✕ asked to close while changes are staged. */
    closeAsked: boolean
    /** The answer: discard and close, or stay. */
    onCloseAnswered: (discard: boolean) => void
    /** How many changes are staged, as it changes. */
    onStaged: (count: number) => void
    onBack: () => void
    onOpenRoot: (graphId: string, name: string | null) => void
}) {
    const place: SettingsPlace = useMemo(() => ({ scope: 'graph', workspaceId, graphId }), [workspaceId, graphId])
    const dirty = useRef(false)
    const schemaQ = useSettingsSchema()
    const valuesQ = useSettingsValues(place, { staged: () => dirty.current, enabled: open })
    const versioningOn = useFeaturesStore((s) => isFeatureOn(s.values, 'versioningEnabled'))
    const [lens] = useLens()
    const [asked, setAsked] = useState<Leaving | null>(null)
    const [compassOpen, setCompassOpen] = useState(false)
    const [finderOpen, setFinderOpen] = useState(false)
    // The setting the finder's "Show" went to: marked until another is.
    const [shown, setShown] = useState<string | null>(null)
    const bodyRef = useRef<HTMLDivElement>(null)
    const finderButton = useRef<HTMLButtonElement>(null)
    const finderPanel = useRef<HTMLDivElement>(null)
    const { reduced } = useCalmMotion()
    const schema = schemaQ.data
    const byKey = useMemo(() => Object.fromEntries((schema?.settings ?? []).map((s) => [s.key, s])), [schema])
    const served = valuesQ.data?.values ?? EMPTY
    const readOnly = !versioningOn || valuesQ.data?.editor === null
    // A feature switch is the platform's (Admin → Versioned graphs → Settings): its why says so,
    // with no button here. Read-only: nothing here can be changed, whatever each value allows.
    const values = useMemo(() => Object.fromEntries(Object.entries(served).map(([k, r]) => [k, {
        ...r,
        why: r.why.map((w) => (w.fix?.feature ? { ...w, fix: null } : w)),
        ...(readOnly ? { editable: false, editor: null } : {}),
    }])), [served, readOnly])
    const editor = useSettingsEditor({ place, values, settings: byKey, where: label, refetch: valuesQ.refetch, confirm: 'bar' })
    const stagedCount = editor.staged.dirtyCount
    useEffect(() => { dirty.current = stagedCount > 0 })
    useEffect(() => { onStaged(stagedCount) }, [stagedCount, onStaged])
    useEffect(() => () => onStaged(0), [onStaged])
    const { staged, stage } = editor
    // A read again that failed keeps the values already read (and what is staged over them).
    const error = valuesQ.error && !valuesQ.data ? settingsError(valuesQ.error) : null
    const forkRoot = error?.type === 'follows_root' ? error.root : null
    // The panel's own read of the graph's health: a fork's root by its name (the graph it reads
    // through), and what happened to the graph in the last day, which the finder counts. Not read
    // again over staged values, as the panel isn't (a fork has none).
    const healthQ = useGraphHealth(workspaceId, graphId, open && stagedCount === 0)
    const rootName = healthQ.data?.follows?.label ?? null
    const signals = useMemo(() => healthQ.data?.signals?.map((s) => ({ id: s.id, count: s.count24h, window: '24h' })), [healthQ.data])
    // The health says it couldn't count them: the finder says so, rather than show none.
    const signalsUnavailable = Boolean(healthQ.data) && !healthQ.data?.signals

    const fixLabel = useMemo(() => (fix: WhyFix) => describeFix(fix, { settings: byKey, featureNames: FEATURE_NAMES }), [byKey])
    const onFix = useMemo(() => (readOnly ? undefined : (fix: WhyFix) => { if (fix.setting) stage(fix.setting, fix.to) }), [readOnly, stage])
    const { current, next } = staged
    const visuals = useMemo(() => ({ settings: byKey, current, next, facts: NO_FACTS, stage }), [byKey, current, next, stage])
    const stagedMap = useMemo(() => Object.fromEntries(staged.changes.map((c) => [c.key, c.ownAfter])), [staged.changes])
    const inactiveKeys = useMemo(() => Object.values(values).filter((r) => r.status === 'dormant' || r.status === 'not_used').map((r) => r.key), [values])

    // Focus follows the finder: into its search as it opens, back to its button as it closes.
    useEffect(() => { if (finderOpen) finderPanel.current?.querySelector<HTMLElement>('input')?.focus() }, [finderOpen])
    const closeFinder = () => {
        setFinderOpen(false)
        finderButton.current?.focus()
    }
    /** A finder's "Show": the setting's row, or its line among those set for every graph (unfolded). */
    const show = (key: string) => {
        const el = bodyRef.current?.querySelector<HTMLElement>(`[id="${settingAnchor(key)}"]`)
        if (!el) return
        const fold = el.closest('details')
        if (fold) fold.open = true
        el.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' })
        el.focus({ preventScroll: true })
        setShown(key)
    }

    // Health isn't polled over staged values either: what the person decides against holds still.
    const health = <GraphHealthPanel workspaceId={workspaceId} graphId={graphId} enabled={open && stagedCount === 0} signals={schema?.signals} lens={lens} />
    // The discard dialog: asked for here (Discard, Back), or by closing the drawer.
    const leaving: Leaving | null = closeAsked ? 'close' : asked
    const goBack = () => { if (stagedCount > 0) setAsked('back'); else onBack() }

    if (forkRoot) {
        const root = forkRoot
        return (
            <div className="space-y-5">
                {health}
                <Notice icon={GitFork}>
                    <p className="font-semibold text-ink">This graph is a fork, so it has no settings of its own.</p>
                    <p>
                        It follows the settings of {rootName ? <span className="font-semibold text-ink">{rootName}</span> : 'the graph it was forked from'}
                        {rootName ? ', the graph it was forked from' : ''}. To change them, change that graph’s.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                        <Button size="sm" variant="primary" rightIcon={ArrowUpRight} onClick={() => onOpenRoot(root.graphId, rootName)}
                            className="bg-indigo-600 hover:bg-indigo-700 hover:brightness-100">
                            {rootName ? `Open ${rootName}’s settings` : 'Open the root graph’s settings'}
                        </Button>
                        {root.dataSourceId && (
                            <Link to={`/workspaces/${root.workspaceId ?? workspaceId}?ds=${encodeURIComponent(root.dataSourceId)}&dstab=versioning`}
                                className="inline-flex h-7 items-center rounded-lg px-2.5 text-xs font-semibold text-indigo-700 outline-none hover:bg-black/[0.04] hover:underline focus-visible:ring-2 focus-visible:ring-accent-lineage/40 dark:text-indigo-300 dark:hover:bg-white/[0.06]">
                                {rootName ? `Open ${rootName}’s data source` : 'Open the root’s data source'}
                            </Link>
                        )}
                    </div>
                </Notice>
            </div>
        )
    }
    if (error) {
        return (
            <div className="space-y-5">
                {health}
                <div role="alert" className="flex flex-wrap items-center gap-3 rounded-2xl border border-rose-500/25 bg-rose-500/[0.05] px-4 py-3">
                    <p className="min-w-0 flex-1 text-[13px] text-rose-700 dark:text-rose-300">Couldn’t read this graph’s settings: {error.message}</p>
                    <Button size="sm" leftIcon={RotateCw} onClick={() => void valuesQ.refetch()}>Try again</Button>
                </div>
            </div>
        )
    }
    if (schemaQ.error) {
        return (
            <div role="alert" className="flex flex-wrap items-center gap-3 rounded-2xl border border-rose-500/25 bg-rose-500/[0.05] px-4 py-3">
                <p className="min-w-0 flex-1 text-[13px] text-rose-700 dark:text-rose-300">Couldn’t read what each setting is: {settingsError(schemaQ.error).message}</p>
                <Button size="sm" leftIcon={RotateCw} onClick={() => void schemaQ.refetch()}>Try again</Button>
            </div>
        )
    }
    if (!schema || !valuesQ.data) {
        return (
            <div className="space-y-4" aria-busy="true" aria-label="Loading this graph’s settings">
                <Skeleton className="h-36 rounded-2xl" />
                {[0, 1, 2].map((i) => <Skeleton key={i} className="h-44 rounded-2xl" />)}
            </div>
        )
    }

    const categories = [...schema.categories].sort((a, b) => a.order - b.order)
    const present = schema.settings.filter((s) => values[s.key])
    const own = present.filter((s) => s.scopes.graph)
    const elsewhere = present.filter((s) => !s.scopes.graph)
    const inactive = elsewhere.filter((s) => values[s.key].status !== 'in_effect').length
    const changed = elsewhere.filter((s) => notDefault(values[s.key])).length
    // The profiles a graph can take; the picker stages only what this person may set here.
    const profiles = schema.profiles?.filter((p) => p.scopes.includes('graph'))

    return (
        <VisualContext.Provider value={visuals}>
            <div ref={bodyRef} className="space-y-6">
                {viewingRootOf && (
                    <Notice icon={GitFork}>
                        These are the settings of {viewingRootOf.root ? <>{viewingRootOf.root}, </> : ''}the graph {viewingRootOf.fork} was forked
                        from; {viewingRootOf.fork} follows them.{' '}
                        <button type="button" onClick={goBack}
                            className="inline-flex items-center gap-1 rounded font-semibold text-indigo-700 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent-lineage/40 dark:text-indigo-300">
                            <ArrowLeft aria-hidden className="w-3 h-3" /> Back to {viewingRootOf.fork}
                        </button>
                    </Notice>
                )}
                {health}
                {!versioningOn ? (
                    <Notice icon={Eye}>Version control is turned off for this deployment, so a graph’s settings can be read but not changed. An administrator can turn it on under Admin → Features.</Notice>
                ) : valuesQ.data.editor === null && (
                    <Notice icon={Eye}>You can read this graph’s settings and why each is what it is. A workspace admin can change them.</Notice>
                )}

                <LensSwitch />

                {!readOnly && (
                    <ProfileEntry variant="inline" profiles={profiles} scope="graph" editor={valuesQ.data.editor} resolved={values}
                        onStage={editor.stage} lens={lens} />
                )}
                {/* The compass opens in its own card; the button stays beside it, level with its header. */}
                <div className={cn('flex flex-wrap gap-3', compassOpen ? 'items-start' : 'items-center')}>
                    <div className="min-w-0 flex-1 basis-80">
                        <CompassSummary dimensions={schema.dimensions} settings={present} current={current} next={next}
                            inactive={inactiveKeys} open={compassOpen} onToggle={() => setCompassOpen((o) => !o)} />
                    </div>
                    {/* Finding what's behind a problem changes nothing: a viewer who may only read has it too. */}
                    <Button ref={finderButton} leftIcon={Stethoscope} aria-expanded={finderOpen}
                        onClick={() => (finderOpen ? closeFinder() : setFinderOpen(true))}
                        className={cn('shrink-0 border-glass-border/80', compassOpen && 'sm:mt-[13px]')}>
                        Something’s wrong?
                    </Button>
                </div>
                {finderOpen && (
                    <div ref={finderPanel}>
                        <SymptomFinder settings={present} values={values} staged={stagedMap} signals={signals} signalsUnavailable={signalsUnavailable}
                            onStage={readOnly ? undefined : (k: string, v: SettingValue) => editor.stage(k, v)} onShow={show} onClose={closeFinder} />
                    </div>
                )}

                {categories.map((c) => {
                    const rows = own.filter((s) => s.category === c.id)
                    if (!rows.length) return null
                    return (
                        <section key={c.id} aria-labelledby={`drawer-${c.id}`} className="space-y-3">
                            {/* The drawer's title is its h2's peer: a category heads its settings' h3s. */}
                            <h2 id={`drawer-${c.id}`} className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-secondary">{c.label}</h2>
                            {rows.map((s) => (
                                <RowItem
                                    key={s.key}
                                    setting={s}
                                    resolved={values[s.key]}
                                    scope="graph"
                                    lens={lens}
                                    staged={staged.isStaged(s.key) ? staged.valueAt(s.key) : undefined}
                                    error={editor.errors[s.key]}
                                    quick={editor.quick[s.key]}
                                    checking={editor.quickPending && staged.isStaged(s.key)}
                                    editLimits={false}
                                    stagedLimits={undefined}
                                    highlighted={shown === s.key}
                                    onStage={editor.stage}
                                    onUnstage={editor.unstage}
                                    onStageLimits={editor.stageLimits}
                                    onUnstageLimits={editor.unstageLimits}
                                    onFix={onFix}
                                    fixLabel={fixLabel}
                                    dimensions={schema.dimensions}
                                    glossary={schema.glossary}
                                />
                            ))}
                        </section>
                    )
                })}

                {elsewhere.length > 0 && (
                    <details className="group rounded-2xl border border-glass-border/50 bg-canvas-elevated">
                        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5 px-4 py-3 text-[13px] font-semibold text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 [&::-webkit-details-marker]:hidden">
                            <ChevronDown aria-hidden className="w-4 h-4 text-ink-secondary transition-transform group-open:rotate-180 motion-reduce:transition-none" />
                            Set for every graph ({elsewhere.length})
                            <span className="ml-auto text-xs font-normal text-ink-secondary">
                                Not settable for one graph
                                {` · ${changed === 0 ? 'all at their defaults' : `${changed} ${changed === 1 ? 'differs' : 'differ'} from the default`}`}
                                {inactive > 0 ? ` · ${inactive} not in effect here` : ''}
                            </span>
                        </summary>
                        <ul className="divide-y divide-glass-border/40 border-t border-glass-border/50">
                            {elsewhere.map((s) => {
                                const r = values[s.key]
                                const why = r.status !== 'in_effect' ? r.why[0]?.text : undefined
                                return (
                                    // A finder's "Show" comes here: focusable, never a tab stop.
                                    <li key={s.key} id={settingAnchor(s.key)} tabIndex={-1}
                                        className={cn('flex scroll-mt-24 flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-2.5 outline-none',
                                            'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-lineage/40',
                                            shown === s.key && 'bg-black/[0.03] dark:bg-white/[0.04]')}>
                                        <div className="min-w-0 flex-1 basis-56">
                                            <p className="text-[13px] text-ink">{s.label}</p>
                                            <p className="text-[11.5px] text-ink-secondary">{whereSet(s)}</p>
                                            {why && <p className="mt-0.5 text-[11.5px] leading-snug text-amber-800 dark:text-amber-300">{why}</p>}
                                        </div>
                                        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1.5">
                                            <span className="text-[13px] font-semibold text-ink">{formatValue(s, r.effective)}</span>
                                            <ScopeBadge scope={r.source} prefix={r.source === 'default' ? undefined : r.source === 'env' ? 'Set by' : 'From'} />
                                            {/* As on the settings page: a status only where the value isn't in effect. */}
                                            {r.status !== 'in_effect' && <StatusBadge status={r.status} />}
                                        </div>
                                    </li>
                                )
                            })}
                        </ul>
                    </details>
                )}

                {!readOnly && (
                    <StickySaveBar count={staged.dirtyCount} problems={editor.problems} saving={editor.review.saving}
                        onReview={() => editor.review.setOpen(true)} onDiscard={() => setAsked('discard')} />
                )}
                {staged.dirtyCount === 0 && <SavedBar saved={editor.saved} />}
            </div>
            <SettingsReview
                open={editor.review.open}
                onOpenChange={editor.review.setOpen}
                items={editor.review.items}
                where={label}
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
                open={leaving !== null && stagedCount > 0}
                onOpenChange={(o) => {
                    if (o) return
                    setAsked(null)
                    if (closeAsked) onCloseAnswered(false)
                }}
                tone="danger"
                confirmLabel={leaving === 'close' ? 'Discard and close' : leaving === 'back' ? 'Discard and go back' : 'Discard'}
                cancelLabel={leaving === 'discard' ? 'Cancel' : 'Keep editing'}
                title={`Discard ${stagedCount} ${stagedCount === 1 ? 'change' : 'changes'}?`}
                onConfirm={() => {
                    staged.reset()
                    setAsked(null)
                    if (leaving === 'close') onCloseAnswered(true)
                    else if (leaving === 'back') onBack()
                }}
            >
                {leaving === 'close' ? 'Closing the drawer drops your staged changes: they go back to the values in force. Nothing has been saved.'
                    : leaving === 'back' ? 'Going back drops your staged changes to this graph: they go back to the values in force. Nothing has been saved.'
                        : 'Your staged changes go back to the values in force. Nothing has been saved.'}
            </ConfirmDialog>
            <p className="sr-only" aria-live="polite">{editor.announcement}</p>
        </VisualContext.Provider>
    )
}

export function GraphSettingsDrawer({ workspaceId, graphId, open, onOpenChange, label, onStagedChange }: GraphSettingsDrawerProps) {
    // A fork's root, once asked for: kept with the graph it belongs to, so another graph starts on its own.
    const [root, setRoot] = useState<{ of: string; graphId: string; name: string | null } | null>(null)
    // What the body has staged, and a close asked for meanwhile: the body asks first.
    const [staged, setStaged] = useState(0)
    const [closeAsked, setCloseAsked] = useState(false)
    useEffect(() => { onStagedChange?.(staged) }, [staged, onStagedChange])
    const counted = useCallback((n: number) => {
        setStaged(n)
        // Nothing staged any more: no close is waiting on an answer.
        if (n === 0) setCloseAsked(false)
    }, [])
    const showingRoot = root?.of === graphId ? root : null
    const name = label ?? 'This graph'
    const rootLabel = showingRoot?.name ?? `the graph ${name} follows`
    return (
        <Drawer
            open={open}
            onOpenChange={onOpenChange}
            dismissible={staged === 0}
            onDismissAttempt={() => setCloseAsked(true)}
            eyebrow={showingRoot ? `Graph settings · followed by ${name}` : 'Graph settings'}
            title={showingRoot ? showingRoot.name ?? `The graph ${name} follows` : name}
            description="Values this graph doesn’t set come from its workspace, then the platform."
            size="xl"
        >
            <GraphSettingsBody
                key={showingRoot?.graphId ?? graphId}
                workspaceId={workspaceId}
                graphId={showingRoot?.graphId ?? graphId}
                open={open}
                label={showingRoot ? rootLabel : name}
                viewingRootOf={showingRoot ? { fork: name, root: showingRoot.name } : null}
                closeAsked={closeAsked}
                onCloseAnswered={(discard) => {
                    setCloseAsked(false)
                    if (discard) onOpenChange(false)
                }}
                onStaged={counted}
                onBack={() => setRoot(null)}
                onOpenRoot={(id, rootName) => setRoot({ of: graphId, graphId: id, name: rootName })}
            />
        </Drawer>
    )
}
