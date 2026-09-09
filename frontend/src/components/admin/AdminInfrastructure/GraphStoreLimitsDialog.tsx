/**
 * GraphStoreLimitsDialog — adjust one graph store node's own per-query
 * limits, TIMEOUT_MAX and QUERY_MEM_CAPACITY, at runtime.
 *
 * Both limits bound every rebuild and every canvas read, and until now both
 * lived only in the deployment: the per-query timeouts an operator sets are
 * silently capped at TIMEOUT_MAX, and a single row larger than
 * QUERY_MEM_CAPACITY is the one thing a rebuild cannot narrow its way past.
 * The store accepts GRAPH.CONFIG SET for both, so this dialog changes them
 * from Infrastructure — the node is read first, the change is checked here
 * and again on the server, set, read back, and logged with the actor — with
 * the deployment guide's container formula as the guard against the change
 * that turns a refused query into an OOM-killed node. A runtime change lasts
 * until the store restarts: the dialog hands over the FALKORDB_ARGS fragment
 * that makes it permanent.
 *
 * Built on the house dialog shell (the Defaults dialog's): a portal, a
 * sibling <Backdrop>, an inert full-viewport wrapper outside the presence
 * tree, a focus-trapped panel, a dirty guard, a notification on apply.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, ClipboardCopy, Loader2, RotateCcw, SlidersHorizontal, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePermission } from '@/store/auth'
import { useModalA11y } from '@/hooks/useModalA11y'
import { useAppNotifications } from '@/components/ui/notifications'
import { Backdrop } from '@/components/ui/Backdrop'
import { ConfirmDialog } from '@/components/admin/job-history/ConfirmDialog'
import { DocsLink } from '@/components/help/DocsLink'
import {
    aggregationService,
    type GraphStoreLimitsPatch, type GraphStoreLimitsResponse,
} from '@/services/aggregationService'
import { compactBytes } from '../shared/aggregationKnobs'
import { CAPACITY_KEYS, useFleetCapacity } from '../shared/useAggregationCapacity'
import {
    GIB, MIB, THREADS_ASSUMED, fmtS, planLimits, type LimitsDraft, type LimitsPlan,
} from './graphStoreLimits'

const INPUT = 'w-32 px-2.5 py-1.5 text-[13px] text-right tabular-nums rounded-lg border border-glass-border bg-transparent text-ink placeholder:text-ink-muted outline-none transition-colors duration-150 focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500/40 disabled:opacity-60 disabled:cursor-not-allowed'
const BTN_SECONDARY = 'px-5 py-2.5 rounded-xl text-sm font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50'

function storageKey(endpoint: string) {
    return `graphStoreLimits.container.${endpoint}`
}

function rememberedContainerGb(endpoint: string): string {
    try { return localStorage.getItem(storageKey(endpoint)) ?? '' } catch { return '' }
}

function rememberContainerGb(endpoint: string, gb: string) {
    try { localStorage.setItem(storageKey(endpoint), gb) } catch { /* private mode, blocked storage */ }
}

const EMPTY: LimitsDraft = { timeoutS: '', capMb: '', containerGb: '', concurrent: '', effectsUs: '', applyToAll: false }

function Field({ id, label, unit, help, value, disabled, min, step, onChange }: {
    id: string
    label: string
    unit: string
    help: React.ReactNode
    value: string
    disabled: boolean
    min?: number
    step?: number
    onChange: (raw: string) => void
}) {
    return (
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
            <div className="min-w-0 flex-1">
                <label htmlFor={id} className="text-[13px] text-ink-secondary leading-snug cursor-pointer">{label}</label>
                <p className="mt-0.5 text-[11px] text-ink-muted leading-snug">{help}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0 ml-auto">
                <input
                    id={id}
                    type="number"
                    inputMode="decimal"
                    min={min}
                    step={step ?? 1}
                    disabled={disabled}
                    value={value}
                    onChange={e => onChange(e.target.value)}
                    className={INPUT}
                />
                <span className="w-8 text-[11px] text-ink-muted">{unit}</span>
            </div>
        </div>
    )
}

