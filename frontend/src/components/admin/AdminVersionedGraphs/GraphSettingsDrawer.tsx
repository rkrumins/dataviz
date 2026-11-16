/**
 * GraphSettingsDrawer — one graph's settings, beside the page it was opened from (the inventory
 * here; a workspace's and a data source's pages later).
 *
 * At the top, how the graph is doing now. Then each setting a graph can have, with the value in
 * force and where it came from (Default → Platform → Workspace → Graph), why it differs from the
 * one chosen, and "Set for this graph" offering only the choices allowed here. The same save model
 * as everywhere: stage, review the impact, give a reason, save, undo.
 *
 *   a fork        has no settings of its own (it follows its root): it says so, and opens the root's
 *   not allowed   a setting only a system admin may change shows read-only, saying who may
 *   read-only     a viewer who may not change any, or while version control is off, reads them all
 *   settings a graph can't have (the platform's, a workspace's) are listed at the end, read-only
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ArrowUpRight, ChevronDown, Eye, GitFork, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/Dialog'
import { Drawer } from '@/components/ui/Drawer'
import { Skeleton } from '@/components/ui/Skeleton'
import {
    EDITOR_LABEL, FEATURE_NAMES, LensSwitch, ScopeBadge, StickySaveBar, describeFix, formatValue, useLens,
    type ResolvedValues, type Setting, type SettingsFacts, type WhyFix,
} from '@/components/settings'
import { isFeatureOn, useFeaturesStore } from '@/store/features'
import { settingsError, useSettingsSchema, useSettingsValues, type SettingsPlace } from '@/services/settingsService'
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
            <Icon aria-hidden className="mt-0.5 w-4 h-4 shrink-0 text-ink-muted" />
            <div className="min-w-0">{children}</div>
        </div>
    )
}

function GraphSettingsBody({ workspaceId, graphId, open, label, viewingRootOf, onBack, onOpenRoot }: {
    workspaceId: string
    graphId: string
    open: boolean
    label: string
    /** When showing a fork's root: the fork's name. */
    viewingRootOf: string | null
    onBack: () => void
    onOpenRoot: (graphId: string) => void
}) {
    const place: SettingsPlace = useMemo(() => ({ scope: 'graph', workspaceId, graphId }), [workspaceId, graphId])
    const dirty = useRef(false)
    const schemaQ = useSettingsSchema()
    const valuesQ = useSettingsValues(place, { staged: () => dirty.current, enabled: open })
    const versioningOn = useFeaturesStore((s) => isFeatureOn(s.values, 'versioningEnabled'))
    const [lens, setLens] = useLens()
    const [discarding, setDiscarding] = useState(false)
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
    const editor = useSettingsEditor({ place, values, settings: byKey, where: label, refetch: valuesQ.refetch })
    useEffect(() => { dirty.current = editor.staged.dirtyCount > 0 })
    const { staged, stage } = editor

    const fixLabel = useMemo(() => (fix: WhyFix) => describeFix(fix, { settings: byKey, featureNames: FEATURE_NAMES }), [byKey])
    const onFix = useMemo(() => (readOnly ? undefined : (fix: WhyFix) => { if (fix.setting) stage(fix.setting, fix.to) }), [readOnly, stage])
    const { current, next } = staged
    const visuals = useMemo(() => ({ settings: byKey, current, next, facts: NO_FACTS, stage }), [byKey, current, next, stage])

    const error = valuesQ.error ? settingsError(valuesQ.error) : null
    const health = <GraphHealthPanel workspaceId={workspaceId} graphId={graphId} enabled={open} signals={schema?.signals} />

    if (error?.type === 'follows_root' && error.root) {
        const root = error.root
        return (
            <div className="space-y-5">
                {health}
                <Notice icon={GitFork}>
                    <p className="font-semibold text-ink">This graph is a fork, so it has no settings of its own.</p>
                    <p>It follows the settings of the graph it was forked from. To change them, change that graph’s.</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                        <Button size="sm" variant="primary" rightIcon={ArrowUpRight} onClick={() => onOpenRoot(root.graphId)}>Open the root graph’s settings</Button>
                        {root.dataSourceId && (
                            <Link to={`/workspaces/${root.workspaceId ?? workspaceId}?ds=${encodeURIComponent(root.dataSourceId)}&dstab=versioning`}
                                className="inline-flex h-7 items-center rounded-lg px-2.5 text-xs font-semibold text-ink-muted outline-none hover:bg-black/[0.04] hover:text-ink focus-visible:ring-2 focus-visible:ring-accent-lineage/40 dark:hover:bg-white/[0.06]">
                                Open the root’s data source
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

    return (
        <VisualContext.Provider value={visuals}>
            <div className="space-y-6">
                {viewingRootOf && (
                    <Notice icon={GitFork}>
                        These are the settings of the graph {viewingRootOf} was forked from; {viewingRootOf} follows them.{' '}
                        <button type="button" onClick={onBack} className="inline-flex items-center gap-1 font-semibold text-accent-lineage hover:underline">
                            <ArrowLeft aria-hidden className="w-3 h-3" /> Back to {viewingRootOf}
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
                            <h3 id={`drawer-${c.id}`} className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">{c.label}</h3>
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
                        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-[13px] font-semibold text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40 [&::-webkit-details-marker]:hidden">
                            <ChevronDown aria-hidden className="w-4 h-4 text-ink-muted transition-transform group-open:rotate-180 motion-reduce:transition-none" />
                            Set for every graph ({elsewhere.length})
                            <span className="ml-auto text-xs font-normal text-ink-muted">In force here; not settable for one graph</span>
                        </summary>
                        <ul className="divide-y divide-glass-border/40 border-t border-glass-border/50">
                            {elsewhere.map((s) => {
                                const r = values[s.key]
                                return (
                                    <li key={s.key} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-2.5">
                                        <div className="min-w-0 flex-1 basis-56">
                                            <p className="text-[13px] text-ink">{s.label}</p>
                                            <p className="text-[11.5px] text-ink-muted">{whereSet(s)}</p>
                                        </div>
                                        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                                            <span className="text-[13px] font-semibold text-ink">{formatValue(s, r.effective)}</span>
                                            <ScopeBadge scope={r.source} prefix={r.source === 'default' ? undefined : r.source === 'env' ? 'Set by' : 'From'} />
                                        </div>
                                    </li>
                                )
                            })}
                        </ul>
                    </details>
                )}

                {!readOnly && (
                    <StickySaveBar count={staged.dirtyCount} problems={editor.problems} saving={editor.review.saving}
                        onReview={() => editor.review.setOpen(true)} onDiscard={() => setDiscarding(true)} />
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
                onSave={editor.review.save}
                saving={editor.review.saving}
                error={editor.review.error}
                onReapply={editor.review.reapply}
                round={editor.review.round}
            />
            <ConfirmDialog open={discarding} onOpenChange={setDiscarding} tone="danger" confirmLabel="Discard"
                title={`Discard ${staged.dirtyCount} ${staged.dirtyCount === 1 ? 'change' : 'changes'}?`}
                onConfirm={() => { staged.reset(); setDiscarding(false) }}>
                Your staged changes go back to the values in force. Nothing has been saved.
            </ConfirmDialog>
            <p className="sr-only" aria-live="polite">{editor.announcement}</p>
        </VisualContext.Provider>
    )
}

export function GraphSettingsDrawer({ workspaceId, graphId, open, onOpenChange, label }: GraphSettingsDrawerProps) {
    // A fork's root, once asked for: kept with the graph it belongs to, so another graph starts on its own.
    const [root, setRoot] = useState<{ of: string; graphId: string } | null>(null)
    const showingRoot = root?.of === graphId ? root.graphId : null
    const name = label ?? 'This graph'
    return (
        <Drawer
            open={open}
            onOpenChange={onOpenChange}
            eyebrow="Graph settings"
            title={showingRoot ? `The graph ${name} follows` : name}
            description="Values this graph doesn’t set come from its workspace, then the platform."
            size="xl"
        >
            <GraphSettingsBody
                key={showingRoot ?? graphId}
                workspaceId={workspaceId}
                graphId={showingRoot ?? graphId}
                open={open}
                label={showingRoot ? `the graph ${name} follows` : name}
                viewingRootOf={showingRoot ? name : null}
                onBack={() => setRoot(null)}
                onOpenRoot={(id) => setRoot({ of: graphId, graphId: id })}
            />
        </Drawer>
    )
}
