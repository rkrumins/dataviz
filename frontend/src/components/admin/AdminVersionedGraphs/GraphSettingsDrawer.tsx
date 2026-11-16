/**
 * GraphSettingsDrawer — one graph's settings, beside the page it was opened from: the fleet's
 * inventory, a workspace's graphs, or a data source's Versioning tab.
 *
 * At the top, how the graph is doing now. Then each setting a graph can have, with the value in
 * force and where it came from (Default → Platform → Workspace → Graph), why it differs from the
 * one chosen, and "Set for this graph" offering only the choices allowed here. The same save model
 * as everywhere: stage, review the impact, give a reason, save, undo — the save confirmed once,
 * in the drawer, where the keyboard is.
 *
 *   a fork        has no settings of its own (it follows its root): it says so, names the root (as
 *                 its health does), and opens the root's
 *   not allowed   a setting only a system admin may change shows read-only, saying who may
 *   read-only     a viewer who may not change any, or while version control is off, reads them all
 *   settings a graph can't have (the platform's, a workspace's) are listed at the end, read-only,
 *                 each with whether it is in effect here and why not
 *
 * Nothing staged is dropped without asking: Esc, the overlay, ✕ and "Back" ask "Discard N
 * changes?" first. While something is staged, nothing here is refreshed over it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ArrowUpRight, ChevronDown, Eye, GitFork, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/Dialog'
import { Drawer } from '@/components/ui/Drawer'
import { Skeleton } from '@/components/ui/Skeleton'
import {
    EDITOR_LABEL, FEATURE_NAMES, LensSwitch, ScopeBadge, StatusBadge, StickySaveBar, describeFix, formatValue, useLens,
    type ResolvedValues, type Setting, type SettingsFacts, type WhyFix,
} from '@/components/settings'
import { isFeatureOn, useFeaturesStore } from '@/store/features'
import { settingsError, useGraphHealth, useSettingsSchema, useSettingsValues, type SettingsPlace } from '@/services/settingsService'
import { GraphHealthPanel } from './GraphHealthPanel'
import { RowItem } from './SettingsRows'
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
    const [lens, setLens] = useLens()
    const [asked, setAsked] = useState<Leaving | null>(null)
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
    // A fork's root by its name: its health names the graph it reads through (the panel's own read).
    const forkHealth = useGraphHealth(workspaceId, graphId, open && forkRoot !== null)
    const rootName = forkHealth.data?.follows?.label ?? null

    const fixLabel = useMemo(() => (fix: WhyFix) => describeFix(fix, { settings: byKey, featureNames: FEATURE_NAMES }), [byKey])
    const onFix = useMemo(() => (readOnly ? undefined : (fix: WhyFix) => { if (fix.setting) stage(fix.setting, fix.to) }), [readOnly, stage])
    const { current, next } = staged
    const visuals = useMemo(() => ({ settings: byKey, current, next, facts: NO_FACTS, stage }), [byKey, current, next, stage])

    // Health isn't polled over staged values either: what the person decides against holds still.
    const health = <GraphHealthPanel workspaceId={workspaceId} graphId={graphId} enabled={open && stagedCount === 0} signals={schema?.signals} />
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
    const own = schema.settings.filter((s) => s.scopes.graph && values[s.key])
    const elsewhere = schema.settings.filter((s) => !s.scopes.graph && values[s.key])
    const inactive = elsewhere.filter((s) => values[s.key].status !== 'in_effect').length

    return (
        <VisualContext.Provider value={visuals}>
            <div className="space-y-6">
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

                <LensSwitch value={lens} onChange={setLens} />

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
                                    highlighted={false}
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
                                Not settable for one graph{inactive > 0 ? ` · ${inactive} not in effect here` : ''}
                            </span>
                        </summary>
                        <ul className="divide-y divide-glass-border/40 border-t border-glass-border/50">
                            {elsewhere.map((s) => {
                                const r = values[s.key]
                                const why = r.status !== 'in_effect' ? r.why[0]?.text : undefined
                                return (
                                    <li key={s.key} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-2.5">
                                        <div className="min-w-0 flex-1 basis-56">
                                            <p className="text-[13px] text-ink">{s.label}</p>
                                            <p className="text-[11.5px] text-ink-secondary">{whereSet(s)}</p>
                                            {why && <p className="mt-0.5 text-[11.5px] leading-snug text-amber-800 dark:text-amber-300">{why}</p>}
                                        </div>
                                        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1.5">
                                            <span className="text-[13px] font-semibold text-ink">{formatValue(s, r.effective)}</span>
                                            <ScopeBadge scope={r.source} prefix={r.source === 'default' ? undefined : r.source === 'env' ? 'Set by' : 'From'} />
                                            <StatusBadge status={r.status} />
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