function Fragment({ fragment, onCopy }: { fragment: string; onCopy: (text: string) => void }) {
    return (
        <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.03] p-3 space-y-1.5">
            <p className="text-[11px] font-semibold text-ink-secondary">Applies now, until the next restart of the graph store.</p>
            <p className="text-[11px] text-ink-muted">
                Make it permanent by adding this to the store’s <code className="font-mono">FALKORDB_ARGS</code>
                {' '}(and keep <code className="font-mono">FALKORDB_SERVER_TIMEOUT_MAX_MS</code> in step for a time cap, in case a node is ever read before its limits are):
            </p>
            <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 truncate rounded-lg bg-black/5 dark:bg-white/5 px-2 py-1 font-mono text-[11px] text-ink" data-testid="limits-args-fragment">{fragment}</code>
                <button
                    type="button"
                    onClick={() => onCopy(fragment)}
                    className="inline-flex items-center gap-1 rounded-lg border border-glass-border px-2 py-1 text-[11px] font-medium text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                >
                    <ClipboardCopy className="w-3 h-3" /> Copy
                </button>
            </div>
        </div>
    )
}

export function GraphStoreLimitsDialog({ open, endpoint, onClose }: {
    open: boolean
    endpoint: string | null
    onClose: () => void
}) {
    const qc = useQueryClient()
    const { notify } = useAppNotifications()
    const isAdmin = usePermission('system:admin')
    const capacityQ = useFleetCapacity(open)
    const shard = useMemo(
        () => capacityQ.data?.shards.find(s => s.endpoint === endpoint) ?? null,
        [capacityQ.data, endpoint],
    )
    const containerFromEnv = capacityQ.data?.limits.containerMemoryBytes ?? null
    const multiNode = (capacityQ.data?.shards.length ?? 0) > 1

    const [draft, setDraft] = useState<LimitsDraft>(EMPTY)
    const [seed, setSeed] = useState<string>(JSON.stringify(EMPTY))
    const [step, setStep] = useState<'edit' | 'confirm' | 'done'>('edit')
    const [applied, setApplied] = useState<{ response: GraphStoreLimitsResponse; changes: LimitsPlan['changes'] } | null>(null)
    const [confirmDiscard, setConfirmDiscard] = useState(false)
    const seededFor = useRef<string | null>(null)

    // Seed once per open from the node's reading; never re-seed under the
    // operator's hands when the capacity poll lands.
    useEffect(() => {
        if (!open || !endpoint) { seededFor.current = null; return }
        if (!shard || seededFor.current === endpoint) return
        seededFor.current = endpoint
        const initial: LimitsDraft = {
            timeoutS: shard.timeoutMaxMs != null ? fmtS(shard.timeoutMaxMs) : '',
            capMb: shard.queryMemCapacity != null ? String(Math.round(shard.queryMemCapacity / MIB)) : '',
            containerGb: containerFromEnv != null
                ? String(Math.round(containerFromEnv / GIB * 100) / 100)
                : rememberedContainerGb(endpoint),
            concurrent: String(shard.threadCount ?? THREADS_ASSUMED),
            effectsUs: shard.effectsThresholdUs != null ? String(shard.effectsThresholdUs) : '',
            applyToAll: false,
        }
        setDraft(initial)
        setSeed(JSON.stringify(initial))
        setStep('edit')
        setApplied(null)
    }, [open, endpoint, shard, containerFromEnv])

    const plan = useMemo(() => planLimits(shard, draft), [shard, draft])
    const dirty = step !== 'done' && JSON.stringify(draft) !== seed

    // Ref-stable close callback: the a11y hook re-focuses the panel whenever
    // its callback changes identity, and ``dirty`` changes on every keystroke.
    // The ref is updated after each render (an effect), never during it.
    const requestCloseRef = useRef<() => void>(() => onClose())
    useEffect(() => {
        requestCloseRef.current = () => {
            if (dirty && isAdmin) setConfirmDiscard(true)
            else onClose()
        }
    })
    const requestClose = useCallback(() => requestCloseRef.current(), [])
    const dialogRef = useModalA11y(open && !confirmDiscard, requestClose)

    const apply = useMutation<GraphStoreLimitsResponse, Error, GraphStoreLimitsPatch>({
        mutationFn: (patch) => aggregationService.setGraphStoreLimits(endpoint ?? '', patch),
        onSuccess: (res) => {
            if (endpoint && draft.containerGb.trim()) rememberContainerGb(endpoint, draft.containerGb.trim())
            setApplied({ response: res, changes: plan.changes })
            setSeed(JSON.stringify(draft))
            setStep('done')
            void qc.invalidateQueries({ queryKey: CAPACITY_KEYS.fleet })
            void qc.invalidateQueries({ queryKey: ['aggregation', 'capacity', 'source'] })
            notify('success', `Graph store limits applied on ${res.appliedTo.join(', ')} — until the next restart.`)
        },
        onError: (e) => notify('error', e.message || 'The graph store limits could not be changed.'),
    })

    const copy = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text)
            notify('success', 'Copied to the clipboard.')
        } catch {
            notify('error', 'Could not copy — select the text and copy it by hand.')
        }
    }

    const set = (key: keyof LimitsDraft) => (raw: string) => setDraft(prev => ({ ...prev, [key]: raw }))
    const editable = isAdmin && step === 'edit' && !apply.isPending
    const ready = !!capacityQ.data

    const readout = (() => {
        if (!shard) return null
        const maxmemory = shard.maxmemory ?? 0
        if (plan.resultingCap == null) {
            return <p className="text-[11px] text-ink-muted">No per-query memory ceiling is set on this node (unlimited): one query may take whatever the container has. Set a ceiling to bound it.</p>
        }
        if (maxmemory <= 0) {
            return <p className="text-[11px] text-ink-muted">The node reports no maxmemory, so the container formula cannot be applied here.</p>
        }
        const formula = `1.25 × ${compactBytes(maxmemory)} maxmemory + ${plan.concurrent} × 1.3 × ${compactBytes(plan.resultingCap)} + overhead`
        const verdict = plan.container == null
            ? (plan.raising ? 'enter the container limit to compare' : 'container limit not entered')
            : plan.needed != null && plan.needed > plan.container
                ? `the container has ${compactBytes(plan.container)} — short by ${compactBytes(plan.needed - plan.container)}`
                : `the container has ${compactBytes(plan.container)} — fits`
        const ok = plan.container != null && plan.needed != null && plan.needed <= plan.container
        return (
            <p className={cn('text-[11px] tabular-nums', ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-ink-secondary')} data-testid="limits-readout">
                Needs at least <strong>{compactBytes(plan.needed)}</strong> of container memory ({formula}
                {plan.threadsAssumed ? '; THREAD_COUNT not reported, 4 assumed' : `; the node runs ${plan.threads} thread${plan.threads === 1 ? '' : 's'}`}); {verdict}.
            </p>
        )
    })()

    return createPortal(
        <>
            <Backdrop open={open} onClick={requestClose} zClassName="z-[60]" className="bg-black/50" />
            <div className="fixed inset-0 z-[61] flex items-start sm:items-center justify-center p-3 sm:p-4 pointer-events-none">
                <AnimatePresence>
                    {open && (
                        <motion.div
                            ref={dialogRef}
                            tabIndex={-1}
                            role="dialog"
                            aria-modal="true"
                            aria-labelledby="graph-store-limits-title"
                            initial={{ scale: 0.95, opacity: 0, y: 20 }}
                            animate={{ scale: 1, opacity: 1, y: 0 }}
                            exit={{ scale: 0.95, opacity: 0, y: 20 }}
                            transition={{ duration: 0.12 }}
                            className="pointer-events-auto outline-none w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl border border-glass-border bg-canvas-elevated shadow-lg overflow-hidden"
                        >
                            <header className="flex items-center justify-between gap-4 px-6 sm:px-8 py-5 border-b border-glass-border bg-gradient-to-r from-black/[0.02] to-transparent dark:from-white/[0.02] shrink-0">
                                <div className="flex items-center gap-4 min-w-0">
                                    <div className="w-12 h-12 shrink-0 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white shadow-md">
                                        <SlidersHorizontal className="w-6 h-6" />
                                    </div>
                                    <div className="min-w-0">
                                        <h2 id="graph-store-limits-title" className="text-xl font-bold text-ink">Graph store limits</h2>
                                        <p className="text-sm text-ink-muted">
                                            <span className="font-mono">{endpoint}</span> · the per-query limits every rebuild and canvas read is bounded by.{' '}
                                            <DocsLink slug="rollup-capacity" variant="inline" label="How they are sized" />
                                        </p>
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={requestClose}
                                    aria-label="Close graph store limits"
                                    className="p-2 shrink-0 rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                                >
                                    <X className="w-5 h-5 text-ink-muted" />
                                </button>
                            </header>

                            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-6 sm:px-8 py-5">
                                {!ready ? (
                                    <div className="flex items-center justify-center py-12 text-ink-muted">
                                        {capacityQ.isError
                                            ? <p className="text-sm">The graph store could not be measured right now.</p>
                                            : <Loader2 className="w-5 h-5 animate-spin" />}
                                    </div>
                                ) : !shard ? (
                                    <p className="text-sm text-ink-secondary">
                                        This node is not in the capacity sweep — only a node that holds a graph with rollups can be adjusted here, through the provider that writes to it.
                                    </p>
                                ) : (
                                    <div className="space-y-5">
                                        <p className="text-[11px] text-ink-muted tabular-nums" data-testid="limits-now">
                                            Now on this node: TIMEOUT_MAX {shard.timeoutMaxMs != null ? `${fmtS(shard.timeoutMaxMs)} s` : 'no cap'}
                                            {shard.timeoutDefaultMs != null && ` · TIMEOUT_DEFAULT ${fmtS(shard.timeoutDefaultMs)} s`}
                                            {' '}· QUERY_MEM_CAPACITY {shard.queryMemCapacity != null ? compactBytes(shard.queryMemCapacity) : 'unlimited'}
                                            {' '}· THREAD_COUNT {shard.threadCount ?? 'not reported'}
                                            {' '}· maxmemory {compactBytes(shard.maxmemory)}{shard.usedPct != null && ` (${Math.round(shard.usedPct)}% used)`}
                                        </p>

                                        {step === 'edit' && (
                                            <>
                                                <section>
                                                    <h3 className="text-[11px] font-bold uppercase tracking-[0.13em] text-ink-muted">Per-query limits</h3>
                                                    <div className="mt-2 border-t border-glass-border divide-y divide-glass-border">
                                                        <Field
                                                            id="limits-timeout" label="Query time cap (TIMEOUT_MAX)" unit="s"
                                                            help={<>Every scan and write timeout is capped here; a rebuild’s per-query timeouts can then go up to it. 1–3,600 s, never below the node’s TIMEOUT_DEFAULT{shard.timeoutDefaultMs != null && ` (${fmtS(shard.timeoutDefaultMs)} s)`}.</>}
                                                            value={draft.timeoutS} disabled={!editable} min={1} step={1} onChange={set('timeoutS')}
                                                        />
                                                        <Field
                                                            id="limits-cap" label="Per-query memory ceiling (QUERY_MEM_CAPACITY)" unit="MB"
                                                            help="What one query may hold at once, per thread. The rebuild narrows its scans to fit under it; a single row larger than it is the one thing it cannot narrow past. Raising it needs the container limit below."
                                                            value={draft.capMb} disabled={!editable} min={1} step={1} onChange={set('capMb')}
                                                        />
                                                    </div>
                                                </section>
                                                <section>
                                                    <h3 className="text-[11px] font-bold uppercase tracking-[0.13em] text-ink-muted">Replication</h3>
                                                    <p className="mt-1 text-[12px] text-ink-muted leading-snug">
                                                        Below this threshold the store replicates a write by having every replica <em>re-run</em> it, on the replica’s main thread and with no timeout. A rollup batch is thousands of small writes, so it falls below the 300 µs default and each replica repeats the whole rebuild — which is what leaves a replica unable to answer its health check. 0 always ships a compact change log instead.
                                                    </p>
                                                    <div className="mt-2 border-t border-glass-border divide-y divide-glass-border">
                                                        <Field
                                                            id="limits-effects" label="Effects threshold (EFFECTS_THRESHOLD)" unit="µs"
                                                            help={<>Microseconds per modification. Leave it at 0 on any node with replicas.{shard.effectsThresholdUs != null && shard.effectsThresholdUs > 0 && ' This node re-runs writes on its replicas today.'}</>}
                                                            value={draft.effectsUs ?? ''} disabled={!editable} min={0} step={50} onChange={set('effectsUs')}
                                                        />
                                                    </div>
                                                </section>
                                                <section>
                                                    <h3 className="text-[11px] font-bold uppercase tracking-[0.13em] text-ink-muted">Sizing</h3>
                                                    <p className="mt-1 text-[12px] text-ink-muted leading-snug">
                                                        A ceiling the container cannot back turns a refused query into an OOM-killed node, so raising it is checked against the deployment guide’s rule first.
                                                    </p>
                                                    <div className="mt-2 border-t border-glass-border divide-y divide-glass-border">
                                                        <Field
                                                            id="limits-container" label="Container memory limit" unit="GB"
                                                            help={<>The graph store container’s memory limit — the application cannot read it. {containerFromEnv != null ? 'Prefilled from the deployment (FALKORDB_CONTAINER_MEMORY_BYTES).' : draft.containerGb ? 'Remembered from your last change here.' : 'Needed to raise the ceiling; remembered for this node afterwards.'}</>}
                                                            value={draft.containerGb} disabled={!editable} min={0.25} step={0.25} onChange={set('containerGb')}
                                                        />
                                                        <Field
                                                            id="limits-concurrent" label="Concurrent queries at the ceiling" unit="" 
                                                            help={<>The formula’s planning figure: how many queries may hold the ceiling at once — at most the node’s THREAD_COUNT ({plan.threads}{plan.threadsAssumed ? ', assumed' : ''}). The deployment guide plans for 2 when the rebuild is the only heavy reader; use the thread count when interactive traffic runs against a materializing node.</>}
                                                            value={draft.concurrent} disabled={!editable} min={1} step={1} onChange={set('concurrent')}
                                                        />
                                                    </div>
                                                    <div className="mt-3 rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.03] p-3 space-y-1.5">
                                                        {readout}
                                                    </div>
                                                    {multiNode && (
                                                        <label className="mt-3 flex items-start gap-2 text-[12px] text-ink-secondary cursor-pointer">
                                                            <input
                                                                type="checkbox"
                                                                checked={draft.applyToAll}
                                                                disabled={!editable}
                                                                onChange={e => setDraft(prev => ({ ...prev, applyToAll: e.target.checked }))}
                                                                className="mt-0.5"
                                                            />
                                                            <span>Apply the same limits on every primary node, not only this one.</span>
                                                        </label>
                                                    )}
                                                </section>
                                                {plan.problems.length > 0 && (
                                                    <ul className="space-y-1" data-testid="limits-problems">
                                                        {plan.problems.map(p => (
                                                            <li key={p} className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                                                                <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" /> {p}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )}
                                            </>
                                        )}

                                        {step === 'confirm' && (
                                            <>
                                                <section>
                                                    <h3 className="text-[11px] font-bold uppercase tracking-[0.13em] text-ink-muted">What changes</h3>
                                                    <ul className="mt-2 space-y-1" data-testid="limits-changes">
                                                        {plan.changes.map(c => (
                                                            <li key={c.name} className="text-[12px] text-ink tabular-nums">
                                                                <span className="font-mono">{c.name}</span>: {c.from} → <strong>{c.to}</strong>
                                                            </li>
                                                        ))}
                                                        {draft.applyToAll && <li className="text-[12px] text-ink-secondary">On every primary node.</li>}
                                                    </ul>
                                                    <p className="mt-2 text-[11px] text-ink-muted">
                                                        New queries are bounded by the new limits immediately; queries already running keep the limits they started with. The change is read back from the node and logged with your name.
                                                    </p>
                                                </section>
                                                {readout && <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.03] p-3">{readout}</div>}
                                                <Fragment fragment={plan.fragment} onCopy={copy} />
                                                {apply.isError && (
                                                    <p className="flex items-start gap-1.5 text-[11px] text-red-600 dark:text-red-400" data-testid="limits-error">
                                                        <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" /> {apply.error.message}
                                                    </p>
                                                )}
                                            </>
                                        )}

                                        {step === 'done' && applied && (
                                            <>
                                                <p className="flex items-start gap-2 text-[13px] text-ink" data-testid="limits-done">
                                                    <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-500" />
                                                    <span>
                                                        Applied on {applied.response.appliedTo.join(', ')}: {applied.changes.map(c => `${c.name} ${c.from} → ${c.to}`).join('; ')}.
                                                        {applied.response.threadCountAssumed && ' The node did not report its THREAD_COUNT; 4 was assumed for the sizing check.'}
                                                    </span>
                                                </p>
                                                <Fragment fragment={applied.response.argsFragment} onCopy={copy} />
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>

                            {ready && (
                                <footer className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 px-6 sm:px-8 py-5 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02] shrink-0">
                                    {!isAdmin ? (
                                        <>
                                            <p className="mr-auto text-[12px] text-ink-muted">Only platform admins can change the graph store’s limits.</p>
                                            <button type="button" onClick={onClose} className={BTN_SECONDARY}>Close</button>
                                        </>
                                    ) : step === 'edit' ? (
                                        <>
                                            <p className="mr-auto text-[12px] text-ink-muted">Checked here, then again on the node before anything is set.</p>
                                            <button type="button" onClick={requestClose} className={BTN_SECONDARY}>Cancel</button>
                                            <button
                                                type="button"
                                                onClick={() => setStep('confirm')}
                                                disabled={!shard || plan.patch == null}
                                                className={cn(
                                                    'flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-medium transition-colors duration-150',
                                                    'outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                                                    !shard || plan.patch == null
                                                        ? 'bg-black/5 dark:bg-white/5 text-ink-muted cursor-not-allowed'
                                                        : 'bg-gradient-to-r from-indigo-500 to-violet-600 text-white hover:brightness-110 shadow-md',
                                                )}
                                            >
                                                Review change
                                            </button>
                                        </>
                                    ) : step === 'confirm' ? (
                                        <>
                                            <button type="button" onClick={() => { apply.reset(); setStep('edit') }} disabled={apply.isPending} className={BTN_SECONDARY}>Back</button>
                                            <button
                                                type="button"
                                                onClick={() => plan.patch && apply.mutate(plan.patch)}
                                                disabled={apply.isPending || plan.patch == null}
                                                className={cn(
                                                    'flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-medium transition-colors duration-150',
                                                    'outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                                                    apply.isPending
                                                        ? 'bg-black/5 dark:bg-white/5 text-ink-muted cursor-not-allowed'
                                                        : 'bg-gradient-to-r from-indigo-500 to-violet-600 text-white hover:brightness-110 shadow-md',
                                                )}
                                            >
                                                {apply.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                                                Apply now
                                            </button>
                                        </>
                                    ) : (
                                        <button type="button" onClick={onClose} className={cn(BTN_SECONDARY, 'bg-gradient-to-r from-indigo-500 to-violet-600 text-white hover:brightness-110 shadow-md')}>Done</button>
                                    )}
                                </footer>
                            )}
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            <ConfirmDialog
                open={confirmDiscard}
                title="Discard this limits change?"
                message="Nothing has been applied to the graph store. Your edits will be lost if you close now."
                confirmLabel="Discard"
                confirmIcon={RotateCcw}
                onCancel={() => setConfirmDiscard(false)}
                onConfirm={() => { setConfirmDiscard(false); onClose() }}
            />
        </>,
        document.body,
    )
}

export default GraphStoreLimitsDialog
